// 국민연금 가입 사업장 MCP: POST /api/nps?data_key=공공데이터포털_인증키
const { createHandler, ToolError, norm } = require("../lib/core");

const BASE = "https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2";
const LABEL = "3046071 국민연금 가입 사업장 내역";

const TOOLS = [
  {
    name: "nps_search",
    description:
      "국민연금 가입 사업장을 사업장명(부분일치)으로 검색한다. 사업자등록번호(10자리 또는 앞 6자리)·주소 키워드로 좁힐 수 있다. 결과의 seq(식별번호)로 nps_workplace를 조회한다. " +
      "비상장 대상회사의 실재성·소재지·가입(탈퇴) 여부 확인용.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "사업장명(예: 에스디지). 법인은 보통 '(주)' 없이 등록" },
        bizno: { type: "string", description: "사업자등록번호(10자리 또는 앞 6자리, 선택)" },
        address: { type: "string", description: "주소 부분일치 필터(선택, 예: 성남시)" },
        include_closed: { type: "boolean", description: "탈퇴 사업장 포함(기본 false)" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "nps_workplace",
    description:
      "사업장 1곳의 국민연금 가입자수·당월고지금액·업종·등록일과, 최근 N개월 월별 취업자수(신규취득)·퇴직자수(상실)를 조회한다. 고지금액으로 1인당 월평균 기준소득(추정)을 계산한다. " +
      "FDD·인수금융에서 인원 추이와 인건비 규모를 외부 자료로 교차검증할 때 사용. seq가 없으면 name(+bizno)으로 찾는다.",
    inputSchema: {
      type: "object",
      properties: {
        seq: { type: "string", description: "nps_search 결과의 식별번호" },
        name: { type: "string", description: "사업장명(seq가 없을 때)" },
        bizno: { type: "string", description: "사업자등록번호(동명 사업장 구분용)" },
        months: { type: "integer", minimum: 0, maximum: 24, description: "월별 취업·퇴직 추이 개월 수(기본 12, 0이면 생략)" },
      },
      additionalProperties: false,
    },
  },
];

function normKey(key) {
  key = String(key).trim().replace(/ /g, "+");
  try { return /%[0-9A-Fa-f]{2}/.test(key) ? decodeURIComponent(key) : key; } catch { return key; }
}
const digits = s => String(s || "").replace(/\D/g, "");
const num = v => { const n = parseFloat(String(v == null ? "" : v).replace(/[^\d.\-]/g, "")); return isFinite(n) ? n : null; };
const fmt = (n, d = 0) => n == null ? "-" : n.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtD = d => { d = digits(d); return d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : d.length === 6 ? `${d.slice(0, 4)}.${d.slice(4)}` : (d || "-"); };
const kstYm = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7).replace("-", "");
const addYm = (ym, n) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(4, 6) - 1 + n, 1)); return d.toISOString().slice(0, 7).replace("-", ""); };
// 연금보험료율(사업장: 근로자+사용자 합계). 2025년 개혁으로 2026년 9.5%부터 매년 0.5%p 인상, 13% 상한
const rateOf = ym => { const y = +String(ym).slice(0, 4); return y <= 2025 ? 0.09 : Math.min(0.13, 0.09 + 0.005 * (y - 2025)); };

async function call(op, params, key, { page = 1, rows = 100 } = {}) {
  const qs = [`serviceKey=${encodeURIComponent(normKey(key))}`, `pageNo=${page}`, `numOfRows=${rows}`, "dataType=JSON"];
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") qs.push(`${k}=${encodeURIComponent(v)}`);
  let res;
  try { res = await fetch(`${BASE}/${op}?${qs.join("&")}`, { headers: { Accept: "application/json" } }); }
  catch (e) { throw new ToolError(`국민연금 API 접속 실패: ${e.message}`); }
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || /SERVICE_KEY_IS_NOT_REGISTERED|SERVICE_ACCESS_DENIED|Unauthorized|등록되지 않은/i.test(text)) {
    throw new ToolError(`인증 실패: 공공데이터포털 '${LABEL}' 활용신청이 안 됐거나 승인 직후(1~2시간)입니다. https://www.data.go.kr/data/3046071/openapi.do`);
  }
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/i.test(text)) throw new ToolError("국민연금 API 일일 호출 한도 초과.");
  let j;
  try { j = JSON.parse(text); } catch {
    const code = (text.match(/<resultCode>([^<]*)/) || [])[1];
    if (code === "03" || /NODATA/i.test(text)) return { rows: [], total: 0 };
    throw new ToolError(`응답 해석 실패(${op}): ${text.slice(0, 200)}`);
  }
  const r = j.response || j;
  const code = String(r.header?.resultCode ?? "00");
  if (!/^0+$/.test(code)) {
    if (code === "03" || /NODATA/i.test(r.header?.resultMsg || "")) return { rows: [], total: 0 };
    throw new ToolError(`국민연금 API 오류(${op}): ${code} ${r.header?.resultMsg || ""}`);
  }
  let items = r.body?.items?.item ?? r.body?.items ?? [];
  if (!Array.isArray(items)) items = items ? [items] : [];
  return { rows: items, total: num(r.body?.totalCount) || items.length };
}
async function callAll(op, params, key, max = 1000) {
  const first = await call(op, params, key);
  const rows = [...first.rows];
  for (let p = 2; rows.length < Math.min(first.total, max) && p <= 10; p++) {
    const r = await call(op, params, key, { page: p });
    if (!r.rows.length) break;
    rows.push(...r.rows);
  }
  return rows;
}

