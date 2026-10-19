// 국토교통부 실거래가 MCP 엔드포인트: POST /api/rtms?data_key=공공데이터포털_인증키
const { createHandler, ToolError, norm } = require("../lib/core");

const BASE = "https://apis.data.go.kr/1613000";
const SERVICES = {
  apt_trade: { path: "RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade", label: "아파트 매매" },
  apt_rent: { path: "RTMSDataSvcAptRent/getRTMSDataSvcAptRent", label: "아파트 전월세" },
  nrg_trade: { path: "RTMSDataSvcNrgTrade/getRTMSDataSvcNrgTrade", label: "상업업무용 매매" },
};

const LAWD_HELP = "lawd_cd: 시군구 5자리 코드(법정동코드 앞 5자리, 예: 11110 서울 종로구, 41190 부천시). 모르면 archhub 커넥터의 find_region으로 sigungu_code를 얻는다.";
const MONTH_HELP = "기간: start_ym~end_ym (YYYYMM, 최대 12개월). end_ym 생략 시 start_ym 한 달.";

const commonProps = {
  lawd_cd: { type: "string", description: "시군구 5자리 코드" },
  start_ym: { type: "string", description: "시작 계약년월 YYYYMM" },
  end_ym: { type: "string", description: "종료 계약년월 YYYYMM (생략 시 start_ym)" },
  dong: { type: "string", description: "법정동명 필터(일부 일치, 예: '상동')" },
  max_rows: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "표시할 최대 거래 수(통계는 전체 기준)" },
};

