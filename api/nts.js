// 국세청 사업자등록 상태조회·진위확인 MCP: POST /api/nts?data_key=공공데이터포털_인증키
const { createHandler, ToolError } = require("../lib/core");

const BASE = "https://api.odcloud.kr/api/nts-businessman/v1";

const TOOLS = [
  {
    name: "business_status",
    description:
      "사업자등록번호로 국세청 등록 상태(계속·휴업·폐업), 과세유형(일반·간이·면세 등), 폐업일, 과세유형 전환일을 조회한다. 최대 100개 한 번에.\n" +
      "거래처 실재성·휴폐업 확인, 매입세액 공제 검토, 세금계산서 수취 적정성 점검에 사용.",
    inputSchema: {
      type: "object",
      properties: {
        b_no: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100, description: "사업자등록번호 10자리(하이픈 가능)" },
      },
      required: ["b_no"],
      additionalProperties: false,
    },
  },
  {
    name: "business_validate",
    description:
      "사업자등록번호·개업일자·대표자명이 국세청 등록정보와 일치하는지 진위확인한다(최대 100건). 대표자명은 외국인이면 영문, 공동대표는 한 명.",
    inputSchema: {
      type: "object",
      properties: {
        businesses: {
          type: "array", minItems: 1, maxItems: 100,
          items: {
            type: "object",
            properties: {
              b_no: { type: "string", description: "사업자등록번호 10자리" },
              start_dt: { type: "string", description: "개업일자 YYYYMMDD" },
              p_nm: { type: "string", description: "대표자 성명" },
              b_nm: { type: "string", description: "상호(선택)" },
              corp_no: { type: "string", description: "법인등록번호 13자리(선택)" },
            },
            required: ["b_no", "start_dt", "p_nm"],
            additionalProperties: false,
          },
        },
      },
      required: ["businesses"],
      additionalProperties: false,
    },
  },
];

function normKey(key) {
  key = String(key).trim().replace(/ /g, "+");
  try { return /%[0-9A-Fa-f]{2}/.test(key) ? decodeURIComponent(key) : key; } catch { return key; }
}
const digits = s => String(s || "").replace(/\D/g, "");
const fmtBno = b => b.length === 10 ? `${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}` : b;
const fmtDate = d => /^\d{8}$/.test(d || "") ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : (d || "");

async function call(path, body, key) {
  const url = `${BASE}/${path}?serviceKey=${encodeURIComponent(normKey(key))}&returnType=JSON`;
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new ToolError(`국세청 API 접속 실패: ${e.message}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    if (/SERVICE_KEY|NOT_REGISTERED/i.test(text)) throw new ToolError("인증키 오류: 공공데이터포털에서 '국세청_사업자등록정보 진위확인 및 상태조회 서비스' 활용신청이 됐는지, 승인 후 1~2시간이 지났는지 확인하세요.");
    throw new ToolError(`응답을 해석할 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (typeof data.code === "number" && data.code < 0) {
    if (data.code === -4 || /인증키/.test(data.msg || "")) {
      throw new ToolError(`인증키 오류(${data.code}): ${data.msg} — 이 서비스의 활용신청 여부와 커넥터 주소의 data_key를 확인하세요.`);
    }
    throw new ToolError(`국세청 API 오류(${data.code}): ${data.msg}`);
  }
  if (data.status_code && data.status_code !== "OK") throw new ToolError(`국세청 API 오류: ${data.status_code} ${data.message || ""}`);
  return data;
}

async function run(name, args, key) {
  if (name === "business_status") {
    const list = args.b_no.map(digits);
    const bad = list.filter(b => b.length !== 10);
    if (bad.length) throw new ToolError(`사업자등록번호는 10자리여야 합니다: ${bad.join(", ")}`);
    const data = await call("status", { b_no: list }, key);
    const rows = data.data || [];
    const lines = rows.map(r => {
      const unreg = !r.b_stt_cd && /등록되지 않은/.test(r.tax_type || "");
      return [
        fmtBno(r.b_no),
        unreg ? "미등록" : (r.b_stt || "-"),
        unreg ? "국세청에 등록되지 않은 번호" : (r.tax_type || "-"),
        fmtDate(r.end_dt) || "-",
        fmtDate(r.tax_type_change_dt) || "-",
        r.utcc_yn === "Y" ? "Y" : "N",
        fmtDate(r.invoice_apply_dt) || "-",
      ].join("\t");
    });
    const closed = rows.filter(r => r.b_stt_cd === "03").length;
    const paused = rows.filter(r => r.b_stt_cd === "02").length;
    return [
      `## 사업자 상태조회 (${rows.length}건)${closed || paused ? ` — 폐업 ${closed}건, 휴업 ${paused}건` : ""}`,
      "", "사업자번호\t상태\t과세유형\t폐업일\t과세유형전환일\t단위과세전환폐업\t세금계산서적용일", ...lines,
      "", "출처: 국세청 사업자등록정보 상태조회(공공데이터포털). 국세청 자료는 약 30분 주기로 반영되며 신규 사업자는 1~2일 늦을 수 있음.",
    ].join("\n");
  }

  if (name === "business_validate") {
    const businesses = args.businesses.map(b => {
      const o = { b_no: digits(b.b_no), start_dt: digits(b.start_dt), p_nm: String(b.p_nm).trim() };
      if (b.b_nm) o.b_nm = b.b_nm;
      if (b.corp_no) o.corp_no = digits(b.corp_no);
      if (o.b_no.length !== 10) throw new ToolError(`사업자등록번호는 10자리여야 합니다: ${b.b_no}`);
      if (o.start_dt.length !== 8) throw new ToolError(`개업일자는 YYYYMMDD여야 합니다: ${b.start_dt}`);
      return o;
    });
    const data = await call("validate", { businesses }, key);
    const lines = (data.data || []).map(r => {
      const ok = r.valid === "01";
      const st = r.status || {};
      return `${fmtBno(r.b_no)}\t${ok ? "일치" : "불일치"}\t${ok ? "" : (r.valid_msg || "확인할 수 없습니다")}\t${st.b_stt || ""}\t${st.tax_type || ""}`;
    });
    return ["## 사업자 진위확인", "", "사업자번호\t결과\t사유\t상태\t과세유형", ...lines,
      "", "출처: 국세청 사업자등록정보 진위확인(공공데이터포털)"].join("\n");
  }

  throw new ToolError(`알 수 없는 도구: ${name}`);
}

module.exports = createHandler({
  serverInfo: { name: "nts-mcp", version: "1.0.0" },
  instructions:
    "국세청 사업자등록정보 조회 서버. business_status는 번호만으로 계속·휴업·폐업과 과세유형을, business_validate는 번호·개업일·대표자명 일치 여부를 확인한다. " +
    "결과 인용 시 조회일과 출처(국세청)를 표기한다.",
  tools: TOOLS,
  keyParam: "data_key",
  keyHeader: "X-Data-Key",
  envVar: "DATA_GO_KR_KEY",
  run,
});
module.exports._internal = { run };
