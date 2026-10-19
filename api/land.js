// 개별공시지가·토지특성 MCP (브이월드): POST /api/land?vworld_key=브이월드_인증키
const { createHandler, ToolError, getJson } = require("../lib/core");

const BASE = "https://api.vworld.kr/ned/data";

const PARCEL_PROPS = {
  pnu: { type: "string", description: "필지고유번호 19자리 (있으면 아래 항목 불필요)" },
  sigungu_code: { type: "string", description: "시군구 5자리 (archhub find_region의 sigungu_code)" },
  bdong_code: { type: "string", description: "법정동 5자리 (archhub find_region의 bdong_code)" },
  bun: { type: "string", description: "본번" },
  ji: { type: "string", description: "부번(없으면 생략)" },
  san: { type: "boolean", description: "산 번지 여부", default: false },
};

const TOOLS = [
  {
    name: "land_price",
    description:
      "필지의 개별공시지가(원/㎡)를 연도별로 조회한다. year 생략 시 수록된 전 연도 추이와 연평균상승률을 보여준다.\n" +
      "필지는 pnu 또는 (sigungu_code, bdong_code, bun, ji)로 지정. 코드는 archhub의 find_region으로 얻는다.",
    inputSchema: {
      type: "object",
      properties: { ...PARCEL_PROPS, year: { type: "string", description: "기준연도 YYYY(선택)" } },
      additionalProperties: false,
    },
  },
  {
    name: "land_characteristics",
    description:
      "필지의 토지특성(지목·면적·용도지역·이용상황·지형높이·지형형상·도로접면)과 해당연도 공시지가를 조회한다. 토지 평가·실사의 기초자료.",
    inputSchema: {
      type: "object",
      properties: { ...PARCEL_PROPS, year: { type: "string", description: "기준연도 YYYY(생략 시 최신)" } },
      additionalProperties: false,
    },
  },
];

function toPnu(a) {
  if (a.pnu) {
    const p = String(a.pnu).replace(/\D/g, "");
    if (p.length !== 19) throw new ToolError(`pnu는 19자리여야 합니다: ${a.pnu}`);
    return p;
  }
  const sg = String(a.sigungu_code || ""), bd = String(a.bdong_code || "");
  if (!/^\d{5}$/.test(sg) || !/^\d{5}$/.test(bd) || !a.bun) {
    throw new ToolError("pnu 또는 sigungu_code(5자리)·bdong_code(5자리)·bun(본번)이 필요합니다. archhub의 find_region으로 코드를 먼저 찾으세요.");
  }
  const bun = String(a.bun).replace(/\D/g, ""), ji = String(a.ji || "0").replace(/\D/g, "") || "0";
  if (bun.length > 4 || ji.length > 4) throw new ToolError("본번·부번은 4자리 이하 숫자여야 합니다.");
  return `${sg}${bd}${a.san ? "2" : "1"}${bun.padStart(4, "0")}${ji.padStart(4, "0")}`;
}

function domain() {
  const h = process.env.VWORLD_DOMAIN || process.env.VERCEL_PROJECT_PRODUCTION_URL || "ecos-mcp.vercel.app";
  return /^https?:\/\//.test(h) ? h : `https://${h}`;
}

async function vworld(service, params, key) {
  const qs = new URLSearchParams({ key, domain: domain(), format: "json", numOfRows: "100", pageNo: "1", ...params }).toString();
  const { data } = await getJson(`${BASE}/${service}?${qs}`);
  // 오류 형식: { response: { status: "ERROR", error: { code, text } } } 또는 resultCode
  const errBlock = data && data.response && data.response.status === "ERROR" ? data.response.error : null;
  if (errBlock) {
    if (/KEY|DOMAIN/i.test(errBlock.code || "")) {
      throw new ToolError(`브이월드 인증 오류(${errBlock.code}): ${errBlock.text || ""} — 인증키와 키 발급 시 등록한 서비스 URL(${domain()})이 일치하는지 확인하세요.`);
    }
    throw new ToolError(`브이월드 오류(${errBlock.code}): ${errBlock.text || ""}`);
  }
  const box = data && Object.values(data).find(v => v && typeof v === "object" && ("field" in v || "resultCode" in v || "totalCount" in v));
  if (!box) throw new ToolError(`브이월드 응답을 해석할 수 없습니다: ${JSON.stringify(data).slice(0, 200)}`);
  if (box.resultCode && !/^(0+|OK|INFO-0+)$/i.test(String(box.resultCode))) {
    if (/NODATA|INFO-200|NOT_FOUND/i.test(String(box.resultCode)) || /없/.test(box.resultMsg || "")) return [];
    throw new ToolError(`브이월드 오류(${box.resultCode}): ${box.resultMsg || ""}`);
  }
  const f = box.field;
  return Array.isArray(f) ? f : f ? [f] : [];
}

const num = v => { const n = Number(String(v == null ? "" : v).replace(/,/g, "")); return Number.isFinite(n) ? n : NaN; };
const won = v => Number.isFinite(num(v)) ? num(v).toLocaleString("ko-KR") : "-";
const parcelLabel = r => `${r.ldCodeNm || ""} ${r.mnnmSlno || ""}`.trim();

