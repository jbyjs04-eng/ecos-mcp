// 한국거래소 KRX Open API MCP 엔드포인트: POST /api/krx?krx_key=본인인증키
const { createHandler, ToolError, norm, kstToday, addDays, getJson } = require("../lib/core");

const BASE = "https://data-dbg.krx.co.kr/svc/apis";

const MARKETS = {
  KOSPI: { stock: "sto/stk_bydd_trd", base: "sto/stk_isu_base_info", index: "idx/kospi_dd_trd" },
  KOSDAQ: { stock: "sto/ksq_bydd_trd", base: "sto/ksq_isu_base_info", index: "idx/kosdaq_dd_trd" },
};

const LABELS = {
  BAS_DD: "기준일", ISU_CD: "종목코드", ISU_SRT_CD: "단축코드", ISU_NM: "종목명", ISU_ABBRV: "약명",
  MKT_NM: "시장", SECT_TP_NM: "소속부", TDD_CLSPRC: "종가", CMPPREV_DD_PRC: "대비", FLUC_RT: "등락률(%)",
  TDD_OPNPRC: "시가", TDD_HGPRC: "고가", TDD_LWPRC: "저가", ACC_TRDVOL: "거래량", ACC_TRDVAL: "거래대금",
  MKTCAP: "시가총액", LIST_SHRS: "상장주식수", IDX_CLSS: "계열", IDX_NM: "지수명", CLSPRC_IDX: "종가지수",
  CMPPREV_IDX: "대비", OPNPRC_IDX: "시가", HGPRC_IDX: "고가", LWPRC_IDX: "저가",
  PARVAL: "액면가", LIST_DD: "상장일", KIND_STKCERT_TP_NM: "주식종류",
};

const TOOLS = [
  {
    name: "stock_on_date",
    description:
      "특정일 KRX 공식 종가·시가총액·상장주식수·거래량을 조회한다(KOSPI·KOSDAQ 자동 탐색). 휴장일이면 직전 거래일 값을 쓴다.\n" +
      "stocks: 종목코드 6자리 또는 종목명(일부 일치) 배열, 최대 20개. 평가기준일 시가총액·주가 근거용. 베타 회귀는 KR Valuation 커넥터 사용 권장.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "기준일 YYYYMMDD" },
        stocks: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
        market: { type: "string", enum: ["ALL", "KOSPI", "KOSDAQ"], default: "ALL" },
      },
      required: ["date", "stocks"],
      additionalProperties: false,
    },
  },
  {
    name: "index_on_date",
    description: "특정일 KOSPI·KOSDAQ 시리즈 지수 종가를 조회한다(휴장일은 직전 거래일). keyword로 지수명을 좁힌다(예: '코스피 200', '건설').",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "기준일 YYYYMMDD" },
        market: { type: "string", enum: ["KOSPI", "KOSDAQ"], default: "KOSPI" },
        keyword: { type: "string" },
      },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: "stock_base_info",
    description: "종목 기본정보(표준코드·상장일·액면가·주식종류·상장주식수)를 조회한다.",
    inputSchema: {
      type: "object",
      properties: {
        stocks: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
        date: { type: "string", description: "기준일 YYYYMMDD (생략 시 오늘)" },
      },
      required: ["stocks"],
      additionalProperties: false,
    },
  },
];

async function krx(path, params, key) {
  const qs = new URLSearchParams({ ...params, AUTH_KEY: key }).toString();
  const { data } = await getJson(`${BASE}/${path}?${qs}`, { headers: { AUTH_KEY: key } });
  if (data && (data.respCode || data.respMsg) && !data.OutBlock_1) {
    throw new ToolError(`KRX 오류(${data.respCode || "-"}): ${data.respMsg || JSON.stringify(data).slice(0, 200)} — 인증키와 해당 API 이용신청 승인 여부를 확인하세요.`);
  }
  if (Array.isArray(data && data.OutBlock_1)) return data.OutBlock_1;
  const arr = data && Object.values(data).find(Array.isArray);
  return arr || [];
}

// 휴장일이면 최대 10일 전까지 거슬러 올라간다.
async function onLatestDay(path, date, key) {
  for (let i = 0; i <= 10; i++) {
    const d = addDays(date, -i);
    const rows = await krx(path, { basDd: d }, key);
    if (rows.length) return { day: d, rows };
  }
  return { day: null, rows: [] };
}

function checkDate(d) {
  if (!/^\d{8}$/.test(String(d || ""))) throw new ToolError(`날짜는 YYYYMMDD 형식이어야 합니다: "${d}"`);
}