async function search(args, key) {
  const b6 = digits(args.bizno).slice(0, 6);
  let rows = await callAll("getBassInfoSearchV2", { wkplNm: String(args.name).trim(), bzowrRgstNo: b6 || undefined }, key, 1000);
  if (args.address) rows = rows.filter(r => norm(r.wkplRoadNmDtlAddr).includes(norm(args.address)));
  if (!args.include_closed) rows = rows.filter(r => String(r.wkplJnngStcd) !== "2");
  return rows;
}

async function run(name, args, key) {
  if (name === "nps_search") {
    const rows = await search(args, key);
    if (!rows.length) return `'${args.name}' 국민연금 가입 사업장이 없습니다(사업장명은 등록명 기준 부분일치 — '(주)'·'주식회사'를 빼고 핵심 상호만 넣어 보세요).`;
    rows.sort((a, b) => String(b.dataCrtYm).localeCompare(String(a.dataCrtYm)));
    return [`## 국민연금 가입 사업장 '${args.name}' ${rows.length}건`, "",
      "식별번호(seq)\t사업장명\t구분\t상태\t사업자번호(앞6)\t주소\t자료년월",
      ...rows.slice(0, 100).map(r => [r.seq, r.wkplNm, String(r.wkplStylDvcd) === "1" ? "법인" : "개인", String(r.wkplJnngStcd) === "2" ? "탈퇴" : "등록", r.bzowrRgstNo, r.wkplRoadNmDtlAddr, fmtD(r.dataCrtYm)].join("\t")),
      rows.length > 100 ? "(100건만 표시 — bizno·address로 좁히세요)" : "",
      "출처: 국민연금공단 가입 사업장 내역(공공데이터포털)"].filter(x => x !== "").join("\n");
  }

  if (name === "nps_workplace") {
    let seq = args.seq ? String(args.seq).trim() : "";
    let srcYm = ""; // 상세 API에는 자료년월이 없어 검색 결과 값을 쓴다
    if (!seq) {
      if (!args.name) throw new ToolError("seq 또는 name이 필요합니다.");
      const rows = await search({ name: args.name, bizno: args.bizno }, key);
      if (!rows.length) return `'${args.name}' 사업장을 찾지 못했습니다. nps_search로 먼저 확인하세요.`;
      const exact = rows.filter(r => norm(r.wkplNm) === norm(args.name));
      const cand = exact.length ? exact : rows;
      if (cand.length > 1 && !args.bizno) {
        return [`'${args.name}' 후보 ${cand.length}곳 — seq 또는 bizno로 다시 조회하세요.`, "", "seq\t사업장명\t사업자번호(앞6)\t주소",
          ...cand.slice(0, 30).map(r => `${r.seq}\t${r.wkplNm}\t${r.bzowrRgstNo}\t${r.wkplRoadNmDtlAddr}`)].join("\n");
      }
      seq = String(cand[0].seq);
      srcYm = digits(cand[0].dataCrtYm);
    }
    const d = (await call("getDetailInfoSearchV2", { seq }, key)).rows[0];
    if (!d) return `식별번호 ${seq} 사업장 상세 자료가 없습니다.`;
    const cnt = num(d.jnngpCnt), amt = num(d.crrmmNtcAmt);
    const baseYm = digits(d.dataCrtYm) || srcYm || addYm(kstYm(), -1);
    const rate = rateOf(baseYm);
    const perHead = cnt ? amt / cnt : null;
    const estPay = perHead != null ? perHead / rate : null;
    const out = [`## ${d.wkplNm} (${String(d.wkplStylDvcd) === "1" ? "법인" : "개인"}, ${String(d.wkplJnngStcd) === "2" ? `탈퇴 ${fmtD(d.scsnDt)}` : "가입 중"})`,
      `주소 ${d.wkplRoadNmDtlAddr || "-"} · 사업자번호 앞6자리 ${d.bzowrRgstNo || "-"} · 업종 ${d.vldtVlKrnNm || "-"}(${d.wkplIntpCd || ""}) · 국민연금 적용일 ${fmtD(d.adptDt)}`,
      "", "### 가입 현황", `자료년월 ${fmtD(baseYm)} · 가입자수 ${fmt(cnt)}명 · 당월고지금액 ${fmt(amt)}원`,
      perHead != null ? `1인당 월 보험료 ${fmt(perHead)}원 → 추정 1인당 기준소득월액 ${fmt(estPay)}원 (보험료율 ${(rate * 100).toFixed(1)}% 역산) · 추정 연간 보수총액 ${fmt(estPay * cnt * 12 / 1e8, 1)}억원` : ""];
    const months = args.months === 0 ? 0 : (args.months || 12);
    if (months) {
      const yms = Array.from({ length: months }, (_, i) => addYm(baseYm, -i));
      const per = await Promise.all(yms.map(ym => call("getPdAcctoSttusInfoSearchV2", { seq, dataCrtYm: ym }, key).then(r => ({ ym, r: r.rows[0] })).catch(e => ({ ym, err: e.message }))));
      const ok = per.filter(p => p.r && (num(p.r.nwAcqzrCnt) != null || num(p.r.lssJnngpCnt) != null)); // 값 없는 달 제외
      if (ok.length) {
        const inSum = ok.reduce((s, p) => s + (num(p.r.nwAcqzrCnt) || 0), 0), outSum = ok.reduce((s, p) => s + (num(p.r.lssJnngpCnt) || 0), 0);
        out.push("", `### 월별 취업·퇴직 (최근 ${months}개월)`, "년월\t취업(신규취득)\t퇴직(상실)\t순증",
          ...per.slice().reverse().map(p => ok.includes(p) ? `${fmtD(p.ym)}\t${fmt(num(p.r.nwAcqzrCnt))}\t${fmt(num(p.r.lssJnngpCnt))}\t${fmt((num(p.r.nwAcqzrCnt) || 0) - (num(p.r.lssJnngpCnt) || 0))}` : `${fmtD(p.ym)}\t-\t-\t-`),
          `합계\t${fmt(inSum)}\t${fmt(outSum)}\t${fmt(inSum - outSum)}`,
          cnt ? `연환산 퇴직률(이직률) 약 ${fmt((outSum / ok.length * 12) / cnt * 100, 1)}% (자료 있는 ${ok.length}개월 기준)` : "",
          ok.length < months ? `※ 월별 취업·퇴직 자료는 ${months}개월 중 ${ok.length}개월만 제공됨(국민연금 API는 최근 일부 월만 공개). 추이 분석에는 부족하므로 매월 조회·누적하거나 회사 제시 자료와 대조.` : "");
      }
      const errs = per.filter(p => p.err);
      if (errs.length && !ok.length) out.push("", `※ 월별 현황 조회 실패: ${errs[0].err}`);
    }
    out.push("", "주: 가입자수는 국민연금 사업장가입자(만 18~60세 근로자 등) 기준으로 일용직·60세 이상·외국인 일부가 빠져 실제 인원과 다를 수 있음. " +
      "기준소득월액은 상·하한이 있어 고소득자가 많은 회사는 추정 보수가 과소 계상됨. 고지금액은 근로자+사용자 부담 합계.",
      "출처: 국민연금공단 가입 사업장 내역(공공데이터포털)");
    return out.filter(x => x !== "").join("\n");
  }

  throw new ToolError(`알 수 없는 도구: ${name}`);
}

module.exports = createHandler({
  serverInfo: { name: "nps-mcp", version: "1.0.0" },
  instructions:
    "국민연금 가입 사업장 조회 서버. 사업장 찾기는 nps_search(사업장명 필수), 가입자수·고지금액·월별 취업/퇴직 추이와 1인당 추정 보수는 nps_workplace. " +
    "가입자수·보수 추정은 국민연금 기준이라 실제 인원·급여와 차이가 있으므로 교차검증 보조자료로 쓰고, 인용 시 자료년월과 출처(국민연금공단)를 표기한다.",
  tools: TOOLS,
  keyParam: "data_key",
  keyHeader: "X-Data-Key",
  envVar: "DATA_GO_KR_KEY",
  run,
});
module.exports._internal = { run, rateOf };
