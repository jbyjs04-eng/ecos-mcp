// 통계청 KOSIS MCP 엔드포인트: POST /api/kosis?kosis_key=본인인증키
const { createHandler, ToolError, norm, getJson } = require("../lib/core");

const BASE = "https://kosis.kr/openapi";

const PRD_HELP = "주기(prdSe): Y=연(YYYY), H=반기(YYYY01~02), Q=분기(YYYY01~04), M=월(YYYYMM), D=일(YYYYMMDD), IR=부정기, F=다년";

const TOOLS = [
  {
    name: "search_tables",
    description: "KOSIS 통계표를 키워드로 검색해 기관ID(orgId)·통계표ID(tblId)를 찾는다. 예: '소비자물가지수 품목별', '주택임대료', '광업제조업동향', '임금'.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
  {
    name: "get_table_meta",
    description:
      "통계표의 분류(objL1~8)·항목(itmId) 코드와 이름, 수록주기·기간을 확인한다. get_data 호출 전에 반드시 확인.\n" +
      "keyword로 분류값·항목명을 좁힐 수 있다(예: '서울', '전월세').",
    inputSchema: {
      type: "object",
      properties: {
        org_id: { type: "string", description: "기관ID (예: 101=통계청)" },
        tbl_id: { type: "string", description: "통계표ID (예: DT_1J22003)" },
        keyword: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 150 },
      },
      required: ["org_id", "tbl_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_data",
    description:
      "KOSIS 통계 수치를 조회한다. 코드는 get_table_meta에서 확인. 여러 값은 배열로, 전체는 'ALL'.\n" +
      "기간은 start/end 또는 recent(최근 n개 시점) 중 하나. " + PRD_HELP + ".\n" +
      "한 번에 최대 4만 셀이므로 ALL 남용을 피하고 필요한 분류만 지정할 것.",
    inputSchema: {
      type: "object",
      properties: {
        org_id: { type: "string" },
        tbl_id: { type: "string" },
        itm_id: { description: "항목ID 또는 배열 또는 'ALL'", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        obj_l1: { description: "분류1 코드(배열/ALL 가능)", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        obj_l2: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        obj_l3: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        obj_l4: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        prd_se: { type: "string", enum: ["Y", "H", "Q", "M", "D", "IR", "F"] },
        start: { type: "string" },
        end: { type: "string" },
        recent: { type: "integer", minimum: 1, maximum: 120, description: "최근 n개 시점 (start/end 대신)" },
        max_rows: { type: "integer", minimum: 1, maximum: 3000, default: 600 },
      },
      required: ["org_id", "tbl_id", "itm_id", "obj_l1", "prd_se"],
      additionalProperties: false,
    },
  },
];

function joinCodes(v) {
  if (v === undefined || v === null || v === "") return "";
  const arr = Array.isArray(v) ? v : String(v).split(/[+,\s]+/).filter(Boolean);
  if (arr.length === 1 && arr[0].toUpperCase() === "ALL") return "ALL";
  return arr.join("+") + "+";
}

// KOSIS는 '+'를 구분자로 그대로 받으므로 직접 쿼리를 만든다.
function buildUrl(path, params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v).split("+").map(encodeURIComponent).join("+")}`)
    .join("&");
  return `${BASE}/${path}?${qs}`;
}

async function kosis(path, params) {
  const { data } = await getJson(buildUrl(path, { ...params, format: "json", jsonVD: "Y" }));
  if (data && !Array.isArray(data) && (data.err || data.errMsg)) {
    const code = String(data.err || "");
    if (code === "30") return [];
    if (code === "10" || code === "11") throw new ToolError(`KOSIS 인증키 오류(${code}): ${data.errMsg} — 커넥터 주소의 kosis_key 값을 확인하세요.`);
    if (code === "31") throw new ToolError(`KOSIS: 조회 결과가 4만 셀을 넘습니다. 분류·항목·기간을 좁혀 주세요. (${data.errMsg})`);
    throw new ToolError(`KOSIS 오류(${code}): ${data.errMsg}`);
  }
  return Array.isArray(data) ? data : [];
}

async function run(name, args, key) {
  switch (name) {
    case "search_tables": {
      const limit = args.limit || 20;
      const rows = await kosis("statisticsSearch.do", {
        method: "getList", apiKey: key, searchNm: args.keyword, sort: "RANK", startCount: 1, resultCount: limit,
      });
      if (!rows.length) return `'${args.keyword}' 검색 결과가 없습니다. 다른 표현으로 검색해 보세요.`;
      const lines = rows.map(r =>
        `${r.ORG_ID}\t${r.TBL_ID}\t${r.TBL_NM}\t${r.ORG_NM || ""}\t${r.STRT_PRD_DE || "?"}~${r.END_PRD_DE || "?"}`);
      return [`'${args.keyword}' 통계표 ${rows.length}건`, "", "orgId\ttblId\t통계표명\t작성기관\t수록기간", ...lines,
        "", "다음 단계: get_table_meta(org_id, tbl_id)로 분류·항목 코드 확인"].join("\n");
    }

    case "get_table_meta": {
      const base = { method: "getMeta", apiKey: key, orgId: args.org_id, tblId: args.tbl_id };
      const [tbl, itm, prd] = await Promise.all([
        kosis("statisticsData.do", { ...base, type: "TBL" }).catch(() => []),
        kosis("statisticsData.do", { ...base, type: "ITM" }),
        kosis("statisticsData.do", { ...base, type: "PRD" }).catch(() => []),
      ]);
      if (!itm.length) return `통계표 메타정보가 없습니다 (${args.org_id}/${args.tbl_id}). ID를 확인하세요.`;
      const title = tbl[0] ? (tbl[0].TBL_NM || "") : "";
      const kw = args.keyword ? norm(args.keyword) : "";
      const limit = args.limit || 150;

      // OBJ_ID별 묶기 (ITEM = 항목, 그 외 = 분류)
      const groups = new Map();
      for (const r of itm) {
        const k = r.OBJ_ID;
        if (!groups.has(k)) groups.set(k, { name: r.OBJ_NM, sn: Number(r.OBJ_ID_SN || 0), rows: [] });
        groups.get(k).rows.push(r);
      }
      const ordered = [...groups.entries()].sort((a, b) => a[1].sn - b[1].sn);
      const out = [`## ${title} (${args.org_id}/${args.tbl_id})`];
      if (prd.length) {
        out.push("수록주기·기간: " + prd.map(p => `${p.PRD_SE}(${p.PRD_DE || `${p.STRT_PRD_DE || "?"}~${p.END_PRD_DE || "?"}`})`).join(", "));
      }
      let shown = 0;
      let lvl = 0;
      for (const [objId, g] of ordered) {
        const isItem = objId === "ITEM" || objId === "13999001";
        const label = isItem ? "항목 → itm_id" : `분류${++lvl} → obj_l${lvl}`;
        const rows = kw ? g.rows.filter(r => norm(r.ITM_NM).includes(kw)) : g.rows;
        out.push("", `### ${g.name} [${label}] (${g.rows.length}개${kw ? `, '${args.keyword}' 일치 ${rows.length}개` : ""})`);
        for (const r of rows) {
          if (shown >= limit) break;
          out.push(`${r.ITM_ID}\t${r.ITM_NM}${r.UP_ITM_ID ? `\t(상위 ${r.UP_ITM_ID})` : ""}${r.UNIT_NM ? `\t[${r.UNIT_NM}]` : ""}`);
          shown++;
        }
      }
      if (shown >= limit) out.push("", `… 표시 한도(${limit}) 도달. keyword로 좁혀 보세요.`);
      return out.join("\n");
    }

    case "get_data": {
      const params = {
        method: "getList", apiKey: key, orgId: args.org_id, tblId: args.tbl_id,
        itmId: joinCodes(args.itm_id), objL1: joinCodes(args.obj_l1),
        objL2: joinCodes(args.obj_l2), objL3: joinCodes(args.obj_l3), objL4: joinCodes(args.obj_l4),
        objL5: "", objL6: "", objL7: "", objL8: "",
        prdSe: args.prd_se,
      };
      if (args.recent) params.newEstPrdCnt = args.recent;
      else if (args.start || args.end) {
        params.startPrdDe = args.start || args.end;
        params.endPrdDe = args.end || args.start;
      } else params.newEstPrdCnt = 12;

      const rows = await kosis("Param/statisticsParameterData.do", params);
      if (!rows.length) return "조회된 데이터가 없습니다. 코드·주기·기간을 확인하세요.";
      const maxRows = args.max_rows || 600;
      const lines = rows.slice(0, maxRows).map(r => {
        const cls = [r.C1_NM, r.C2_NM, r.C3_NM, r.C4_NM].filter(Boolean).join(" / ");
        return `${r.PRD_DE}\t${cls}\t${r.ITM_NM}\t${r.DT}\t${r.UNIT_NM || ""}`;
      });
      return [
        `## ${rows[0].TBL_NM} (${args.org_id}/${args.tbl_id})  ${rows.length}건${rows.length > maxRows ? `, 상위 ${maxRows}건 표시` : ""}`,
        "", "시점\t분류\t항목\t값\t단위", ...lines,
        "", `출처: 통계청 KOSIS 국가통계포털 (최종수정 ${rows[0].LST_CHN_DE || "-"})`,
      ].join("\n");
    }

    default:
      throw new ToolError(`알 수 없는 도구: ${name}`);
  }
}

module.exports = createHandler({
  serverInfo: { name: "kosis-mcp", version: "1.0.0" },
  instructions:
    "통계청 KOSIS 국가통계포털 조회 서버. search_tables로 orgId/tblId를 찾고, get_table_meta로 분류(obj_l1..)·항목(itm_id) 코드를 확인한 뒤 get_data로 수치를 받는다. " +
    "기준금리·국고채·환율·CPI 총지수는 ECOS가 더 간단하다. 값 인용 시 시점·단위·출처(통계청 KOSIS)를 표기한다.",
  tools: TOOLS,
  keyParam: "kosis_key",
  keyHeader: "X-Kosis-Key",
  envVar: "KOSIS_API_KEY",
  run,
});
module.exports._internal = { run, joinCodes, buildUrl };
