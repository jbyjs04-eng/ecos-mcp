// 한국부동산원 R-ONE 부동산통계 MCP 엔드포인트: POST /api/rone?rone_key=본인인증키
const { createHandler, ToolError, norm, getJson } = require("../lib/core");

const BASE = "https://www.reb.or.kr/r-one/openapi";

const TOOLS = [
  {
    name: "search_tables",
    description:
      "R-ONE 통계표를 키워드로 검색해 통계표ID(STATBL_ID)와 주기를 찾는다. 예: '아파트 매매가격지수', '전세가격지수', '오피스 임대', '상가 공실률', '지가변동률', '투자수익률'.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "get_data",
    description:
      "R-ONE 통계 수치를 조회한다. cycle: MM(월)·QY(분기)·HY(반기)·YY(연)·WK(주). 기간 형식은 MM=YYYYMM, YY=YYYY, QY=YYYYQ(예: 20251).\n" +
      "처음에는 cls_id·itm_id 없이 짧은 기간으로 호출해 지역코드(CLS_ID)·항목코드(ITM_ID)를 확인한 뒤, 필요한 지역·항목만 지정해 기간을 넓힌다.",
    inputSchema: {
      type: "object",
      properties: {
        statbl_id: { type: "string", description: "통계표ID (예: A_2024_00903)" },
        cycle: { type: "string", enum: ["MM", "QY", "HY", "YY", "WK"] },
        start: { type: "string", description: "시작 시점" },
        end: { type: "string", description: "종료 시점(생략 시 최신까지)" },
        cls_id: { type: "string", description: "지역(분류) 코드, 예: 500001=전국" },
        itm_id: { type: "string", description: "항목 코드" },
        keyword: { type: "string", description: "지역명 필터(결과 내 일부 일치, 예: '부천')" },
        max_rows: { type: "integer", minimum: 1, maximum: 2000, default: 300 },
      },
      required: ["statbl_id", "cycle", "start"],
      additionalProperties: false,
    },
  },
];

function unwrap(data, svc) {
  if (data && data.RESULT && !data[svc]) {
    const { CODE, MESSAGE } = data.RESULT;
    if (/INFO-200/.test(CODE || "")) return { total: 0, rows: [] };
    if (/ERROR-29|INFO-300|ERROR-290/.test(CODE || "") || /인증키/.test(MESSAGE || "")) {
      throw new ToolError(`R-ONE 인증키 오류(${CODE}): ${MESSAGE} — 커넥터 주소의 rone_key 값을 확인하세요.`);
    }
    throw new ToolError(`R-ONE 오류(${CODE}): ${MESSAGE}`);
  }
  const body = data && data[svc];
  if (!Array.isArray(body)) throw new ToolError(`R-ONE 응답 형식을 해석할 수 없습니다: ${JSON.stringify(data).slice(0, 200)}`);
  let total = 0, rows = [];
  for (const part of body) {
    if (part.head) {
      for (const h of part.head) {
        if (h.list_total_count !== undefined) total = Number(h.list_total_count);
        if (h.RESULT && h.RESULT.CODE && !/INFO-000/.test(h.RESULT.CODE)) {
          if (/INFO-200/.test(h.RESULT.CODE)) return { total: 0, rows: [] };
          throw new ToolError(`R-ONE 오류(${h.RESULT.CODE}): ${h.RESULT.MESSAGE}`);
        }
      }
    }
    if (part.row) rows = rows.concat(part.row);
  }
  return { total, rows };
}

async function rone(svc, params, key) {
  const qs = new URLSearchParams({ KEY: key, Type: "json", ...params }).toString();
  const { data } = await getJson(`${BASE}/${svc}.do?${qs}`);
  return unwrap(data, svc);
}

const tableCache = new Map();
async function allTables(key) {
  if (tableCache.has(key)) return tableCache.get(key);
  let rows = [];
  for (let p = 1; p <= 5; p++) {
    const r = await rone("SttsApiTbl", { pIndex: p, pSize: 1000 }, key);
    rows = rows.concat(r.rows);
    if (!r.rows.length || rows.length >= r.total) break;
  }
  tableCache.set(key, rows);
  return rows;
}

const CYCLE_NM = { MM: "월", QY: "분기", HY: "반기", YY: "연", WK: "주", DD: "일" };

