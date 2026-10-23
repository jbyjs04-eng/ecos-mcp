// 정책브리핑 정책뉴스 MCP: POST /api/policy?data_key=공공데이터포털_인증키
const { createHandler, ToolError, norm } = require("../lib/core");

const URL_ = "https://apis.data.go.kr/1371000/policyNewsService2/policyNewsList2";
const LABEL = "15095335 정책브리핑 정책뉴스";
const WINDOW = 3; // 정책브리핑 API는 1회 조회 기간이 짧아(최대 3일) 나눠서 조회
const PRESET = {
  realestate: ["부동산", "주택", "아파트", "분양", "청약", "전세", "월세", "임대", "재건축", "재개발", "정비사업", "공급", "LTV", "DSR", "주택담보", "가계대출", "가계부채",
    "규제지역", "투기과열", "조정대상", "토지거래허가", "PF", "공시가격", "종부세", "종합부동산", "양도세", "양도소득", "취득세", "보유세", "리츠", "부동산투자회사", "택지", "신도시"],
  finance: ["가계대출", "가계부채", "DSR", "LTV", "PF", "금리", "유동화", "회사채", "단기자금", "건전성", "은행"],
  tax: ["세법", "세제", "법인세", "부가가치세", "양도소득세", "종합부동산세", "취득세", "상속세", "증여세", "조세특례"],
};
const MINISTRY_PRESET = { realestate: ["국토교통부", "금융위원회", "재정경제부", "기획재정부", "국세청", "행정안전부", "금융감독원"] };

const TOOLS = [
  {
    name: "policy_news",
    description:
      "정책브리핑(korea.kr)의 정부 정책뉴스·보도자료를 기간·키워드·부처로 걸러 날짜순 목록으로 돌려준다. preset='realestate'면 주택·대출규제·세제·정비사업 등 부동산 키워드를, " +
      "'finance'는 가계대출·PF·금리, 'tax'는 세법·세제 키워드를 쓴다. 보고서의 '부동산 정책 동향'·대책 연혁 표 갱신용. 기간은 최대 180일.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "시작일 YYYYMMDD(기본 30일 전)" },
        to: { type: "string", description: "종료일 YYYYMMDD(기본 오늘)" },
        preset: { type: "string", enum: ["realestate", "finance", "tax", "none"], description: "키워드 묶음(기본 realestate)" },
        keywords: { type: "array", items: { type: "string" }, description: "추가 키워드(제목·부제 부분일치, 하나라도 맞으면 포함)" },
        ministries: { type: "array", items: { type: "string" }, description: "부처 필터(예: 국토교통부, 금융위원회). 생략 시 preset 기본 부처, preset=none이면 전체" },
        brief_only: { type: "boolean", description: "보도자료(brief)만(기본 false)" },
        with_summary: { type: "boolean", description: "본문 앞부분 요약 포함(기본 true)" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "최대 건수(기본 60)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "policy_article",
    description: "policy_news 결과의 기사ID와 날짜로 정책뉴스·보도자료 본문 전체(텍스트)를 가져온다. 대책의 세부 내용(LTV 비율, 지정 지역, 시행일 등) 확인용.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "기사ID(NewsItemId)" },
        date: { type: "string", description: "게시일 YYYYMMDD(목록의 날짜)" },
        max_chars: { type: "integer", minimum: 500, maximum: 20000, description: "본문 최대 글자수(기본 8000)" },
      },
      required: ["id", "date"],
      additionalProperties: false,
    },
  },
];

