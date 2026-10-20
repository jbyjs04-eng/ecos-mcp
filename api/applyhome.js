// 한국부동산원 청약홈 분양정보·경쟁률 MCP: POST /api/applyhome?data_key=공공데이터포털_인증키
const { createHandler, ToolError } = require("../lib/core");

const BASE = "https://api.odcloud.kr/api";
const DETAIL = "ApplyhomeInfoDetailSvc/v1";
const CMPET = "ApplyhomeInfoCmpetRtSvc/v1";
const PY = 3.305785;

// 공고유형별 경로
const KINDS = {
  apt: { label: "APT", detail: "getAPTLttotPblancDetail", mdl: "getAPTLttotPblancMdl", cmpet: "getAPTLttotPblancCmpet" },
  remndr: { label: "APT 무순위·잔여세대", detail: "getRemndrLttotPblancDetail", mdl: "getRemndrLttotPblancMdl", cmpet: "getRemndrLttotPblancCmpet" },
  urbty: { label: "오피스텔·도시형·민간임대·생숙", detail: "getUrbtyOfctlLttotPblancDetail", mdl: "getUrbtyOfctlLttotPblancMdl", cmpet: "getUrbtyOfctlLttotPblancCmpet" },
  opt: { label: "임의공급", detail: "getOPTLttotPblancDetail", mdl: "getOPTLttotPblancMdl", cmpet: "getOPTLttotPblancCmpet" },
  pblpvt: { label: "공공지원 민간임대", detail: "getPblPvtRentLttotPblancDetail", mdl: "getPblPvtRentLttotPblancMdl", cmpet: "getPblPvtRentLttotPblancCmpet" },
};
const KIND_ENUM = Object.keys(KINDS);

const TOOLS = [
  {
    name: "presale_search",
    description:
      "청약홈 분양(입주자모집) 공고를 지역·주소·단지명·모집공고일 범위로 검색한다. 주택관리번호, 공급위치, 공급규모, 모집공고일, 1순위 접수일, 당첨자발표일, 시공사·시행사, 입주예정월, " +
      "투기과열·조정대상·분양가상한제·정비사업 여부를 돌려준다. 사업타당성 검토의 '최근 분양사례' 표 작성용.\n" +
      "address는 공급위치 부분일치(예: '서초구', '반포동'), area는 공급지역명(예: '서울','경기').",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KIND_ENUM, description: "공고유형(기본 apt). remndr=무순위/잔여세대, urbty=오피스텔·도시형 등, opt=임의공급, pblpvt=공공지원민간임대" },
        area: { type: "string", description: "공급지역명(시·도, 예: 서울)" },
        address: { type: "string", description: "공급위치 부분일치(예: 서초구 반포동)" },
        name: { type: "string", description: "주택명 부분일치(예: 원베일리)" },
        from: { type: "string", description: "모집공고일 시작 YYYY-MM-DD 또는 YYYYMMDD" },
        to: { type: "string", description: "모집공고일 종료 YYYY-MM-DD 또는 YYYYMMDD" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "최대 건수(기본 50)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "presale_detail",
    description:
      "공고 1건의 주택형별 분양가(최고금액, 만원)·공급면적·평당 분양가·일반/특별공급 세대수와, 주택형·순위·거주지역별 접수건수·경쟁률, 당첨가점(최저·최고·평균)을 한 번에 조회한다. " +
      "house_manage_no는 presale_search 결과의 주택관리번호.",
    inputSchema: {
      type: "object",
      properties: {
        house_manage_no: { type: "string", description: "주택관리번호" },
        pblanc_no: { type: "string", description: "공고번호(선택)" },
        kind: { type: "string", enum: KIND_ENUM, description: "공고유형(기본 apt)" },
        include: {
          type: "array", items: { type: "string", enum: ["price", "competition", "score", "special"] },
          description: "가져올 항목(기본 price·competition·score). special=특별공급 유형별 신청현황(APT)",
        },
      },
      required: ["house_manage_no"],
      additionalProperties: false,
    },
  },
  {
    name: "presale_area_competition",
    description:
      "지역(주소 부분일치)과 기간의 APT 분양공고를 모아 공고별 1순위 경쟁률(전체·해당지역), 평균 평당 분양가, 당첨가점 평균을 표로 낸다. " +
      "'서초구 1순위 경쟁률 추이', '인근 분양사례 경쟁률' 표를 바로 만들 때 사용. 공고가 많으면 최근 순으로 max_items건만 계산.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "공급위치 부분일치(예: 서초구)" },
        area: { type: "string", description: "공급지역명(예: 서울)" },
        from: { type: "string", description: "모집공고일 시작(기본 5년 전)" },
        to: { type: "string", description: "모집공고일 종료(기본 오늘)" },
        max_items: { type: "integer", minimum: 1, maximum: 40, description: "계산할 최대 공고 수(기본 20)" },
      },
      additionalProperties: false,
    },
  },
];