async function run(name, args, key) {
  if (name === "search_tables") {
    const kws = String(args.keyword || "").split(/\s+/).filter(Boolean).map(norm);
    const rows = (await allTables(key)).filter(r => {
      const nm = norm(r.STATBL_NM);
      return kws.every(k => nm.includes(k));
    });
    if (!rows.length) return `'${args.keyword}' 통계표가 없습니다. 단어를 줄이거나 바꿔 검색해 보세요.`;
    const limit = args.limit || 30;
    const lines = rows.slice(0, limit).map(r => {
      const cyc = r.DTACYCLE_CD ? `${r.DTACYCLE_CD}(${CYCLE_NM[r.DTACYCLE_CD] || ""})` : (r.DTACYCLE_NM || "-");
      const period = r.STRT_WRTTIME || r.START_WRTTIME ? `${r.STRT_WRTTIME || r.START_WRTTIME}~${r.END_WRTTIME || ""}` : "";
      return `${r.STATBL_ID}\t${r.STATBL_NM}\t${cyc}\t${period}`;
    });
    return [`'${args.keyword}' 통계표 ${rows.length}건`, "", "STATBL_ID\t통계표명\t주기\t수록기간", ...lines,
      "", "다음 단계: get_data(statbl_id, cycle, start)로 지역·항목 코드와 수치 확인"].join("\n");
  }

  if (name === "get_data") {
    const params = { STATBL_ID: args.statbl_id, DTACYCLE_CD: args.cycle, START_WRTTIME: args.start, pIndex: 1, pSize: 1000 };
    if (args.end) params.END_WRTTIME = args.end;
    if (args.cls_id) params.CLS_ID = args.cls_id;
    if (args.itm_id) params.ITM_ID = args.itm_id;
    let { total, rows } = await rone("SttsApiTblData", params, key);
    for (let p = 2; rows.length < total && p <= 5; p++) {
      const more = await rone("SttsApiTblData", { ...params, pIndex: p }, key);
      if (!more.rows.length) break;
      rows = rows.concat(more.rows);
    }
    if (args.keyword) {
      const k = norm(args.keyword);
      rows = rows.filter(r => norm(r.CLS_FULLNM || r.CLS_NM).includes(k));
    }
    if (!rows.length) return "조회된 데이터가 없습니다. 통계표ID·주기·기간·코드를 확인하세요.";
    const maxRows = args.max_rows || 300;
    const lines = rows.slice(0, maxRows).map(r =>
      `${r.WRTTIME_DESC || r.WRTTIME_IDTFR_ID || ""}\t${r.CLS_FULLNM || r.CLS_NM || ""}\t${r.CLS_ID || ""}\t${r.ITM_NM || ""}\t${r.ITM_ID || ""}\t${r.DTA_VAL}\t${r.UI_NM || ""}`);
    const title = rows[0].STATBL_NM || args.statbl_id;
    return [`## ${title} (${args.statbl_id}, ${CYCLE_NM[args.cycle] || args.cycle})  ${rows.length}건${rows.length > maxRows ? `, 상위 ${maxRows}건 표시` : ""}`,
      "", "시점\t지역\tCLS_ID\t항목\tITM_ID\t값\t단위", ...lines, "", "출처: 한국부동산원 부동산통계정보시스템(R-ONE)"].join("\n");
  }

  throw new ToolError(`알 수 없는 도구: ${name}`);
}

module.exports = createHandler({
  serverInfo: { name: "rone-mcp", version: "1.0.0" },
  instructions:
    "한국부동산원 R-ONE 부동산통계 조회 서버(가격지수·전세지수·상업용 임대동향·공실률·투자수익률·지가변동률 등). " +
    "search_tables로 STATBL_ID를 찾고, get_data를 짧은 기간으로 먼저 호출해 CLS_ID(지역)·ITM_ID(항목)를 확인한 뒤 좁혀서 조회한다. 인용 시 시점·단위·출처(한국부동산원)를 표기한다.",
  tools: TOOLS,
  keyParam: "rone_key",
  keyHeader: "X-Rone-Key",
  envVar: "RONE_API_KEY",
  run,
});
module.exports._internal = { run, unwrap };