function normKey(key) {
  key = String(key).trim().replace(/ /g, "+");
  try { return /%[0-9A-Fa-f]{2}/.test(key) ? decodeURIComponent(key) : key; } catch { return key; }
}
const digits = s => String(s || "").replace(/\D/g, "");
const kst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
const toDate = ymd => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
const ymdOf = d => d.toISOString().slice(0, 10).replace(/-/g, "");
const addD = (ymd, n) => { const d = toDate(ymd); d.setUTCDate(d.getUTCDate() + n); return ymdOf(d); };
const fmtD = ymd => `${ymd.slice(0, 4)}.${ymd.slice(4, 6)}.${ymd.slice(6, 8)}`;
// ApproveDate: MM/DD/YYYY HH24:MI:SS → YYYYMMDD
const apDate = s => { const m = String(s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}${m[1]}${m[2]}` : digits(s).slice(0, 8); };
const unesc = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const strip = html => unesc(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&[a-z]+;/gi, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

const clean = s => strip(s).replace(/\s+/g, " ").trim(); // 제목·부제의 <br>, &middot; 등 정리

function parse(xml) {
  const items = [];
  for (const m of xml.matchAll(/<NewsItem>([\s\S]*?)<\/NewsItem>/g)) {
    const o = {};
    for (const f of m[1].matchAll(/<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g)) o[f[1]] = /^(Title|SubTitle\d)$/.test(f[1]) ? clean(f[2]) : unesc(f[2]).trim();
    items.push(o);
  }
  return items;
}

async function fetchWindow(from, to, key) {
  const url = `${URL_}?serviceKey=${encodeURIComponent(normKey(key))}&startDate=${from}&endDate=${to}`;
  let res;
  try { res = await fetch(url, { headers: { Accept: "application/xml" } }); }
  catch (e) { throw new ToolError(`정책브리핑 API 접속 실패: ${e.message}`); }
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || /SERVICE_KEY_IS_NOT_REGISTERED|SERVICE_ACCESS_DENIED|Unauthorized|등록되지 않은/i.test(text)) {
    throw new ToolError(`인증 실패: 공공데이터포털 '${LABEL}' 활용신청이 안 됐거나 승인 직후(1~2시간)입니다. https://www.data.go.kr/data/15095335/openapi.do`);
  }
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/i.test(text)) throw new ToolError("정책브리핑 API 일일 호출 한도 초과.");
  const code = (text.match(/<resultCode>([^<]*)<\/resultCode>/) || [])[1];
  if (code && !/^0+$/.test(code)) {
    if (code === "03" || /NODATA/i.test(text)) return [];
    const msg = (text.match(/<resultMsg>([^<]*)<\/resultMsg>/) || [])[1] || "";
    throw new ToolError(`정책브리핑 API 오류 ${code} ${msg} (기간 ${from}~${to})`);
  }
  return parse(text);
}

async function fetchRange(from, to, key) {
  const wins = [];
  for (let s = from; s <= to; s = addD(s, WINDOW)) { const e = addD(s, WINDOW - 1); wins.push([s, e > to ? to : e]); }
  const out = [];
  for (let i = 0; i < wins.length; i += 8) {
    const part = await Promise.all(wins.slice(i, i + 8).map(([s, e]) => fetchWindow(s, e, key)));
    part.forEach(p => out.push(...p));
  }
  const seen = new Map();
  for (const it of out) { const k = it.NewsItemId || it.Title; if (!seen.has(k) || +(it.ModifyId || 0) > +(seen.get(k).ModifyId || 0)) seen.set(k, it); }
  return [...seen.values()];
}