function matchStock(rows, q) {
  const code = String(q).trim();
  if (/^[0-9A-Z]{6}$/i.test(code)) {
    const hit = rows.find(r => [r.ISU_SRT_CD, r.ISU_CD].some(c => c && (c === code || String(c).includes(code))));
    if (hit) return hit;
  }
  const n = norm(q);
  return rows.find(r => norm(r.ISU_NM) === n || norm(r.ISU_ABBRV) === n) ||
         rows.find(r => norm(r.ISU_NM).includes(n) || norm(r.ISU_ABBRV).includes(n));
}

const num = v => (v === undefined || v === null || v === "" ? "-" : String(v));

async function run(name, args, key) {
  switch (name) {
    case "stock_on_date": {
      checkDate(args.date);
      const markets = !args.market || args.market === "ALL" ? ["KOSPI", "KOSDAQ"] : [args.market];
      const data = {};
      for (const m of markets) data[m] = await onLatestDay(MARKETS[m].stock, args.date, key);
      const lines = [];
      for (const q of args.stocks) {
        let found = null, mk = null;
        for (const m of markets) {
          const hit = matchStock(data[m].rows, q);
          if (hit) { found = hit; mk = m; break; }
        }
        lines.push(found
          ? `${found.ISU_NM}\t${found.ISU_CD}\t${mk}\t${num(found.TDD_CLSPRC)}\t${num(found.MKTCAP)}\t${num(found.LIST_SHRS)}\t${num(found.ACC_TRDVOL)}\t${found.BAS_DD || data[mk].day}`
          : `${q}\t찾지 못함\t\t\t\t\t\t`);
      }
      const used = markets.map(m => `${m} ${data[m].day || "데이터 없음"}`).join(", ");
      return [`## ${args.date} 기준 주가·시가총액 (적용 거래일: ${used})`, "",
        "종목명\t종목코드\t시장\t종가(원)\t시가총액(원)\t상장주식수\t거래량\t기준일", ...lines,
        "", "출처: 한국거래소 KRX Open API"].join("\n");
    }

    case "index_on_date": {
      checkDate(args.date);
      const m = args.market || "KOSPI";
      const { day, rows } = await onLatestDay(MARKETS[m].index, args.date, key);
      if (!rows.length) return `${m} 지수 데이터가 없습니다 (${args.date} 이전 10일).`;
      const kw = args.keyword ? norm(args.keyword) : "";
      const sel = kw ? rows.filter(r => norm(r.IDX_NM).includes(kw)) : rows;
      if (!sel.length) return `'${args.keyword}'에 해당하는 지수가 없습니다. 가능한 예: ${rows.slice(0, 15).map(r => r.IDX_NM).join(", ")}`;
      const lines = sel.slice(0, 60).map(r => `${r.IDX_NM}\t${num(r.CLSPRC_IDX)}\t${num(r.CMPPREV_IDX)}\t${num(r.FLUC_RT)}`);
      return [`## ${m} 시리즈 지수 (${day})`, "", "지수명\t종가\t대비\t등락률(%)", ...lines, "", "출처: 한국거래소 KRX Open API"].join("\n");
    }

    case "stock_base_info": {
      const date = args.date || kstToday();
      checkDate(date);
      const lines = [];
      const data = {};
      for (const m of ["KOSPI", "KOSDAQ"]) data[m] = await onLatestDay(MARKETS[m].base, date, key);
      for (const q of args.stocks) {
        let hit = null, mk = null;
        for (const m of ["KOSPI", "KOSDAQ"]) { hit = matchStock(data[m].rows, q); if (hit) { mk = m; break; } }
        if (!hit) { lines.push(`### ${q}\n찾지 못함`); continue; }
        const body = Object.entries(hit).map(([k, v]) => `- ${LABELS[k] || k}: ${num(v)}`).join("\n");
        lines.push(`### ${hit.ISU_ABBRV || hit.ISU_NM} (${mk})\n${body}`);
      }
      return [...lines, "", "출처: 한국거래소 KRX Open API"].join("\n");
    }

    default:
      throw new ToolError(`알 수 없는 도구: ${name}`);
  }
}

module.exports = createHandler({
  serverInfo: { name: "krx-mcp", version: "1.0.0" },
  instructions:
    "한국거래소 KRX Open API 조회 서버. 특정일 공식 종가·시가총액·상장주식수는 stock_on_date, 지수 종가는 index_on_date, 종목 기본정보는 stock_base_info. " +
    "베타 회귀·Peer 재무는 KR Valuation 커넥터가 담당한다. 값 인용 시 기준 거래일과 출처(한국거래소)를 표기한다.",
  tools: TOOLS,
  keyParam: "krx_key",
  keyHeader: "X-Krx-Key",
  envVar: "KRX_API_KEY",
  run,
});
module.exports._internal = { run, matchStock };