const TOOLS = [
  {
    name: "apt_trades",
    description: "아파트 매매 실거래가를 조회하고 건수·중위가·㎡당/평당 가격을 요약한다.\n" + LAWD_HELP + "\n" + MONTH_HELP,
    inputSchema: {
      type: "object",
      properties: {
        ...commonProps,
        apt_name: { type: "string", description: "단지명 필터(일부 일치)" },
        min_area: { type: "number", description: "전용면적 하한(㎡)" },
        max_area: { type: "number", description: "전용면적 상한(㎡)" },
      },
      required: ["lawd_cd", "start_ym"],
      additionalProperties: false,
    },
  },
  {
    name: "apt_rents",
    description: "아파트 전월세 실거래를 조회하고 전세 보증금·월세 수준을 요약한다.\n" + LAWD_HELP + "\n" + MONTH_HELP,
    inputSchema: {
      type: "object",
      properties: {
        ...commonProps,
        apt_name: { type: "string" },
        rent_type: { type: "string", enum: ["ALL", "전세", "월세"], default: "ALL" },
        min_area: { type: "number" },
        max_area: { type: "number" },
      },
      required: ["lawd_cd", "start_ym"],
      additionalProperties: false,
    },
  },
  {
    name: "commercial_trades",
    description: "상업업무용 부동산(상가·오피스·근린생활시설 등) 매매 실거래를 조회하고 건물면적·대지면적 기준 단가를 요약한다.\n" + LAWD_HELP + "\n" + MONTH_HELP,
    inputSchema: {
      type: "object",
      properties: {
        ...commonProps,
        building_use: { type: "string", description: "건물주용도 필터(일부 일치, 예: '업무', '판매', '근린')" },
      },
      required: ["lawd_cd", "start_ym"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// XML 파싱 (item 목록만 필요하므로 단순 파서)
// ---------------------------------------------------------------------------
function decodeXml(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
    .trim();
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : "";
}
function parseItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const obj = {};
    const fr = /<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let f;
    while ((f = fr.exec(m[1]))) obj[f[1]] = decodeXml(f[2]);
    items.push(obj);
  }
  return items;
}

function normKey(key) {
  // Decoding 키의 '+'가 주소창에서 공백으로 바뀌는 경우를 되돌리고,
  // 'Encoding' 키(이미 %인코딩)를 넣어도 동작하도록 한 번 디코딩한다.
  key = String(key).trim().replace(/ /g, "+");
  try { return /%[0-9A-Fa-f]{2}/.test(key) ? decodeURIComponent(key) : key; } catch { return key; }
}

async function fetchPage(svc, key, lawd, ym, page) {
  const url = `${BASE}/${svc.path}?serviceKey=${encodeURIComponent(normKey(key))}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&pageNo=${page}&numOfRows=1000`;
  let res;
  try { res = await fetch(url); } catch (e) { throw new ToolError(`공공데이터포털 접속 실패: ${e.message}`); }
  const xml = await res.text();
  const authMsg = tag(xml, "returnAuthMsg") || tag(xml, "errMsg");
  if (authMsg && !/NORMAL/i.test(authMsg)) {
    const code = tag(xml, "returnReasonCode");
    if (/SERVICE_KEY|NOT_REGISTERED/i.test(authMsg)) {
      throw new ToolError(`인증키 오류(${code || "-"}: ${authMsg}). 활용신청 승인 직후라면 1~2시간 뒤 다시 시도하고, 커넥터 주소의 data_key가 Decoding 키인지 확인하세요.`);
    }
    if (/LIMITED_NUMBER/i.test(authMsg)) throw new ToolError("일일 호출 한도를 초과했습니다. 내일 다시 시도하세요.");
    throw new ToolError(`공공데이터포털 오류(${code || "-"}): ${authMsg}`);
  }
  const code = tag(xml, "resultCode");
  if (code && !/^0+$/.test(code)) {
    throw new ToolError(`조회 오류(${code}): ${tag(xml, "resultMsg") || xml.slice(0, 200)}`);
  }
  if (!xml.includes("<response") && !xml.includes("<items")) {
    throw new ToolError(`예상하지 못한 응답(HTTP ${res.status}): ${xml.slice(0, 200)}`);
  }
  return { items: parseItems(xml), total: Number(tag(xml, "totalCount") || 0) };
}

function monthRange(start, end) {
  if (!/^\d{6}$/.test(start || "")) throw new ToolError(`start_ym은 YYYYMM 형식이어야 합니다: "${start}"`);
  end = end || start;
  if (!/^\d{6}$/.test(end)) throw new ToolError(`end_ym은 YYYYMM 형식이어야 합니다: "${end}"`);
  const out = [];
  let y = +start.slice(0, 4), m = +start.slice(4, 6);
  const ey = +end.slice(0, 4), em = +end.slice(4, 6);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
    if (out.length > 12) throw new ToolError("한 번에 최대 12개월까지 조회할 수 있습니다. 기간을 나눠 주세요.");
  }
  if (!out.length) throw new ToolError("start_ym이 end_ym보다 늦습니다.");
  return out;
}

async function collect(svcKey, key, lawd, months) {
  if (!/^\d{5}$/.test(String(lawd || ""))) throw new ToolError(`lawd_cd는 5자리 숫자여야 합니다: "${lawd}". ${LAWD_HELP}`);
  const svc = SERVICES[svcKey];
  const all = [];
  for (const ym of months) {
    let page = 1;
    for (;;) {
      const { items, total } = await fetchPage(svc, key, lawd, ym, page);
      all.push(...items);
      if (!items.length || page * 1000 >= total || page >= 10) break;
      page++;
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// 계산 도우미
// ---------------------------------------------------------------------------
const toNum = v => { const n = Number(String(v == null ? "" : v).replace(/[,\s]/g, "")); return Number.isFinite(n) ? n : NaN; };
const PYEONG = 3.305785;
function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const h = Math.floor(a.length / 2);
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}
function mean(arr) { const a = arr.filter(Number.isFinite); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }
const fmt = (n, d = 0) => Number.isFinite(n) ? n.toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: 0 }) : "-";
const ymd = r => `${r.dealYear || ""}${String(r.dealMonth || "").padStart(2, "0")}${String(r.dealDay || "").padStart(2, "0")}`;
const isCancelled = r => (r.cdealType || "").trim() === "O";

function areaFilter(rows, field, min, max) {
  return rows.filter(r => {
    const a = toNum(r[field]);
    if (Number.isFinite(min) && !(a >= min)) return false;
    if (Number.isFinite(max) && !(a <= max)) return false;
    return true;
  });
}

function footer(months, cancelledCount) {
  const lines = ["", `대상 계약월: ${months[0]}~${months[months.length - 1]}`];
  if (cancelledCount) lines.push(`해제(취소)된 거래 ${cancelledCount}건은 통계에서 제외했습니다.`);
  lines.push("출처: 국토교통부 실거래가 공개시스템(공공데이터포털). 금액 단위 만원.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
async function run(name, args, key) {
  const months = monthRange(args.start_ym, args.end_ym);
  const maxRows = args.max_rows || 100;
  const dongF = r => !args.dong || norm(r.umdNm).includes(norm(args.dong));

  if (name === "apt_trades") {
    let rows = (await collect("apt_trade", key, args.lawd_cd, months)).filter(dongF);
    if (args.apt_name) rows = rows.filter(r => norm(r.aptNm).includes(norm(args.apt_name)));
    rows = areaFilter(rows, "excluUseAr", args.min_area, args.max_area);
    if (!rows.length) return "조건에 맞는 거래가 없습니다." + footer(months, 0);
    const cancelled = rows.filter(isCancelled);
    const valid = rows.filter(r => !isCancelled(r));
    const price = valid.map(r => toNum(r.dealAmount));
    const perM2 = valid.map(r => toNum(r.dealAmount) / toNum(r.excluUseAr));
    rows.sort((a, b) => ymd(b).localeCompare(ymd(a)));
    const lines = rows.slice(0, maxRows).map(r =>
      `${ymd(r)}\t${r.umdNm}\t${r.aptNm}\t${fmt(toNum(r.excluUseAr), 2)}\t${r.floor || ""}\t${fmt(toNum(r.dealAmount))}\t${fmt(toNum(r.dealAmount) / toNum(r.excluUseAr) * PYEONG)}\t${r.buildYear || ""}\t${r.dealingGbn || ""}${isCancelled(r) ? "\t해제" : ""}`);
    return [
      `## 아파트 매매 실거래 (${args.lawd_cd}${args.dong ? ` ${args.dong}` : ""}${args.apt_name ? ` · ${args.apt_name}` : ""})`,
      `유효 ${valid.length}건 · 중위 거래가 ${fmt(median(price))}만원 · 평균 ${fmt(mean(price))}만원`,
      `전용 ㎡당 중위 ${fmt(median(perM2), 1)}만원 · 평당(전용) 중위 ${fmt(median(perM2) * PYEONG)}만원`,
      "", `계약일\t법정동\t단지\t전용(㎡)\t층\t거래금액\t평당(전용)\t건축년도\t거래유형${rows.length > maxRows ? `\t(최근 ${maxRows}건 표시)` : ""}`,
      ...lines, footer(months, cancelled.length),
    ].join("\n");
  }

  if (name === "apt_rents") {
    let rows = (await collect("apt_rent", key, args.lawd_cd, months)).filter(dongF);
    if (args.apt_name) rows = rows.filter(r => norm(r.aptNm).includes(norm(args.apt_name)));
    rows = areaFilter(rows, "excluUseAr", args.min_area, args.max_area);
    const isJeonse = r => toNum(r.monthlyRent) === 0;
    if (args.rent_type === "전세") rows = rows.filter(isJeonse);
    if (args.rent_type === "월세") rows = rows.filter(r => !isJeonse(r));
    if (!rows.length) return "조건에 맞는 거래가 없습니다." + footer(months, 0);
    const jeonse = rows.filter(isJeonse), wolse = rows.filter(r => !isJeonse(r));
    rows.sort((a, b) => ymd(b).localeCompare(ymd(a)));
    const lines = rows.slice(0, maxRows).map(r =>
      `${ymd(r)}\t${r.umdNm}\t${r.aptNm}\t${fmt(toNum(r.excluUseAr), 2)}\t${r.floor || ""}\t${isJeonse(r) ? "전세" : "월세"}\t${fmt(toNum(r.deposit))}\t${fmt(toNum(r.monthlyRent))}\t${r.contractType || ""}\t${r.contractTerm || ""}`);
    return [
      `## 아파트 전월세 실거래 (${args.lawd_cd}${args.dong ? ` ${args.dong}` : ""}${args.apt_name ? ` · ${args.apt_name}` : ""})`,
      `전세 ${jeonse.length}건 · 보증금 중위 ${fmt(median(jeonse.map(r => toNum(r.deposit))))}만원 · 전용㎡당 ${fmt(median(jeonse.map(r => toNum(r.deposit) / toNum(r.excluUseAr))), 1)}만원`,
      `월세 ${wolse.length}건 · 보증금 중위 ${fmt(median(wolse.map(r => toNum(r.deposit))))}만원 · 월세 중위 ${fmt(median(wolse.map(r => toNum(r.monthlyRent))))}만원`,
      "", `계약일\t법정동\t단지\t전용(㎡)\t층\t구분\t보증금\t월세\t계약구분\t계약기간${rows.length > maxRows ? `\t(최근 ${maxRows}건 표시)` : ""}`,
      ...lines, footer(months, 0),
    ].join("\n");
  }

  if (name === "commercial_trades") {
    let rows = (await collect("nrg_trade", key, args.lawd_cd, months)).filter(dongF);
    if (args.building_use) rows = rows.filter(r => norm(r.buildingUse).includes(norm(args.building_use)));
    if (!rows.length) return "조건에 맞는 거래가 없습니다." + footer(months, 0);
    const cancelled = rows.filter(isCancelled);
    const valid = rows.filter(r => !isCancelled(r));
    const perBld = valid.map(r => toNum(r.dealAmount) / toNum(r.buildingAr));
    const perLand = valid.map(r => toNum(r.dealAmount) / toNum(r.plottageAr));
    rows.sort((a, b) => ymd(b).localeCompare(ymd(a)));
    const lines = rows.slice(0, maxRows).map(r =>
      `${ymd(r)}\t${r.umdNm}\t${r.jibun || ""}\t${r.buildingType || ""}\t${r.buildingUse || ""}\t${r.landUse || ""}\t${fmt(toNum(r.buildingAr), 2)}\t${fmt(toNum(r.plottageAr), 2)}\t${r.floor || ""}\t${fmt(toNum(r.dealAmount))}\t${fmt(toNum(r.dealAmount) / toNum(r.buildingAr) * PYEONG)}\t${r.buildYear || ""}\t${r.shareDealingType || ""}${isCancelled(r) ? "\t해제" : ""}`);
    return [
      `## 상업업무용 부동산 매매 실거래 (${args.lawd_cd}${args.dong ? ` ${args.dong}` : ""}${args.building_use ? ` · ${args.building_use}` : ""})`,
      `유효 ${valid.length}건 · 중위 거래가 ${fmt(median(valid.map(r => toNum(r.dealAmount))))}만원`,
      `건물면적 평당 중위 ${fmt(median(perBld) * PYEONG)}만원 · 대지면적 평당 중위 ${fmt(median(perLand) * PYEONG)}만원`,
      "", `계약일\t법정동\t지번\t유형\t건물주용도\t용도지역\t건물면적(㎡)\t대지면적(㎡)\t층\t거래금액\t건물평당\t건축년도\t지분거래${rows.length > maxRows ? `\t(최근 ${maxRows}건 표시)` : ""}`,
      ...lines, footer(months, cancelled.length),
    ].join("\n");
  }

  throw new ToolError(`알 수 없는 도구: ${name}`);
}

module.exports = createHandler({
  serverInfo: { name: "rtms-mcp", version: "1.0.0" },
  instructions:
    "국토교통부 실거래가 조회 서버(아파트 매매·아파트 전월세·상업업무용 매매). lawd_cd(시군구 5자리)는 archhub의 find_region sigungu_code를 쓴다. " +
    "금액 단위는 만원이며, 해제된 거래는 통계에서 제외된다. 인용 시 계약월·지역·출처(국토교통부 실거래가)를 표기한다.",
  tools: TOOLS,
  keyParam: "data_key",
  keyHeader: "X-Data-Key",
  envVar: "DATA_GO_KR_KEY",
  run,
});
module.exports._internal = { run, parseItems, monthRange };