async function run(name, args, key) {
  const pnu = toPnu(args);

  if (name === "land_price") {
    const params = { pnu };
    if (args.year) params.stdrYear = String(args.year);
    let rows = await vworld("getIndvdLandPriceAttr", params, key);
    if (!rows.length) return `개별공시지가 자료가 없습니다 (PNU ${pnu}${args.year ? `, ${args.year}년` : ""}). 번지·산 여부를 확인하세요.`;
    // 같은 연도에 여러 건이 있으면 공시일자가 가장 늦은 1건만 남긴다.
    const byYear = new Map();
    for (const r of rows) {
      const k = String(r.stdrYear);
      const cur = byYear.get(k);
      if (!cur || String(r.pblntfDe || "") + String(r.stdrMt || "") >= String(cur.pblntfDe || "") + String(cur.stdrMt || "")) byYear.set(k, r);
    }
    rows = [...byYear.values()].sort((a, b) => String(a.stdrYear).localeCompare(String(b.stdrYear)));
    const lines = rows.map((r, i) => {
      const prev = i ? num(rows[i - 1].pblntfPclnd) : NaN;
      const chg = Number.isFinite(prev) && prev ? ((num(r.pblntfPclnd) / prev - 1) * 100).toFixed(2) + "%" : "-";
      return `${r.stdrYear}\t${won(r.pblntfPclnd)}\t${chg}\t${r.pblntfDe || ""}\t${r.stdLandAt === "Y" ? "표준지" : ""}`;
    });
    const out = [`## 개별공시지가 — ${parcelLabel(rows[0])} (PNU ${pnu})`, "", "기준연도\t공시지가(원/㎡)\t전년대비\t공시일자\t비고", ...lines];
    if (rows.length >= 2) {
      const first = rows[0], last = rows[rows.length - 1];
      const yrs = num(last.stdrYear) - num(first.stdrYear);
      if (yrs > 0) {
        const cagr = (Math.pow(num(last.pblntfPclnd) / num(first.pblntfPclnd), 1 / yrs) - 1) * 100;
        out.push("", `${first.stdrYear}→${last.stdrYear} 연평균상승률(CAGR): ${cagr.toFixed(2)}%`);
      }
    }
    out.push("", "출처: 국토교통부 개별공시지가(브이월드 공간정보오픈플랫폼)");
    return out.join("\n");
  }

  if (name === "land_characteristics") {
    const params = { pnu };
    if (args.year) params.stdrYear = String(args.year);
    let rows = await vworld("getLandCharacteristics", params, key);
    if (!rows.length) return `토지특성 자료가 없습니다 (PNU ${pnu}).`;
    rows = rows.slice().sort((a, b) => String(b.stdrYear).localeCompare(String(a.stdrYear)));
    const r = rows[0];
    const area = num(r.lndpclAr);
    const price = num(r.pblntfPclnd);
    const items = [
      ["소재지", parcelLabel(r)],
      ["기준연도", r.stdrYear],
      ["지목", r.lndcgrCodeNm],
      ["면적(㎡)", Number.isFinite(area) ? area.toLocaleString("ko-KR") : r.lndpclAr],
      ["용도지역1", r.prposArea1Nm],
      ["용도지역2", r.prposArea2Nm],
      ["토지이용상황", r.ladUseSittnNm],
      ["지형높이", r.tpgrphHgCodeNm],
      ["지형형상", r.tpgrphFrmCodeNm],
      ["도로접면", r.roadSideCodeNm],
      ["공시지가(원/㎡)", won(r.pblntfPclnd)],
      ["공시지가×면적(원)", Number.isFinite(area * price) ? Math.round(area * price).toLocaleString("ko-KR") : "-"],
    ].filter(([, v]) => v !== undefined && v !== null && v !== "");
    const known = new Set(["pnu", "ldCode", "ldCodeNm", "regstrSeCode", "regstrSeCodeNm", "mnnmSlno", "stdrYear", "stdrMt", "lndcgrCode", "lndcgrCodeNm",
      "lndpclAr", "prposArea1", "prposArea1Nm", "prposArea2", "prposArea2Nm", "ladUseSittn", "ladUseSittnNm", "tpgrphHgCode", "tpgrphHgCodeNm",
      "tpgrphFrmCode", "tpgrphFrmCodeNm", "roadSideCode", "roadSideCodeNm", "pblntfPclnd", "lastUpdtDt"]);
    const extra = Object.entries(r).filter(([k, v]) => !known.has(k) && v !== "" && v != null).map(([k, v]) => [k, v]);
    return [`## 토지특성 — ${parcelLabel(r)} (PNU ${pnu})`, "",
      ...items.map(([k, v]) => `- ${k}: ${v}`),
      ...(extra.length ? ["", "기타 항목:", ...extra.map(([k, v]) => `- ${k}: ${v}`)] : []),
      "", "출처: 국토교통부 토지특성정보(브이월드 공간정보오픈플랫폼)"].join("\n");
  }

  throw new ToolError(`알 수 없는 도구: ${name}`);
}

module.exports = createHandler({
  serverInfo: { name: "land-mcp", version: "1.0.0" },
  instructions:
    "개별공시지가·토지특성 조회 서버(브이월드). 필지는 pnu 19자리 또는 archhub find_region의 sigungu_code·bdong_code와 본번·부번으로 지정한다. " +
    "land_price는 연도별 추이와 CAGR, land_characteristics는 지목·면적·용도지역·이용상황 등을 준다. 인용 시 기준연도와 출처(국토교통부)를 표기한다.",
  tools: TOOLS,
  keyParam: "vworld_key",
  keyHeader: "X-Vworld-Key",
  envVar: "VWORLD_API_KEY",
  run,
});
module.exports._internal = { run, toPnu };
