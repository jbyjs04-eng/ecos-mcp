// 한국예탁결제원(SEIBro) 증권정보 MCP: POST /api/seibro?data_key=공공데이터포털_인증키
const { createHandler, ToolError, norm } = require("../lib/core");

const BASE = "https://apis.data.go.kr/B552481";
// pageNo·numOfRows를 받지 않는 기능(보내면 INVALID_REQUEST_PARAMETER)
const NOPAGE = new Set(["getIssucoBasicInfo", "getIssucoBondIssuStatus", "getShortmSecRema", "getCdSecnInfo", "getShortmIssucoRedAmtN1", "getShortmIssucoRedTermStatusN1", "getEstbIssuLmtN1"]);
const LABEL = { CorpSvc: "15157348 기업정보서비스", BondSvc: "15157416 채권정보서비스", ShortmSvc: "15157428 단기금융증권정보서비스" };

const TOOLS = [
  {
    name: "seibro_issuer",
    description:
      "회사명으로 예탁원 발행회사번호를 찾고, 그 회사의 자본시장 차입 잔액(회사채·전자단기사채·CP·국내 CB/BW/EB), 전자단기사채 발행한도·미상환잔액, " +
      "단기금융증권(CP·ABCP·전단채) 만기 구간별 잔액을 한 번에 조회한다. 인수금융·유동화 검토에서 대상회사/자산보유자의 시장성 차입 확인용.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "회사명(예: 현대캐피탈). 여러 건이면 목록을 돌려준다" },
        issuco_custno: { type: "string", description: "발행회사번호(알면 name 대신)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "seibro_bonds",
    description:
      "발행회사의 채권 발행내역(ISIN, 종목명, 종류, 발행일, 만기일, 발행금액)을 조회한다. outstanding_only=true면 만기 미도래분만, 발행년도·종류(예: 유동화, 일반회사채) 필터 가능.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "회사명(issuco_custno가 없을 때)" },
        issuco_custno: { type: "string", description: "발행회사번호" },
        outstanding_only: { type: "boolean", description: "만기 미도래분만(기본 true)" },
        kind: { type: "string", description: "종류 부분일치 필터(예: 유동화, 일반회사채, 후순위)" },
        from_year: { type: "string", description: "발행년도 이후(YYYY)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "seibro_security",
    description:
      "종목코드(ISIN, KR로 시작) 1건의 상세를 조회한다. type=stb는 전자단기사채(ABSTB 포함) 발행회사·발행일·만기·금액, cd는 CD, early_redemption은 채권 콜/풋 조기상환 일정, cashflow는 원리금 지급 확정 일정(from~to).",
    inputSchema: {
      type: "object",
      properties: {
        isin: { type: "string", description: "종목코드(KR표준코드 12자리)" },
        type: { type: "string", enum: ["stb", "cd", "early_redemption", "cashflow"], description: "조회 유형(기본 stb)" },
        from: { type: "string", description: "cashflow 조회시작 지급일 YYYYMMDD(기본 오늘)" },
        to: { type: "string", description: "cashflow 조회종료 지급일 YYYYMMDD(기본 3년 후)" },
      },
      required: ["isin"],
      additionalProperties: false,
    },
  },
  {
    name: "seibro_short_term_market",
    description:
      "단기금융시장 전체 발행잔액(전자단기사채·ABCP·CP, 억원)과, 업종(한국표준산업분류 대분류 1자리, 예: K=금융) 기준 만기 구간별 잔액을 조회한다. 유동화 ABCP/ABSTB 시장 규모·만기 구조 참고용.",
    inputSchema: {
      type: "object",
      properties: { ind_type: { type: "string", description: "업종 대분류 1자리(선택, 예: K)" } },
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
const eok = v => { const n = num(v); return n == null ? "-" : fmt(n / 1e8, 0); };
const fmtD = d => /^\d{8}$/.test(d || "") ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : (d || "-");
const unesc = s => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();

function parseItems(text) {
  if (/^\s*[{[]/.test(text)) {
    const j = JSON.parse(text);
    const r = j.response || j;
    const code = r.header?.resultCode, msg = r.header?.resultMsg;
    let items = r.body?.items?.item ?? r.body?.items ?? [];
    if (!Array.isArray(items)) items = items ? [items] : [];
    return { code, msg, total: num(r.body?.totalCount), rows: items };
  }
  const code = (text.match(/<resultCode>([^<]*)<\/resultCode>/) || [])[1];
  const msg = (text.match(/<resultMsg>([^<]*)<\/resultMsg>/) || [])[1];
  const total = num((text.match(/<totalCount>([^<]*)<\/totalCount>/) || [])[1]);
  const rows = [];
  for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const o = {};
    for (const f of m[1].matchAll(/<([A-Za-z_]\w*)>([^<]*)<\/\1>/g)) o[f[1]] = unesc(f[2]);
    if (Object.values(o).some(v => v !== "")) rows.push(o);
  }
  return { code, msg, total, rows };
}

async function call(svc, op, params, key, { page = 1, rows = 100 } = {}) { // GW 서비스는 numOfRows 최대 100
  const label = LABEL[svc];
  const qs = [`serviceKey=${encodeURIComponent(normKey(key))}`, "resultType=json"];
  if (!NOPAGE.has(op)) qs.push(`pageNo=${page}`, `numOfRows=${rows}`);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") qs.push(`${k}=${encodeURIComponent(v)}`);
  let res;
  try { res = await fetch(`${BASE}/${svc}/${op}?${qs.join("&")}`, { headers: { Accept: "application/json, application/xml" } }); }
  catch (e) { throw new ToolError(`예탁원 API 접속 실패(${label}): ${e.message}`); }
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || /SERVICE_KEY_IS_NOT_REGISTERED|SERVICE_ACCESS_DENIED|Unauthorized|등록되지 않은/i.test(text)) {
    throw new ToolError(`인증 실패: 공공데이터포털 '${label}' 활용신청이 안 됐거나 승인 직후(1~2시간)입니다. https://www.data.go.kr/data/${label.split(" ")[0]}/openapi.do`);
  }
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/i.test(text)) throw new ToolError(`일일 호출 한도 초과(${label}).`);
  let out;
  try { out = parseItems(text); } catch { throw new ToolError(`응답 해석 실패(${label} ${op}): ${text.slice(0, 200)}`); }
  if (out.code && !/^0+$/.test(String(out.code))) {
    if (/^0?3$|NODATA/i.test(`${out.code}`) || /NODATA|데이터 ?없/i.test(out.msg || "")) return { rows: [], total: 0 };
    throw new ToolError(`예탁원 API 오류(${label} ${op}): ${out.code} ${out.msg || ""}`);
  }
  return out;
}
async function callAll(svc, op, params, key, max = 5000) {
  const first = await call(svc, op, params, key);
  const rows = [...first.rows];
  if (NOPAGE.has(op)) return rows;
  const total = first.total || rows.length;
  for (let p = 2; rows.length < Math.min(total, max) && p <= 50; p++) {
    const r = await call(svc, op, params, key, { page: p });
    if (!r.rows.length) break;
    rows.push(...r.rows);
  }
  return rows;
}

async function resolveIssuer(args, key) {
  if (args.issuco_custno) return { custno: String(args.issuco_custno).trim(), name: args.name || "" };
  if (!args.name) throw new ToolError("name 또는 issuco_custno가 필요합니다.");
  const rows = await callAll("CorpSvc", "getIssucoCustnoByNm", { issucoNm: args.name }, key, 200);
  if (!rows.length) throw new ToolError(`예탁원 발행회사 중 '${args.name}'을(를) 찾지 못했습니다. 정식 회사명(예: 현대캐피탈)으로 다시 시도하세요.`);
  const strip = s => norm(s).replace(/\(주\)|주식회사|㈜/g, "");
  const exact = rows.filter(r => strip(r.issucoNm) === strip(args.name));
  const pick = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
  if (!pick) return { list: rows };
  return { custno: pick.issucoCustno, name: pick.issucoNm, market: pick.listNm };
}
const listOut = (rows, q) => [`'${q}' 검색 결과 ${rows.length}곳 — issuco_custno로 다시 조회하세요.`, "", "발행회사명\t발행회사번호\t시장",
  ...rows.slice(0, 50).map(r => `${r.issucoNm}\t${r.issucoCustno}\t${r.listNm || "-"}`)].join("\n");
const SRC = () => `출처: 한국예탁결제원 증권정보(SEIBro, 공공데이터포털) · 조회일 ${fmtD(kstYmd())}`;

async function run(name, args, key) {
  if (name === "seibro_issuer") {
    const iss = await resolveIssuer(args, key);
    if (iss.list) return listOut(iss.list, args.name);
    const p = { issucoCustno: iss.custno };
    const notes = [];
    const safe = (svc, op, extra = {}) => callAll(svc, op, { ...p, ...extra }, key, 500).catch(e => (notes.push(e.message), []));
    const [basic, bond, lmt, term] = await Promise.all([
      safe("CorpSvc", "getIssucoBasicInfo"),
      safe("CorpSvc", "getIssucoBondIssuStatus"),
      safe("ShortmSvc", "getEstbIssuLmtN1"),
      safe("ShortmSvc", "getShortmIssucoRedTermStatusN1"),
    ]);
    const b = basic[0] || {}, d = bond[0] || {};
    const out = [`## ${iss.name || b.repSecnNm || iss.custno} (발행회사번호 ${iss.custno}${iss.market ? `, ${iss.market}` : ""})`,
      basic.length ? `대표자 ${b.ceoNm || "-"} · 사업자번호 ${b.bizno || "-"} · 설립 ${fmtD(b.founDt)} · 결산월일 ${b.setaccMmdd || "-"} · 총발행주식수 ${fmt(num(b.totalStkCnt))} · 시장 ${b.caltotMartTpcdNm || "-"}` : ""];
    if (bond.length) {
      out.push("", "### 자본시장 차입 잔액 (억원)", "회사채\t전자단기사채\tCP\t국내CB\t국내BW\t국내EB",
        [eok(d.issuRema), eok(d.ectAmt), eok(d.faceAmt), eok(d.issuKorRemaStk), eok(d.issuKorRemaBw), eok(d.issuKorRemaEb)].join("\t"));
    }
    if (lmt.length) {
      out.push("", "### 전자단기사채 발행한도", "통화\t발행한도\t미상환잔액\t발행가능액\t한도초과\t인가일\t최근발행일",
        ...lmt.map(r => [r.curCd, eok(r.issuLmtAmt), eok(r.unredRemAmt), eok(r.issuPossAmt), r.issuLmtXcesYn, fmtD(r.apprvDt), fmtD(r.recentIssuDt)].join("\t")), "(금액 억원)");
    }
    if (term.length) {
      out.push("", "### 단기금융증권 잔존만기별 잔액", "증권구분\t행구분\t1~10일\t11~29일\t30~89일\t90~179일\t180~364일\t1년이상\t합계",
        ...term.map(r => [r.secnTpnm, r.rowTp, r.col_1to10, r.col_11to29, r.col_30to89, r.col_90to179, r.col_180to364, r.colOveryear, r.colSum].join("\t")));
    }
    out.push("", ...notes.map(n => "※ " + n), "금액은 원 단위 원자료를 억원으로 환산(만기 구간표는 원자료 그대로).", SRC());
    return out.filter(x => x !== "").join("\n");
  }

  if (name === "seibro_bonds") {
    const iss = await resolveIssuer(args, key);
    if (iss.list) return listOut(iss.list, args.name);
    let rows = await callAll("BondSvc", "getIssurBondIssuDetailsInfo", { issucoCustno: iss.custno }, key, 5000);
    const total = rows.length;
    const today = kstYmd();
    if (args.outstanding_only !== false) rows = rows.filter(r => !r.redDt || r.redDt >= today);
    if (args.kind) rows = rows.filter(r => norm(r.secnKacd).includes(norm(args.kind)) || norm(r.korSecnNm).includes(norm(args.kind)));
    if (args.from_year) rows = rows.filter(r => String(r.issuDt || "").slice(0, 4) >= String(args.from_year));
    rows.sort((a, b) => String(b.issuDt).localeCompare(String(a.issuDt)));
    const sum = rows.reduce((s, r) => s + (num(r.firstIssuAmt) || 0), 0);
    const byKind = rows.reduce((m, r) => (m[r.secnKacd || "-"] = (m[r.secnKacd || "-"] || 0) + (num(r.firstIssuAmt) || 0), m), {});
    return [`## ${iss.name || iss.custno} 채권 발행내역 ${rows.length}건${args.outstanding_only !== false ? " (만기 미도래)" : ""} / 전체 ${total}건`,
      `발행금액 합계 ${eok(sum)}억원 — ${Object.entries(byKind).map(([k, v]) => `${k} ${eok(v)}`).join(", ")}`, "",
      "ISIN\t종목명\t종류\t발행일\t만기일\t발행금액(억원)\t통화",
      ...rows.slice(0, 300).map(r => [r.isin, r.korSecnNm, r.secnKacd, fmtD(r.issuDt), fmtD(r.redDt), eok(r.firstIssuAmt), r.issuCurCd].join("\t")),
      rows.length > 300 ? `(최근 300건만 표시)` : "", "주: 발행금액은 최초 발행금액 기준이며 중도상환·조기상환은 반영되지 않음. 금리는 이 API에서 제공하지 않음.", SRC()].filter(x => x !== "").join("\n");
  }

  if (name === "seibro_security") {
    const isin = String(args.isin).trim().toUpperCase();
    const type = args.type || "stb";
    if (type === "stb") {
      const r = (await callAll("ShortmSvc", "getSTBInfo", { isin }, key, 10))[0];
      if (!r) return `전자단기사채 종목 ${isin} 자료가 없습니다.`;
      return [`## ${r.korSecnNm} (${isin}) — 전자단기사채`, `발행회사 ${r.issucoNm}(${r.issucoCustno}) · 발행일 ${fmtD(r.issuDt)} · 만기일 ${fmtD(r.xpirDt)} · 발행금액 ${eok(r.payinAmt)}억원 · ${r.issuCurCd}`, SRC()].join("\n");
    }
    if (type === "cd") {
      const r = (await callAll("ShortmSvc", "getCdSecnInfo", { isin }, key, 10))[0];
      if (!r) return `CD 종목 ${isin} 자료가 없습니다.`;
      return [`## ${r.korSecnNm} (${isin}) — CD`, `발행일 ${fmtD(r.issuDt)} · 만기일 ${fmtD(r.xpirDt)} · 발행금액 ${eok(r.issuAmt)}억원`, SRC()].join("\n");
    }
    if (type === "early_redemption") {
      const rows = await callAll("BondSvc", "getBondErlyRedInfo", { isin }, key, 200);
      if (!rows.length) return `${isin} 조기상환 정보가 없습니다.`;
      return [`## ${rows[0].korSecnNm || isin} 조기상환 일정`, "", "옵션\t행사시작\t행사종료\t조기상환일\t행사비율\t적용이자율\t조기상환금액\t이자지급금액",
        ...rows.map(r => [({ "9401": "CALL", "9402": "PUT" })[r.optionTpcd] || r.optionTpcd, fmtD(r.xrcBeginDt), fmtD(r.xrcExpryDt), fmtD(r.erlyRedDt), r.xrcRatio, r.apliIrate, fmt(num(r.erlyRedamtVal)), fmt(num(r.intPayAmt))].join("\t")), SRC()].join("\n");
    }
    if (type === "cashflow") {
      const from = digits(args.from) || kstYmd();
      const to = digits(args.to) || `${+from.slice(0, 4) + 3}${from.slice(4)}`;
      const rows = await callAll("BondSvc", "getPrinFixInfoSchSvc", { isin, schBeginDt: from, schExpryDt: to }, key, 500);
      if (!rows.length) return `${isin} ${fmtD(from)}~${fmtD(to)} 원리금 확정 일정이 없습니다.`;
      rows.sort((a, b) => String(a.payDt).localeCompare(String(b.payDt)));
      const PR = { "01": "이자", "02": "원금" };
      return [`## ${isin} 원리금 지급 일정 (${fmtD(from)} ~ ${fmtD(to)})`, "", "지급일\t원지급일\t구분\t지급일확정\t원화여부",
        ...rows.map(r => [fmtD(r.payDt), fmtD(r.orgnPayDt), PR[r.prinTpcd] || r.prinTpcd, r.payDtFixYn, r.krwYn].join("\t")), SRC()].join("\n");
    }
  }

  if (name === "seibro_short_term_market") {
    const notes = [];
    const [rema, term] = await Promise.all([
      callAll("ShortmSvc", "getShortmSecRema", {}, key, 50).catch(e => (notes.push(e.message), [])),
      callAll("ShortmSvc", "getShortmIssucoRedTermStatusN1", { indType: args.ind_type }, key, 200).catch(e => (notes.push(e.message), [])),
    ]);
    const out = ["## 단기금융시장 발행잔액"];
    if (rema.length) out.push("", "전자단기사채\tABCP\tCP\t(억원)", ...rema.map(r => [fmt(num(r.estbIssuRema)), fmt(num(r.abcpIssuRema)), fmt(num(r.cpIssuRema))].join("\t")));
    if (term.length) out.push("", `### 잔존만기별 잔액${args.ind_type ? ` (업종 ${args.ind_type})` : ""}`, "증권구분\t행구분\t1~10일\t11~29일\t30~89일\t90~179일\t180~364일\t1년이상\t합계",
      ...term.map(r => [r.secnTpnm, r.rowTp, r.col_1to10, r.col_11to29, r.col_30to89, r.col_90to179, r.col_180to364, r.colOveryear, r.colSum].join("\t")));
    out.push("", ...notes.map(n => "※ " + n), SRC());
    return out.join("\n");
  }

  throw new ToolError(`알 수 없는 도구: ${name}`);
}

module.exports = createHandler({
  serverInfo: { name: "seibro-mcp", version: "1.0.0" },
  instructions:
    "한국예탁결제원(SEIBro) 증권정보 조회 서버. 회사의 회사채·CP·전단채·CB 잔액과 전단채 한도는 seibro_issuer, 채권 발행내역은 seibro_bonds, ISIN 1건(전단채·CD·조기상환·원리금 일정)은 seibro_security, " +
    "단기금융시장 전체 잔액·만기 구조는 seibro_short_term_market. 발행금리는 제공되지 않는다. 인용 시 조회일과 출처(한국예탁결제원)를 표기한다.",
  tools: TOOLS,
  keyParam: "data_key",
  keyHeader: "X-Data-Key",
  envVar: "DATA_GO_KR_KEY",
  run,
});
module.exports._internal = { run, parseItems };