function normKey(key) {
  key = String(key).trim().replace(/ /g, "+");
  try { return /%[0-9A-Fa-f]{2}/.test(key) ? decodeURIComponent(key) : key; } catch { return key; }
}
function ymdDash(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.length !== 8) throw new ToolError(`날짜는 YYYY-MM-DD 또는 YYYYMMDD 형식이어야 합니다: ${s}`);
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
}
const kst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const num = v => { const n = parseFloat(String(v == null ? "" : v).replace(/[^\d.\-]/g, "")); return isFinite(n) ? n : null; };
const fmt = (n, d = 0) => n == null ? "-" : n.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const yn = v => (v === "Y" ? "Y" : v === "N" ? "N" : "-");

async function call(op, cond, key, { page = 1, perPage = 100 } = {}) {
  const qs = [`serviceKey=${encodeURIComponent(normKey(key))}`, `page=${page}`, `perPage=${perPage}`, "returnType=JSON"];
  for (const [k, v] of Object.entries(cond || {})) {
    if (v !== undefined && v !== null && v !== "") qs.push(`${encodeURIComponent(`cond[${k}]`)}=${encodeURIComponent(v)}`);
  }
  const url = `${BASE}/${op}?${qs.join("&")}`;
  let res;
  try { res = await fetch(url, { headers: { Accept: "application/json" } }); }
  catch (e) { throw new ToolError(`청약홈 API 접속 실패: ${e.message}`); }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    if (/SERVICE_KEY|NOT_REGISTERED|인증/i.test(text)) throw authErr(text);
    throw new ToolError(`응답을 해석할 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (res.status === 401 || res.status === 403 || (typeof data.code === "number" && data.code < 0)) {
    if (res.status === 401 || res.status === 403 || data.code === -4 || /인증키/.test(data.msg || "")) throw authErr(data.msg || text);
    throw new ToolError(`청약홈 API 오류(${data.code}): ${data.msg}`);
  }
  return { rows: data.data || [], total: data.matchCount != null ? data.matchCount : data.totalCount || 0 };
}
function authErr(msg) {
  return new ToolError(`인증키 오류: ${String(msg).slice(0, 120)} — 공공데이터포털에서 '청약홈 분양정보 조회 서비스'(15098547)와 '청약접수 경쟁률 및 특별공급 신청현황 조회 서비스'(15098905) 활용신청 여부, 승인 후 1~2시간 경과 여부, 커넥터 주소의 data_key를 확인하세요.`);
}

async function callAll(op, cond, key, limit) {
  const out = [];
  let page = 1, total = 0;
  while (out.length < limit) {
    const perPage = Math.min(100, limit - out.length);
    const r = await call(op, cond, key, { page, perPage });
    total = r.total;
    out.push(...r.rows);
    if (r.rows.length < perPage) break;
    page++;
  }
  return { rows: out, total };
}

function searchCond(kind, a) {
  const c = {};
  if (a.address) c["HSSPLY_ADRES::LIKE"] = a.address;
  if (a.name) c["HOUSE_NM::LIKE"] = a.name;
  if (a.area) c[kind === "apt" ? "SUBSCRPT_AREA_CODE_NM::EQ" : "SUBSCRPT_AREA_CODE::EQ"] = kind === "apt" ? a.area : undefined;
  if (a.from) c["RCRIT_PBLANC_DE::GTE"] = ymdDash(a.from);
  if (a.to) c["RCRIT_PBLANC_DE::LTE"] = ymdDash(a.to);
  return c;
}
const byDateDesc = (x, y) => String(y.RCRIT_PBLANC_DE || "").localeCompare(String(x.RCRIT_PBLANC_DE || ""));

// 주택형별 분양가 행 정리
function priceRows(kind, rows) {
  return rows.map(r => {
    const amt = num(r.LTTOT_TOP_AMOUNT != null ? r.LTTOT_TOP_AMOUNT : r.SUPLY_AMOUNT);
    const sup = num(r.SUPLY_AR);
    const perPy = amt && sup ? amt / (sup / PY) : null;
    return { ty: r.HOUSE_TY || [r.GP, r.TP].filter(Boolean).join("-") || r.MODEL_NO, sup, amt, perPy,
      gen: num(r.SUPLY_HSHLDCO), sp: num(r.SPSPLY_HSHLDCO) };
  });
}

// 1순위 경쟁률 집계 (APT)
function rank1Summary(cmpet) {
  const supply = new Map();
  let req = 0, reqLocal = 0;
  for (const r of cmpet) {
    const k = r.MODEL_NO || r.HOUSE_TY;
    if (!supply.has(k)) supply.set(k, num(r.SUPLY_HSHLDCO) || 0);
    if (String(r.SUBSCRPT_RANK_CODE) === "1") {
      const n = num(r.REQ_CNT) || 0;
      req += n;
      if (String(r.RESIDE_SECD) === "01") reqLocal += n;
    }
  }
  const sup = [...supply.values()].reduce((s, v) => s + v, 0);
  return { sup, req, reqLocal, rate: sup ? req / sup : null, rateLocal: sup ? reqLocal / sup : null };
}

async function run(name, args, key) {
  if (name === "presale_search") {
    const kind = args.kind || "apt";
    const K = KINDS[kind];
    const { rows, total } = await callAll(`${DETAIL}/${K.detail}`, searchCond(kind, args), key, args.limit || 50);
    rows.sort(byDateDesc);
    if (!rows.length) return `조건에 맞는 ${K.label} 분양공고가 없습니다. (주소는 부분일치이므로 '서초구'처럼 짧게 넣어 보세요.)`;
    const lines = rows.map(r => [
      r.HOUSE_MANAGE_NO, r.PBLANC_NO, r.HOUSE_NM, r.HSSPLY_ADRES, fmt(num(r.TOT_SUPLY_HSHLDCO)), r.RCRIT_PBLANC_DE || "-",
      r.GNRL_RNK1_CRSPAREA_RCPTDE || r.GNRL_RCEPT_BGNDE || r.SUBSCRPT_RCEPT_BGNDE || r.RCEPT_BGNDE || "-", r.PRZWNER_PRESNATN_DE || "-",
      r.CNSTRCT_ENTRPS_NM || "-", r.BSNS_MBY_NM || "-", r.MVN_PREARNGE_YM || "-",
      kind === "apt" ? `${yn(r.SPECLT_RDN_EARTH_AT)}/${yn(r.MDAT_TRGET_AREA_SECD)}/${yn(r.PARCPRC_ULS_AT)}/${yn(r.IMPRMN_BSNS_AT)}` : "-",
    ].join("\t"));
    return [
      `## 청약홈 ${K.label} 분양공고 ${rows.length}건${total > rows.length ? ` (전체 ${total}건 중)` : ""}`, "",
      "주택관리번호\t공고번호\t주택명\t공급위치\t공급규모\t모집공고일\t1순위(일반)접수\t당첨자발표\t시공사\t시행사\t입주예정\t투기과열/조정/상한제/정비사업",
      ...lines, "", "출처: 한국부동산원 청약홈(공공데이터포털), 조회일 " + kst(),
    ].join("\n");
  }

  if (name === "presale_detail") {
    const kind = args.kind || "apt";
    const K = KINDS[kind];
    const inc = new Set(args.include && args.include.length ? args.include : ["price", "competition", "score"]);
    const cond = { "HOUSE_MANAGE_NO::EQ": args.house_manage_no, "PBLANC_NO::EQ": args.pblanc_no };
    const tasks = {
      head: call(`${DETAIL}/${K.detail}`, cond, key, { perPage: 1 }),
      price: inc.has("price") ? callAll(`${DETAIL}/${K.mdl}`, cond, key, 300) : null,
      competition: inc.has("competition") ? callAll(`${CMPET}/${K.cmpet}`, cond, key, 600) : null,
      score: inc.has("score") && kind === "apt" ? callAll(`${CMPET}/getAptLttotPblancScore`, cond, key, 300) : null,
      special: inc.has("special") && kind === "apt" ? callAll(`${CMPET}/getAPTSpsplyReqstStus`, cond, key, 300) : null,
    };
    const got = {};
    for (const [k, p] of Object.entries(tasks)) got[k] = p ? await p : null;
    const h = (got.head.rows || [])[0] || {};
    const out = [`## ${h.HOUSE_NM || args.house_manage_no} (${K.label})`,
      h.HSSPLY_ADRES ? `공급위치 ${h.HSSPLY_ADRES} · 공급규모 ${fmt(num(h.TOT_SUPLY_HSHLDCO))}세대 · 모집공고 ${h.RCRIT_PBLANC_DE || "-"} · 시공 ${h.CNSTRCT_ENTRPS_NM || "-"} · 입주예정 ${h.MVN_PREARNGE_YM || "-"}` : ""];
    if (got.price) {
      const pr = priceRows(kind, got.price.rows);
      const tot = pr.reduce((a, r) => (r.amt && r.sup ? { a: a.a + r.amt, s: a.s + r.sup / PY } : a), { a: 0, s: 0 });
      out.push("", "### 주택형별 분양가 (최고가 기준, 만원)", "주택형\t공급면적㎡\t분양가\t평당가\t일반공급\t특별공급",
        ...pr.map(r => `${r.ty}\t${fmt(r.sup, 2)}\t${fmt(r.amt)}\t${fmt(r.perPy)}\t${fmt(r.gen)}\t${fmt(r.sp)}`),
        tot.s ? `단순평균 평당가(주택형별 단순합산): ${fmt(tot.a / tot.s)}만원/평 — 세대수 가중 아님` : "");
    }
    if (got.competition) {
      const rows = got.competition.rows;
      if (kind === "apt") {
        const s = rank1Summary(rows);
        out.push("", "### 청약 경쟁률 (주택형·순위·거주지역별)",
          s.sup ? `1순위 전체 ${fmt(s.rate, 2)}:1 (접수 ${fmt(s.req)}건 / 일반공급 ${fmt(s.sup)}세대), 1순위 해당지역 ${fmt(s.rateLocal, 2)}:1` : "",
          "주택형\t공급세대\t순위\t거주지역\t접수건수\t경쟁률",
          ...rows.map(r => `${r.HOUSE_TY}\t${r.SUPLY_HSHLDCO}\t${r.SUBSCRPT_RANK_CODE}\t${r.RESIDE_SENM || ""}\t${fmt(num(r.REQ_CNT))}\t${r.CMPET_RATE}`));
      } else {
        out.push("", "### 청약 경쟁률", "주택형\t공급세대\t구분\t접수건수\t경쟁률",
          ...rows.map(r => `${r.HOUSE_TY || ""}\t${r.SUPLY_HSHLDCO || ""}\t${r.RESIDNT_PRIOR_SENM || r.SPSPLY_KND_NM || ""}\t${fmt(num(r.REQ_CNT))}\t${r.CMPET_RATE || ""}`));
      }
      if (!rows.length) out.push("경쟁률 자료 없음(접수 전이거나 미제공)");
    }
    if (got.score) {
      out.push("", "### 당첨가점", "주택형\t거주지역\t최저\t최고\t평균",
        ...got.score.rows.map(r => `${r.HOUSE_TY}\t${r.RESIDE_SENM || ""}\t${r.LWET_SCORE}\t${r.TOP_SCORE}\t${r.AVRG_SCORE}`));
      if (!got.score.rows.length) out.push("당첨가점 자료 없음");
    }
    if (got.special) {
      out.push("", "### 특별공급 신청현황", "주택형\t특공세대\t다자녀\t신혼\t생애최초\t청년\t노부모\t신생아\t결과",
        ...got.special.rows.map(r => {
          const sum = (...ks) => fmt(ks.reduce((a, k) => a + (num(r[k]) || 0), 0));
          return [r.HOUSE_TY, r.SPSPLY_HSHLDCO,
            sum("CRSPAREA_MNYCH_CNT", "CTPRVN_MNYCH_CNT", "ETC_AREA_MNYCH_CNT"),
            sum("CRSPAREA_NWWDS_NMTW_CNT", "CTPRVN_NWWDS_NMTW_CNT", "ETC_AREA_NWWDS_NMTW_CNT"),
            sum("CRSPAREA_LFE_FRST_CNT", "CTPRVN_LFE_FRST_CNT", "ETC_AREA_LFE_FRST_CNT"),
            sum("CRSPAREA_YGMN_CNT", "CTPRVN_YGMN_CNT", "ETC_AREA_YGMN_CNT"),
            sum("CRSPAREA_OPS_CNT", "CTPRVN_OPS_CNT", "ETC_AREA_OPS_CNT"),
            sum("CRSPAREA_NWBB_NWBBSHR_CNT", "CTPRVN_NWBB_NWBBSHR_CNT", "ETC_AREA_NWBB_NWBBSHR_CNT"),
            r.SUBSCRPT_RESULT_NM || ""].join("\t");
        }));
    }
    out.push("", "출처: 한국부동산원 청약홈(공공데이터포털), 조회일 " + kst() + ". 접수건수는 은행 전산 사정으로 청약홈 최종 수치와 일부 다를 수 있음.");
    return out.filter(x => x !== "").join("\n");
  }

  if (name === "presale_area_competition") {
    if (!args.address && !args.area) throw new ToolError("address(예: 서초구) 또는 area(예: 서울) 중 하나는 필요합니다.");
    const to = args.to || kst();
    const from = args.from || `${+kst().slice(0, 4) - 5}${kst().slice(4)}`;
    const max = args.max_items || 20;
    const { rows: list, total } = await callAll(`${DETAIL}/getAPTLttotPblancDetail`, searchCond("apt", { ...args, from, to }), key, 200);
    list.sort(byDateDesc);
    const pick = list.slice(0, max);
    const results = await Promise.all(pick.map(async h => {
      const cond = { "HOUSE_MANAGE_NO::EQ": h.HOUSE_MANAGE_NO, "PBLANC_NO::EQ": h.PBLANC_NO };
      try {
        const [c, m, s] = await Promise.all([
          callAll(`${CMPET}/getAPTLttotPblancCmpet`, cond, key, 600),
          callAll(`${DETAIL}/getAPTLttotPblancMdl`, cond, key, 300),
          callAll(`${CMPET}/getAptLttotPblancScore`, cond, key, 300),
        ]);
        const r1 = rank1Summary(c.rows);
        const pr = priceRows("apt", m.rows);
        const w = pr.reduce((a, r) => (r.amt && r.sup ? { a: a.a + r.amt * ((r.gen || 0) + (r.sp || 0) || 1), s: a.s + (r.sup / PY) * ((r.gen || 0) + (r.sp || 0) || 1) } : a), { a: 0, s: 0 });
        const sc = s.rows.map(x => num(x.AVRG_SCORE)).filter(v => v != null);
        return { h, r1, perPy: w.s ? w.a / w.s : null, score: sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : null };
      } catch (e) { return { h, err: e.message }; }
    }));
    if (!results.length) return "조건에 맞는 APT 분양공고가 없습니다.";
    const lines = results.map(({ h, r1, perPy, score, err }) => err
      ? `${h.RCRIT_PBLANC_DE}\t${h.HOUSE_NM}\t${h.HSSPLY_ADRES}\t-\t-\t-\t-\t-\t오류: ${err.slice(0, 60)}`
      : [h.RCRIT_PBLANC_DE, h.HOUSE_NM, h.HSSPLY_ADRES, fmt(num(h.TOT_SUPLY_HSHLDCO)), fmt(r1.sup), fmt(r1.req),
        r1.rate == null ? "-" : `${fmt(r1.rate, 2)}:1`, r1.rateLocal == null ? "-" : `${fmt(r1.rateLocal, 2)}:1`,
        fmt(perPy), score == null ? "-" : fmt(score, 1)].join("\t"));
    return [
      `## APT 1순위 경쟁률 (${args.address || args.area}, ${ymdDash(from)} ~ ${ymdDash(to)}) — ${results.length}건${total > results.length ? ` / 전체 ${total}건 중 최근순` : ""}`, "",
      "모집공고일\t주택명\t공급위치\t공급규모\t일반공급\t1순위접수\t1순위경쟁률\t해당지역경쟁률\t평당분양가(만원,세대가중)\t평균당첨가점",
      ...lines, "",
      "주: 1순위 경쟁률 = 1순위 접수건수 합 ÷ 주택형별 일반공급 세대수 합. 평당분양가는 주택형별 최고분양가·공급면적 기준(세대수 가중). 평균당첨가점은 주택형·지역별 평균의 단순평균.",
      "출처: 한국부동산원 청약홈(공공데이터포털), 조회일 " + kst(),
    ].join("\n");
  }

  throw new ToolError(`알 수 없는 도구: ${name}`);
}

module.exports = createHandler({
  serverInfo: { name: "applyhome-mcp", version: "1.0.0" },
  instructions:
    "한국부동산원 청약홈 분양정보·경쟁률 조회 서버. 지역 공고 목록은 presale_search, 공고 1건의 주택형별 분양가·경쟁률·당첨가점은 presale_detail(주택관리번호), " +
    "지역·기간 1순위 경쟁률 표는 presale_area_competition. 분양가는 만원, 평당가는 공급면적 기준. 인용 시 모집공고일과 출처(한국부동산원 청약홈)를 표기한다.",
  tools: TOOLS,
  keyParam: "data_key",
  keyHeader: "X-Data-Key",
  envVar: "DATA_GO_KR_KEY",
  run,
});
module.exports._internal = { run, rank1Summary, priceRows, searchCond };