async function run(name, args, key) {
  if (name === "policy_news") {
    const to = digits(args.to) || kst();
    const from = digits(args.from) || addD(to, -29);
    if (from.length !== 8 || to.length !== 8) throw new ToolError("날짜는 YYYYMMDD 형식이어야 합니다.");
    if ((toDate(to) - toDate(from)) / 864e5 > 180) throw new ToolError("조회 기간은 최대 180일입니다. 나눠서 조회하세요.");
    const preset = args.preset || "realestate";
    const kws = [...(preset === "none" ? [] : PRESET[preset] || []), ...(args.keywords || [])];
    const mins = args.ministries && args.ministries.length ? args.ministries : (preset === "none" ? [] : MINISTRY_PRESET[preset] || []);
    let rows = await fetchRange(from, to, key);
    const total = rows.length;
    if (args.brief_only) rows = rows.filter(r => /brief/i.test(r.GroupingCode || ""));
    if (mins.length) rows = rows.filter(r => mins.some(m => norm(r.MinisterCode).includes(norm(m))));
    if (kws.length) rows = rows.filter(r => { const t = norm(`${r.Title} ${r.SubTitle1} ${r.SubTitle2} ${r.SubTitle3}`); return kws.some(k => t.includes(norm(k))); });
    rows.sort((a, b) => apDate(b.ApproveDate).localeCompare(apDate(a.ApproveDate)));
    const lim = args.limit || 60;
    const sum = args.with_summary !== false;
    if (!rows.length) return `${fmtD(from)} ~ ${fmtD(to)} 조건에 맞는 정책뉴스가 없습니다(전체 ${total}건 중). 부처·키워드를 넓혀 보세요.`;
    const lines = rows.slice(0, lim).map(r => {
      const d = apDate(r.ApproveDate);
      const sub = [r.SubTitle1, r.SubTitle2, r.SubTitle3].filter(Boolean).join(" / ");
      const body = sum ? strip(r.DataContents).replace(/\s+/g, " ").slice(0, 220) : "";
      return [`- **${fmtD(d)}** [${r.MinisterCode || "-"}${/brief/i.test(r.GroupingCode || "") ? "·보도자료" : ""}] ${r.Title}`,
        sub ? `  - 부제: ${sub}` : "", body ? `  - 요지: ${body}…` : "",
        `  - ID ${r.NewsItemId} · ${r.OriginalUrl || ""}`].filter(Boolean).join("\n");
    });
    const byMin = rows.reduce((m, r) => (m[r.MinisterCode || "-"] = (m[r.MinisterCode || "-"] || 0) + 1, m), {});
    return [`## 정책 동향 ${rows.length}건 (${fmtD(from)} ~ ${fmtD(to)}, 전체 ${total}건 중)`,
      `부처별: ${Object.entries(byMin).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`, "",
      ...lines, rows.length > lim ? `\n(최근 ${lim}건만 표시 — limit·키워드로 조정)` : "",
      "", "출처: 대한민국 정책브리핑(korea.kr) 정책뉴스(공공데이터포털). 대책의 구체적 수치·시행일은 policy_article로 원문 확인 후 인용."].join("\n");
  }

  if (name === "policy_article") {
    const d = digits(args.date);
    if (d.length !== 8) throw new ToolError("date는 YYYYMMDD 형식이어야 합니다.");
    const rows = await fetchRange(addD(d, -1), addD(d, 1), key);
    const r = rows.find(x => String(x.NewsItemId) === String(args.id).trim());
    if (!r) return `${fmtD(d)} 전후에 기사ID ${args.id}가 없습니다. policy_news 결과의 날짜를 확인하세요.`;
    const text = strip(r.DataContents);
    const max = args.max_chars || 8000;
    return [`## ${r.Title}`, [r.SubTitle1, r.SubTitle2, r.SubTitle3].filter(Boolean).map(s => `- ${s}`).join("\n"),
      `${r.MinisterCode || "-"} · 승인 ${r.ApproveDate || "-"} · ${r.OriginalUrl || ""}`, "",
      text.slice(0, max), text.length > max ? `\n…(이하 ${text.length - max}자 생략 — max_chars로 조정)` : "",
      "", `출처: 대한민국 정책브리핑(korea.kr), 공공누리 ${r.KoglType || ""}`].filter(x => x !== "").join("\n");
  }

  throw new ToolError(`알 수 없는 도구: ${name}`);
}

module.exports = createHandler({
  serverInfo: { name: "policy-briefing-mcp", version: "1.0.0" },
  instructions:
    "정책브리핑 정책뉴스 조회 서버. 기간·키워드·부처별 정책 동향 목록은 policy_news(preset=realestate/finance/tax), 기사 본문은 policy_article(ID+날짜). " +
    "부동산 대책 연혁 표를 갱신할 때는 목록으로 후보를 찾고 본문에서 수치·시행일을 확인해 인용하며, 출처(정책브리핑)와 발표일을 표기한다.",
  tools: TOOLS,
  keyParam: "data_key",
  keyHeader: "X-Data-Key",
  envVar: "DATA_GO_KR_KEY",
  run,
});
module.exports._internal = { run, parse, fetchRange };
