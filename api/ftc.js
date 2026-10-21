// 공정거래위원회 기업집단포털 MCP: POST /api/ftc?data_key=공공데이터포털_인증키
const { createHandler, ToolError, norm } = require("../lib/core");

const BASE = "https://apis.data.go.kr/1130000";
// 서비스: [경로, 키 파라미터명, 공공데이터포털 번호]
const SVC = {
  ym: ["publicYmList/publicYmListApi", "ServiceKey", "15091910 사용 가능 공개년월"],
  groups: ["appnGroupSttusList/appnGroupSttusListApi", "ServiceKey", "15091886 지정된 대규모기업집단"],
  assets: ["appnGroupAssetsList/appnGroupAssetsListApi", "ServiceKey", "15091890 기업집단 자산순위"],
  affi: ["appnGroupAffiList/appnGroupAffiListApi", "ServiceKey", "15091891 소속회사"],
  overview: ["affiliationCompSttusList/affiliationCompSttusListApi", "ServiceKey", "15091894 소속회사 개요"],
  finance: ["financeCompSttusList/financeCompSttusListApi", "ServiceKey", "15091895 소속회사 재무현황"],
  holders: ["stockholderCompSttusList/stockholderCompSttusListApi", "ServiceKey", "15091900 소속회사 주주현황"],
  execs: ["executiveCompSttusList/executiveCompSttusListApi", "ServiceKey", "15091898 소속회사 임원현황"],
  changes: ["tyAssetsRentDelngDtlsList/tyAssetsRentDelngDtlsListApi", "serviceKey", "15093659 계열 편입/제외/유예 내역"],
  holdco: ["holdingGenFinCompSttusList/holdingGenFinCompSttusListApi", "ServiceKey", "15091905 지주회사 설립·전환 현황"],
  holdsub: ["holdingProgCompSttusList/holdingProgCompStusListApi", "serviceKey", "15091909 지주회사 자회사·손자회사"],
  inner: ["innerQotaEqltrmCmprList/innerQotaEqltrmCmprUnityListApi", "serviceKey", "15093666 내부지분(대동비교)"],
};

const TOOLS = [
  {
    name: "ftc_groups",
    description:
      "공정위 지정 대규모기업집단(상호출자제한·공시대상) 목록을 자산총액 순위와 함께 조회한다. 기업집단코드, 동일인, 대표회사, 계열회사 수, 자산총액(10억원). " +
      "name을 주면 해당 집단만. ym(YYYYMM) 생략 시 최신 지정월(매년 5월 1일 기준).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "기업집단명 부분일치(예: SK, 현대자동차)" },
        ym: { type: "string", description: "지정년월 YYYYMM(생략 시 최신)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ftc_group_companies",
    description:
      "기업집단 1곳의 소속회사 전체를 법인등록번호·사업자번호·대표자·설립일·계열편입일과 함께 조회한다. include로 업종·상시종업원(overview), 자산·부채·자본·매출·순이익(finance)을 붙일 수 있다. " +
      "인수 대상·인수자의 계열 범위, 기업결합 신고·특수관계자 검토에 사용.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "기업집단명(예: 카카오) 또는 기업집단코드(K로 시작)" },
        ym: { type: "string", description: "지정년월 YYYYMM(생략 시 최신)" },
        include: { type: "array", items: { type: "string", enum: ["overview", "finance"] }, description: "추가 항목(기본 overview·finance)" },
      },
      required: ["group"],
      additionalProperties: false,
    },
  },
  {
    name: "ftc_company",
    description:
      "회사 1곳이 대규모기업집단 소속인지 확인하고, 소속이면 개요·재무·주주현황(지분율)·임원(동일인과의 관계)을 조회한다. " +
      "법인등록번호(13자리)나 사업자등록번호(10자리)가 가장 정확하고, 회사명은 전체 소속회사 목록에서 부분일치로 찾는다.",
    inputSchema: {
      type: "object",
      properties: {
        jurirno: { type: "string", description: "법인등록번호 13자리" },
        bizrno: { type: "string", description: "사업자등록번호 10자리" },
        name: { type: "string", description: "회사명 부분일치(번호가 없을 때)" },
        ym: { type: "string", description: "지정년월 YYYYMM(생략 시 최신)" },
        include: { type: "array", items: { type: "string", enum: ["overview", "finance", "holders", "execs"] }, description: "가져올 항목(기본 전부)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ftc_affiliation_changes",
    description:
      "기업집단 계열회사 편입·제외·유예 변경내역(편입사유: 회사설립/지분취득, 제외사유: 흡수합병/지분매각/청산 등)을 기간·집단별로 조회한다. 인수·매각 거래의 계열 변동 확인용.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "기업집단명 또는 코드(생략 시 전체)" },
        from: { type: "string", description: "시작 YYYYMMDD(기본 1년 전)" },
        to: { type: "string", description: "종료 YYYYMMDD(기본 오늘)" },
        company: { type: "string", description: "회사명 부분일치 필터(선택)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ftc_holding",
    description:
      "공정거래법상 지주회사 현황(자산총액·부채비율·지주비율·자회사/손자회사/증손회사 수, 설립전환일)을 조회한다. jurirno(지주회사 법인등록번호)나 name을 주면 그 지주회사의 자회사·손자회사·증손회사와 지분율까지 보여준다.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "지주회사명 부분일치" },
        jurirno: { type: "string", description: "지주회사 법인등록번호" },
        ym: { type: "string", description: "공개년월 YYYYMM(생략 시 최신)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ftc_inner_equity",
    description:
      "기업집단의 연도별 내부지분율(동일인·특수관계인·계열회사·자기주식 지분 / 자본금)을 조회한다. 지배구조·동일인 지배력 검토용.",
    inputSchema: {
      type: "object",
      properties: { group: { type: "string", description: "기업집단명 또는 코드" } },
      required: ["group"],
      additionalProperties: false,
    },
  },
];

function normKey(key) {
  key = String(key).trim().replace(/ /g, "+");
  try { return /%[0-9A-Fa-f]{2}/.test(key) ? decodeURIComponent(key) : key; } catch { return key; }
}
const digits = s => String(s || "").replace(/\D/g, "");
const kstYmd = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
const num = v => { const n = parseFloat(String(v == null ? "" : v).replace(/[^\d.\-]/g, "")); return isFinite(n) ? n : null; };
const fmt = (n, d = 0) => n == null ? "-" : n.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtD = d => /^\d{8}$/.test(d || "") ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : (d || "-");
const unesc = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
const META = new Set(["resultCode", "resultMsg", "numOfRows", "pageNo", "totalCount", "header", "body"]);

// 평탄한 XML 응답을 레코드 배열로 변환(같은 필드가 다시 나오면 새 레코드)
function parseXml(xml) {
  const total = num((xml.match(/<totalCount>([^<]*)<\/totalCount>/) || [])[1]);
  const code = (xml.match(/<resultCode>([^<]*)<\/resultCode>/) || [])[1];
  const msg = (xml.match(/<resultMsg>([^<]*)<\/resultMsg>/) || [])[1];
  const rows = [];
  let cur = null;
  const re = /<([A-Za-z_][\w]*)>([^<]*(?:<!\[CDATA\[[\s\S]*?\]\]>[^<]*)?)<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, k, v] = m;
    if (META.has(k)) continue;
    if (!cur || k in cur) { cur = {}; rows.push(cur); }
    cur[k] = unesc(v);
  }
  // 자료가 없을 때 오는 빈 칸 행 제거
  return { rows: rows.filter(r => Object.values(r).some(v => v !== "")), total, code, msg };
}

async function call(svc, params, key, { page = 1, rows = 1000 } = {}) {
  const [path, keyName, label] = SVC[svc];
  const qs = [`${keyName}=${encodeURIComponent(normKey(key))}`, `pageNo=${page}`, `numOfRows=${rows}`];
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") qs.push(`${k}=${encodeURIComponent(v)}`);
  let res;
  try { res = await fetch(`${BASE}/${path}?${qs.join("&")}`, { headers: { Accept: "application/xml, application/json" } }); }
  catch (e) { throw new ToolError(`공정위 API 접속 실패(${label}): ${e.message}`); }
  const text = await res.text();
  const authFail = res.status === 401 || res.status === 403 || /SERVICE_KEY_IS_NOT_REGISTERED|SERVICE ACCESS DENIED|Unauthorized|SERVICE_ACCESS_DENIED|등록되지 않은/i.test(text);
  if (authFail) throw new ToolError(`인증 실패: 공공데이터포털 '${label}' API 활용신청이 안 됐거나 승인 직후(1~2시간)입니다. 신청 페이지: https://www.data.go.kr/data/${label.split(" ")[0]}/openapi.do`);
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/i.test(text)) throw new ToolError(`일일 호출 한도 초과(${label}). 내일 다시 시도하세요.`);
  let out;
  if (/^\s*[{[]/.test(text)) {
    let j; try { j = JSON.parse(text); } catch { throw new ToolError(`응답 해석 실패(${label}): ${text.slice(0, 200)}`); }
    const body = j.response?.body || j.body || j;
    let items = body.items?.item || body.items || body.item || [];
    if (!Array.isArray(items)) items = [items];
    out = { rows: items, total: num(body.totalCount), code: j.response?.header?.resultCode || j.resultCode, msg: j.response?.header?.resultMsg || j.resultMsg };
  } else {
    out = parseXml(text);
    if (!out.code && !out.rows.length && /<returnReasonCode>/.test(text)) {
      throw new ToolError(`공정위 API 오류(${label}): ${(text.match(/<returnAuthMsg>([^<]*)/) || [])[1] || (text.match(/<errMsg>([^<]*)/) || [])[1] || text.slice(0, 150)}`);
    }
  }
  if (out.code && !/^0+$/.test(out.code) && !/^(00|0000|INFO-000)$/.test(out.code)) {
    if (/03|NODATA|데이터 ?없/i.test(`${out.code}${out.msg}`)) return { rows: [], total: 0 };
    throw new ToolError(`공정위 API 오류(${label}): ${out.code} ${out.msg || ""}`);
  }
  return out;
}
async function callAll(svc, params, key, max = 5000) {
  const first = await call(svc, params, key, { page: 1, rows: 1000 });
  const rows = [...first.rows];
  const total = first.total || rows.length;
  for (let p = 2; rows.length < Math.min(total, max) && p <= 10; p++) {
    const r = await call(svc, params, key, { page: p, rows: 1000 });
    if (!r.rows.length) break;
    rows.push(...r.rows);
  }
  return rows;
}

// 최신 공개년월(지정 0001 / 지주 0003)
const ymCache = {};
async function latestYm(key, job = "0001") {
  if (ymCache[job]) return ymCache[job];
  let rows = [];
  try { rows = await callAll("ym", { jobSeCode: job }, key, 200); } catch (e) { rows = []; }
  const yms = rows.map(r => r.othbcYm).filter(v => /^\d{6}$/.test(v || "")).sort();
  if (yms.length) return (ymCache[job] = yms[yms.length - 1]);
  // 공개년월 API 미승인 시: 5월 이후면 당해 05, 아니면 전년 05
  const t = kstYmd();
  const y = +t.slice(4, 6) >= 5 ? +t.slice(0, 4) : +t.slice(0, 4) - 1;
  return job === "0001" ? `${y}05` : `${y}05`;
}
function ymOf(v) { const d = digits(v); if (d.length < 6) throw new ToolError(`년월은 YYYYMM 형식이어야 합니다: ${v}`); return d.slice(0, 6); }

async function resolveGroup(group, ym, key) {
  const g = String(group || "").trim();
  if (/^K\d{7}$/i.test(g)) {
    const rows = await callAll("groups", { presentnYear: ym }, key, 200).catch(() => []);
    const hit = rows.find(r => r.unityGrupCode === g.toUpperCase());
    return { code: g.toUpperCase(), name: hit ? hit.unityGrupNm : g, row: hit };
  }
  const rows = await callAll("groups", { presentnYear: ym }, key, 200);
  const exact = rows.find(r => norm(r.unityGrupNm) === norm(g));
  const part = rows.filter(r => norm(r.unityGrupNm).includes(norm(g)));
  const hit = exact || (part.length === 1 ? part[0] : null);
  if (!hit) {
    if (part.length) throw new ToolError(`'${g}'에 해당하는 기업집단이 여러 개입니다: ${part.map(r => `${r.unityGrupNm}(${r.unityGrupCode})`).join(", ")}`);
    throw new ToolError(`${ym} 지정 기업집단 중 '${g}'를 찾지 못했습니다. ftc_groups로 목록을 확인하세요.`);
  }
  return { code: hit.unityGrupCode, name: hit.unityGrupNm, row: hit };
}

const SRC = ym => `출처: 공정거래위원회 기업집단포털(공공데이터포털), 기준 ${ym ? `${ym.slice(0, 4)}.${ym.slice(4, 6)} 지정` : ""} · 조회일 ${kstYmd()}`;

async function run(name, args, key) {
  if (name === "ftc_groups") {
    const ym = args.ym ? ymOf(args.ym) : await latestYm(key);
    const [groups, assets] = await Promise.all([
      callAll("groups", { presentnYear: ym }, key, 300),
      callAll("assets", { presentnYear: ym }, key, 300).catch(() => []),
    ]);
    const am = new Map(assets.map(a => [a.unityGrupCode, a]));
    let list = groups.map(g => ({ ...g, rn: num((am.get(g.unityGrupCode) || {}).rn), asset: num((am.get(g.unityGrupCode) || {}).assetsTotamt) }));
    if (args.name) list = list.filter(g => norm(g.unityGrupNm).includes(norm(args.name)));
    list.sort((a, b) => (a.rn || 999) - (b.rn || 999));
    if (!list.length) return `${ym} 지정 기업집단 중 조건에 맞는 집단이 없습니다.`;
    return [`## 대규모기업집단 ${list.length}개 (${ym.slice(0, 4)}.${ym.slice(4)} 지정)`, "",
      "순위\t기업집단\t코드\t동일인\t대표회사\t계열사수\t자산총액(조원)\t구분\t공기업",
      ...list.map(g => [g.rn || "-", g.unityGrupNm, g.unityGrupCode, g.smerNm, g.repreCmpny, g.sumCmpnyCo, g.asset == null ? "-" : fmt(g.asset / 1000, 1), g.invstmntLmtt, g.entrprsCl].join("\t")),
      assets.length ? "" : "※ 자산순위 API(15091890) 미승인 또는 오류로 자산총액 생략",
      SRC(ym)].filter(x => x !== "").join("\n");
  }

  if (name === "ftc_group_companies") {
    const ym = args.ym ? ymOf(args.ym) : await latestYm(key);
    const g = await resolveGroup(args.group, ym, key);
    const inc = new Set(args.include && args.include.length ? args.include : ["overview", "finance"]);
    const p = { presentnYear: ym, unityGrupCode: g.code };
    const notes = [];
    const [affi, ov, fin] = await Promise.all([
      callAll("affi", p, key),
      inc.has("overview") ? callAll("overview", p, key).catch(e => (notes.push(e.message), [])) : [],
      inc.has("finance") ? callAll("finance", p, key).catch(e => (notes.push(e.message), [])) : [],
    ]);
    const ovm = new Map(ov.map(r => [r.jurirno || r.bizrno, r]));
    const fm = new Map(fin.map(r => [r.jurirno || r.bizrno, r]));
    const rows = affi.map(a => {
      const o = ovm.get(a.jurirno) || ovm.get(a.bizrno) || {};
      const f = fm.get(a.jurirno) || fm.get(a.bizrno) || {};
      return { a, o, f };
    }).sort((x, y) => (num(y.f.assetsTotamt) || 0) - (num(x.f.assetsTotamt) || 0));
    const head = ["회사명", "법인등록번호", "사업자번호", "대표자", "설립일", "계열편입일"];
    if (inc.has("overview")) head.push("업종", "상시종업원");
    if (inc.has("finance")) head.push("결산기일", "자산총액", "부채총액", "자본총액", "매출액", "당기순이익", "상장일");
    const lines = rows.map(({ a, o, f }) => {
      const c = [a.entrprsNm, a.jurirno, a.bizrno, a.rprsntvNm, fmtD(a.fondDe), fmtD(a.grinil)];
      if (inc.has("overview")) c.push(o.indutyNm || "-", fmt(num(o.ordtmEmplyCo)));
      if (inc.has("finance")) c.push(fmtD(f.stacntDudt), fmt(num(f.assetsTotamt)), fmt(num(f.debtTotamt)), fmt(num(f.caplTotamt)), fmt(num(f.selngAmount)), fmt(num(f.thstrmNtpfAmount)), fmtD(f.entrprsOthbcDe));
      return c.join("\t");
    });
    const gr = g.row || {};
    return [`## ${g.name}(${g.code}) 소속회사 ${affi.length}개 — ${ym.slice(0, 4)}.${ym.slice(4)} 지정`,
      gr.smerNm ? `동일인 ${gr.smerNm} · 대표회사 ${gr.repreCmpny} · ${gr.invstmntLmtt || ""}` : "", "",
      head.join("\t"), ...lines, "",
      inc.has("finance") ? "재무 금액 단위: 원(공정위 제출자료 기준). 자산총액 큰 순 정렬." : "",
      ...notes.map(n => "※ " + n), SRC(ym)].filter(x => x !== "").join("\n");
  }

  if (name === "ftc_company") {
    const ym = args.ym ? ymOf(args.ym) : await latestYm(key);
    const inc = new Set(args.include && args.include.length ? args.include : ["overview", "finance", "holders", "execs"]);
    let jur = digits(args.jurirno), biz = digits(args.bizrno), target = null;
    if (!jur && !biz && !args.name) throw new ToolError("jurirno, bizrno, name 중 하나는 필요합니다.");
    // 번호로 조회하면 API가 회사명·집단명을 비워 주므로 전체 소속회사 목록에서 먼저 찾는다
    const all = await callAll("affi", { presentnYear: ym }, key, 10000);
    if (jur || biz) {
      target = all.find(r => (jur && digits(r.jurirno) === jur) || (biz && digits(r.bizrno) === biz)) || null;
      if (!target) return `${jur ? `법인등록번호 ${jur}` : `사업자번호 ${biz}`}: ${ym.slice(0, 4)}.${ym.slice(4)} 지정 대규모기업집단 소속회사가 아닙니다(소속회사 ${all.length}개 대조). ${SRC(ym)}`;
      jur = digits(target.jurirno) || jur; biz = digits(target.bizrno) || biz;
    } else {
      const hits = all.filter(r => norm(r.entrprsNm).includes(norm(args.name)));
      if (!hits.length) return `${ym.slice(0, 4)}.${ym.slice(4)} 지정 대규모기업집단 소속회사 중 '${args.name}'이(가) 없습니다(비소속이거나 회사명이 다를 수 있음). ${SRC(ym)}`;
      const exact = hits.filter(r => norm(r.entrprsNm).replace(/\(주\)|주식회사/g, "") === norm(args.name).replace(/\(주\)|주식회사/g, ""));
      if (exact.length === 1) hits.splice(0, hits.length, exact[0]);
      if (hits.length > 1) {
        return [`'${args.name}' 부분일치 소속회사 ${hits.length}곳 — 법인등록번호로 다시 조회하세요.`, "", "회사명\t기업집단\t법인등록번호\t사업자번호",
          ...hits.slice(0, 50).map(r => `${r.entrprsNm}\t${r.unityGrupNm || "-"}\t${r.jurirno}\t${r.bizrno}`)].join("\n");
      }
      target = hits[0]; jur = digits(target.jurirno); biz = digits(target.bizrno);
    }
    const p = { presentnYear: ym, jurirno: jur || undefined, bizrno: jur ? undefined : biz || undefined };
    const notes = [];
    const safe = (svc, on) => on ? callAll(svc, p, key, 2000).catch(e => (notes.push(e.message), [])) : Promise.resolve([]);
    const [ov, fin, hold, ex] = await Promise.all([safe("overview", true), safe("finance", inc.has("finance")), safe("holders", inc.has("holders")), safe("execs", inc.has("execs"))]);
    const base = target || ov[0] || fin[0] || hold[0] || ex[0];
    if (!base) {
      return [`${jur ? `법인등록번호 ${jur}` : `사업자번호 ${biz}`}: ${ym.slice(0, 4)}.${ym.slice(4)} 지정 대규모기업집단 소속회사 자료가 없습니다(비소속이거나 해당 연도 미소속).`, ...notes.map(n => "※ " + n), SRC(ym)].join("\n");
    }
    const o = ov[0] || {}, f = fin[0] || {};
    const out = [`## ${base.entrprsNm || o.entrprsNm || "-"} — 기업집단 ${base.unityGrupNm || o.unityGrupNm || "(조회조건상 미표시)"}`,
      `법인등록번호 ${jur || base.jurirno || "-"} · 사업자번호 ${biz || base.bizrno || o.bizrno || "-"} · 대표자 ${base.rprsntvNm || o.rprsntvNm || "-"}`,
      ov.length ? `설립 ${fmtD(o.fondDe)} · 집단편입 ${fmtD(o.grinil)} · 업종 ${o.indutyNm || "-"}(${o.indutyCode || ""}) · 상시종업원 ${fmt(num(o.ordtmEmplyCo))}명` : ""];
    if (fin.length) out.push("", "### 재무현황 (공정위 제출 기준, 단위: 원)", `결산기일 ${fmtD(f.stacntDudt)} · 자산 ${fmt(num(f.assetsTotamt))} · 부채 ${fmt(num(f.debtTotamt))} · 자본 ${fmt(num(f.caplTotamt))} · 자본금 ${fmt(num(f.caplAmount))} · 매출 ${fmt(num(f.selngAmount))} · 순이익 ${fmt(num(f.thstrmNtpfAmount))} · 상장일 ${fmtD(f.entrprsOthbcDe)}`);
    if (hold.length) {
      hold.sort((a, b) => (num(b.allQotaRate) || 0) - (num(a.allQotaRate) || 0));
      out.push("", "### 주주현황", "주주명\t구분\t소유주식수\t전체지분율(%)\t보통주\t보통주지분율(%)\t우선주\t우선주지분율(%)",
        ...hold.map(h => [h.shrholdrNm, h.shrholdrSe, fmt(num(h.posesnStockCo)), h.allQotaRate, fmt(num(h.onskCo)), h.nrmltyQotaRate, fmt(num(h.prstkCo)), h.priorQotaRate].join("\t")));
    }
    if (ex.length) out.push("", "### 임원현황", "임원명\t직위\t동일인과의 관계", ...ex.map(e => `${e.exctvNm}\t${e.ofcpsNm}\t${e.smerRelateNm || "-"}`));
    out.push("", ...notes.map(n => "※ " + n), SRC(ym));
    return out.filter(x => x !== "").join("\n");
  }

  if (name === "ftc_affiliation_changes") {
    const to = args.to ? digits(args.to) : kstYmd();
    const from = args.from ? digits(args.from) : `${+to.slice(0, 4) - 1}${to.slice(4)}`;
    let code;
    if (args.group) code = (await resolveGroup(args.group, await latestYm(key), key)).code;
    let rows = await callAll("changes", { pdBeginPresentnYm: from, pdEndPresentnYm: to, unityGrupCode: code }, key, 5000);
    if (args.company) rows = rows.filter(r => norm(r.entrprsNm).includes(norm(args.company)));
    const CH = { "0001": "편입", "0002": "제외", "0003": "유예" };
    const IN = { "0001": "회사설립", "0002": "지분취득", "0003": "기타" };
    const EX = { "0001": "흡수합병", "0002": "지분매각", "0003": "청산종결", "0004": "기타" };
    const PP = { "0001": "산학연협력기술지주", "0002": "산학연협력기술지주 자회사", "0003": "신기술창업전문회사", "0004": "신기술창업전문회사 자회사", "0005": "R&D중소기업", "0006": "벤처기업", "0007": "민자SPC" };
    if (!rows.length) return `${fmtD(from)} ~ ${fmtD(to)} 계열 변동 내역이 없습니다. ${SRC()}`;
    rows.sort((a, b) => String(b.incrprDe || b.exclDe || b.postpneBeginDe || "").localeCompare(String(a.incrprDe || a.exclDe || a.postpneBeginDe || "")));
    const cnt = rows.reduce((m, r) => (m[CH[r.psitnCmpnyChangeSeCode] || r.psitnCmpnyChangeSeCode] = (m[CH[r.psitnCmpnyChangeSeCode] || r.psitnCmpnyChangeSeCode] || 0) + 1, m), {});
    return [`## 계열 편입·제외·유예 내역 ${rows.length}건 (${fmtD(from)} ~ ${fmtD(to)}${code ? `, ${args.group}` : ""}) — ${Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(", ")}`, "",
      "기업집단\t회사명\t법인등록번호\t구분\t일자\t사유",
      ...rows.slice(0, 500).map(r => {
        const c = r.psitnCmpnyChangeSeCode;
        const day = c === "0001" ? r.incrprDe : c === "0002" ? r.exclDe : r.postpneBeginDe;
        const why = c === "0001" ? IN[r.incrprPrvonshCode] : c === "0002" ? `${EX[r.exclPrvonshCode] || r.exclPrvonshCode || ""}${r.exclTrgetJobCode === "0002" ? "(독립경영)" : ""}` : `${PP[r.postpnePrvonshTyCode] || ""} ~${fmtD(r.postpneEndDe || r.postpneEndPrearngeDe)}`;
        return [r.unityGrupNm, r.entrprsNm, r.jurirno, CH[c] || c, fmtD(day), why || "-"].join("\t");
      }), rows.length > 500 ? `(상위 500건만 표시, 전체 ${rows.length}건)` : "", SRC()].filter(x => x !== "").join("\n");
  }

  if (name === "ftc_holding") {
    let ym = args.ym ? ymOf(args.ym) : await latestYm(key, "0003");
    // 월별 공개분은 그 달 신규 설립·전환 신고분뿐이므로, 전체 지주회사 목록이 있는 가장 최근 달을 찾는다
    if (!args.ym) {
      const yms = (await callAll("ym", { jobSeCode: "0003" }, key, 200).catch(() => [])).map(r => r.othbcYm).filter(v => /^\d{6}$/.test(v || "")).sort().reverse();
      for (const y of yms.slice(0, 36)) {
        const t = await call("holdco", { presentnYm: y }, key, { rows: 1 }).catch(() => ({ rows: [] }));
        if ((t.total || t.rows.length) >= 30) { ym = y; break; } // 연 1회 전체목록 공개월(나머지 달은 신규 신고분만)
      }
    }
    let jur = digits(args.jurirno);
    let list = [];
    if (!jur) {
      list = await callAll("holdco", { presentnYm: ym }, key, 500);
      if (args.name) list = list.filter(r => norm(r.unityGrupNm).includes(norm(args.name)));
      if (args.name && list.length === 1) jur = digits(list[0].jurirno);
    }
    const out = [];
    if (list.length && !(args.name && list.length === 1 && jur)) {
      list.sort((a, b) => (num(b.assetsTotamt) || 0) - (num(a.assetsTotamt) || 0));
      return [`## 지주회사 ${list.length}개 (${ym.slice(0, 4)}.${ym.slice(4)} 공개)`, "",
        "지주회사\t법인등록번호\t구분\t자산총액\t부채비율(%)\t지주비율(%)\t자회사(상장)\t손자회사(상장)\t증손회사(상장)\t설립전환일",
        ...list.map(r => [r.unityGrupNm, r.jurirno, r.fnncSeCodeNm, fmt(num(r.assetsTotamt)), r.debtRate, r.pllrRate, `${r.cdpnyCo}(${r.cdpnyLstCo})`, `${r.grndsonCmpnyCo}(${r.grndsonCmpnyLstCo})`, `${r.grtgrndsonCmpnyCo}(${r.grtgrndsonCmpnyLstCo})`, fmtD(r.hldcpFondDe)].join("\t")),
        "", SRC(ym)].join("\n");
    }
    if (!jur) return `조건에 맞는 지주회사가 없습니다. ${SRC(ym)}`;
    if (list[0]) { const r = list[0]; out.push(`## ${r.unityGrupNm} (${r.fnncSeCodeNm}) — 자산 ${fmt(num(r.assetsTotamt))} · 부채비율 ${r.debtRate}% · 지주비율 ${r.pllrRate}% · 설립전환 ${fmtD(r.hldcpFondDe)}`); }
    const subs = await callAll("holdsub", { presentnYm: ym, jurirno: jur }, key, 2000);
    const order = { 자회사: 1, 손자회사: 2, 증손회사: 3 };
    subs.sort((a, b) => (order[a.hldcpSeNm] || 9) - (order[b.hldcpSeNm] || 9) || (num(b.cdpnyQotaRate) || 0) - (num(a.cdpnyQotaRate) || 0));
    const nm = new Map(subs.map(s => [s.cdpnyJurirno, s.cdpnyNm]));
    out.push(`### 자손회사 ${subs.length}개 (법인등록번호 ${jur})`, "", "구분\t회사명\t법인등록번호\t지분율(%)\t모회사",
      ...subs.map(s => [s.hldcpSeNm, s.cdpnyNm, s.cdpnyJurirno, s.cdpnyQotaRate, s.parentJurirno === jur ? "지주회사" : (nm.get(s.parentJurirno) || s.parentJurirno || "-")].join("\t")),
      "", SRC(ym));
    return out.join("\n");
  }

  if (name === "ftc_inner_equity") {
    const g = await resolveGroup(args.group, await latestYm(key), key);
    const rows = await callAll("inner", { unityGrupCode: g.code }, key, 200);
    if (!rows.length) return `${g.name} 내부지분 자료가 없습니다.`;
    rows.sort((a, b) => String(a.presentnYear).localeCompare(String(b.presentnYear)));
    const pct = (a, t) => (t ? fmt((a / t) * 100, 2) : "-");
    return [`## ${g.name}(${g.code}) 내부지분율 추이`, "", "연도\t동일인\t자본금총액\t동일인%\t특수관계인%\t계열회사%\t자기주식%\t내부지분율%",
      ...rows.map(r => {
        const t = num(r.caplAmount) || 0, a = num(r.smerCaplAmount) || 0, b = num(r.slptCaplAmount) || 0, c = num(r.entrprsCaplAmount) || 0, d = num(r.tesstkCaplAmount) || 0;
        return [r.presentnYear, r.smerNm, fmt(t), pct(a, t), pct(b, t), pct(c, t), pct(d, t), pct(a + b + c + d, t)].join("\t");
      }), "", "지분율 = 각 주체 보유 자본금 ÷ 소속회사 자본금 총액(공정위 산식). 자본금 단위 백만원.", SRC()].join("\n");
  }

  throw new ToolError(`알 수 없는 도구: ${name}`);
}

module.exports = createHandler({
  serverInfo: { name: "ftc-group-mcp", version: "1.0.0" },
  instructions:
    "공정거래위원회 기업집단포털 조회 서버. 집단 목록·자산순위는 ftc_groups, 집단의 소속회사·재무는 ftc_group_companies, 회사 1곳의 계열 여부·주주·임원은 ftc_company, " +
    "계열 편입/제외 내역은 ftc_affiliation_changes, 지주회사 구조는 ftc_holding, 내부지분율은 ftc_inner_equity. 자료는 매년 5월 1일 지정 기준이므로 인용 시 기준년월과 출처(공정위 기업집단포털)를 표기한다.",
  tools: TOOLS,
  keyParam: "data_key",
  keyHeader: "X-Data-Key",
  envVar: "DATA_GO_KR_KEY",
  run,
});
module.exports._internal = { run, parseXml };
