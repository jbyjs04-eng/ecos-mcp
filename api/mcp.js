// 한국은행 ECOS MCP 서버 (Vercel 서버리스, 외부 의존성 없음)
// 엔드포인트: POST /api/mcp?ecos_key=본인인증키   (Streamable HTTP, JSON 응답)

const ECOS_BASE = "https://ecos.bok.or.kr/api";
const SERVER_INFO = { name: "ecos-mcp", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// ---------------------------------------------------------------------------
// 자주 쓰는 지표 프리셋: 통계표 코드 + 항목명(키워드)으로 정의하고,
// 항목코드는 실행 시 ECOS 항목목록에서 이름으로 찾아 쓴다(코드 오기 방지).
// ---------------------------------------------------------------------------
const PRESETS = {
  base_rate:      { label: "한국은행 기준금리", tables: { D: "722Y001", M: "722Y001" }, item: "한국은행기준금리" },
  call_rate:      { label: "콜금리(1일)",        tables: { D: "817Y002", M: "721Y001" }, item: "콜금리(1일" },
  cd_91d:         { label: "CD(91일)",           tables: { D: "817Y002", M: "721Y001" }, item: "CD(91일)" },
  ktb_1y:         { label: "국고채(1년)",        tables: { D: "817Y002", M: "721Y001" }, item: "국고채(1년)" },
  ktb_3y:         { label: "국고채(3년)",        tables: { D: "817Y002", M: "721Y001" }, item: "국고채(3년)" },
  ktb_5y:         { label: "국고채(5년)",        tables: { D: "817Y002", M: "721Y001" }, item: "국고채(5년)" },
  ktb_10y:        { label: "국고채(10년)",       tables: { D: "817Y002", M: "721Y001" }, item: "국고채(10년)" },
  ktb_20y:        { label: "국고채(20년)",       tables: { D: "817Y002", M: "721Y001" }, item: "국고채(20년)" },
  ktb_30y:        { label: "국고채(30년)",       tables: { D: "817Y002", M: "721Y001" }, item: "국고채(30년)" },
  corp_aa_3y:     { label: "회사채(3년, AA-)",   tables: { D: "817Y002", M: "721Y001" }, item: "회사채(3년,AA-)" },
  corp_bbb_3y:    { label: "회사채(3년, BBB-)",  tables: { D: "817Y002", M: "721Y001" }, item: "회사채(3년,BBB-)" },
  usd_krw:        { label: "원/미국달러(매매기준율)", tables: { D: "731Y001" }, item: "원/미국달러(매매기준율)" },
  eur_krw:        { label: "원/유로",            tables: { D: "731Y001" }, item: "원/유로" },
  jpy100_krw:     { label: "원/일본엔(100엔)",   tables: { D: "731Y001" }, item: "원/일본엔(100엔)" },
  cny_krw:        { label: "원/위안(매매기준율)", tables: { D: "731Y001" }, item: "원/위안(매매기준율)" },
  cpi:            { label: "소비자물가지수(총지수)", tables: { M: "901Y009" }, item: "총지수", exact: true },
};
const PRESET_KEYS = Object.keys(PRESETS);

// ---------------------------------------------------------------------------
// 도구 정의
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "get_indicator",
    description:
      "자주 쓰는 지표를 이름만으로 조회한다(기간 시계열). 할인율·이자율 근거, 외화환산, 물가상승률 가정에 사용.\n" +
      "indicator 값: " + PRESET_KEYS.map(k => `${k}(${PRESETS[k].label})`).join(", ") + ".\n" +
      "cycle: D(일)·M(월). 환율은 D만, CPI는 M만. 날짜는 D=YYYYMMDD, M=YYYYMM. 생략 시 D는 최근 30일, M은 최근 24개월.",
    inputSchema: {
      type: "object",
      properties: {
        indicator: { type: "string", enum: PRESET_KEYS },
        cycle: { type: "string", enum: ["D", "M"], description: "기본: 일별 지원 시 D, 아니면 M" },
        start: { type: "string", description: "시작일(D: YYYYMMDD, M: YYYYMM)" },
        end: { type: "string", description: "종료일(D: YYYYMMDD, M: YYYYMM)" },
      },
      required: ["indicator"],
      additionalProperties: false,
    },
  },
  {
    name: "rates_as_of",
    description:
      "평가기준일 등 특정 날짜 현재의 지표값을 한 번에 조회한다. 그날이 휴일이면 직전 영업일 값을 쓰고 실제 적용일을 함께 표시한다.\n" +
      "indicators 생략 시 기준금리·국고채 3/5/10년·회사채 AA-/BBB- 3년·원/달러를 조회.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "기준일 YYYYMMDD (예: 20251231)" },
        indicators: { type: "array", items: { type: "string", enum: PRESET_KEYS.filter(k => PRESETS[k].tables.D) } },
      },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: "search_statistics",
    description:
      "ECOS 통계를 통계표코드·항목코드로 직접 조회한다(고급). 코드는 search_tables → list_items 로 찾는다.\n" +
      "cycle: A(연) S(반기) Q(분기) M(월) SM(반월) D(일). 날짜 형식: A=YYYY, S=YYYYS1, Q=YYYYQ1, M=YYYYMM, SM=YYYYMMS1, D=YYYYMMDD.",
    inputSchema: {
      type: "object",
      properties: {
        stat_code: { type: "string", description: "통계표코드 (예: 817Y002)" },
        cycle: { type: "string", enum: ["A", "S", "Q", "M", "SM", "D"] },
        start: { type: "string" },
        end: { type: "string" },
        item_code1: { type: "string" },
        item_code2: { type: "string" },
        item_code3: { type: "string" },
        item_code4: { type: "string" },
        max_rows: { type: "integer", minimum: 1, maximum: 5000, default: 500 },
      },
      required: ["stat_code", "cycle", "start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "search_tables",
    description: "통계표 이름 키워드로 통계표코드를 찾는다 (예: '시장금리', '환율', '생산자물가', '주택매매가격').",
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
    name: "list_items",
    description: "통계표의 항목코드·항목명·주기·수록기간·단위를 나열한다. keyword로 항목명을 좁힐 수 있다.",
    inputSchema: {
      type: "object",
      properties: {
        stat_code: { type: "string" },
        keyword: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      required: ["stat_code"],
      additionalProperties: false,
    },
  },
  {
    name: "key_statistics",
    description: "한국은행 100대 통계지표(최신값)를 조회한다. keyword로 지표명을 좁힐 수 있다.",
    inputSchema: {
      type: "object",
      properties: { keyword: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "search_word",
    description: "ECOS 통계용어사전에서 용어 정의를 찾는다 (예: '기준금리', 'GDP 디플레이터').",
    inputSchema: {
      type: "object",
      properties: { word: { type: "string" } },
      required: ["word"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
class ToolError extends Error {}

const norm = s => String(s || "").replace(/\s+/g, "").toLowerCase();

function kstToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function ymdToDate(ymd) {
  return new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
}
function dateToYmd(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
function addDays(ymd, n) {
  const d = ymdToDate(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return dateToYmd(d);
}
function addMonths(ym, n) {
  const y = +ym.slice(0, 4), m = +ym.slice(4, 6) - 1 + n;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12 + 1;
  return `${yy}${String(mm).padStart(2, "0")}`;
}

const DATE_PATTERNS = {
  A: /^\d{4}$/, S: /^\d{4}S[12]$/, Q: /^\d{4}Q[1-4]$/,
  M: /^\d{6}$/, SM: /^\d{6}S[12]$/, D: /^\d{8}$/,
};
function checkDate(cycle, v, label) {
  if (!DATE_PATTERNS[cycle].test(v)) {
    throw new ToolError(`${label} 형식이 주기(${cycle})와 맞지 않습니다: "${v}". ` +
      "A=YYYY, S=YYYYS1, Q=YYYYQ1, M=YYYYMM, SM=YYYYMMS1, D=YYYYMMDD");
  }
}

function defaultRange(cycle, start, end) {
  const today = kstToday();
  if (cycle === "D") {
    end = end || today;
    start = start || addDays(end, -30);
  } else if (cycle === "M") {
    end = end || today.slice(0, 6);
    start = start || addMonths(end, -23);
  }
  return { start, end };
}

function fmtNum(v) {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

// ---------------------------------------------------------------------------
// ECOS 호출
// ---------------------------------------------------------------------------
async function ecos(key, service, startIdx, endIdx, ...params) {
  const path = [service, encodeURIComponent(key), "json", "kr", startIdx, endIdx,
    ...params.map(p => encodeURIComponent(p))].join("/");
  const url = `${ECOS_BASE}/${path}`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new ToolError(`ECOS 서버 접속 실패: ${e.message}`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ToolError(`ECOS 응답을 해석할 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (data.RESULT) {
    const { CODE, MESSAGE } = data.RESULT;
    if (CODE === "INFO-200") return { total: 0, rows: [] }; // 데이터 없음
    if (/^INFO-100|^ERROR-1/.test(CODE)) {
      throw new ToolError(`ECOS 인증키 오류(${CODE}): ${MESSAGE} — 커넥터 주소의 ecos_key 값을 확인하세요.`);
    }
    throw new ToolError(`ECOS 오류(${CODE}): ${MESSAGE}`);
  }
  const body = data[service];
  if (!body) throw new ToolError(`ECOS 응답에 ${service} 항목이 없습니다.`);
  return { total: body.list_total_count || 0, rows: body.row || [] };
}

// 항목목록 캐시 (서버리스 인스턴스가 살아있는 동안)
const itemCache = new Map();
async function getItems(key, statCode) {
  if (itemCache.has(statCode)) return itemCache.get(statCode);
  const { rows } = await ecos(key, "StatisticItemList", 1, 2000, statCode);
  itemCache.set(statCode, rows);
  return rows;
}

let tableCache = null;
async function getTables(key) {
  if (tableCache) return tableCache;
  const { rows } = await ecos(key, "StatisticTableList", 1, 10000);
  tableCache = rows;
  return rows;
}

async function resolvePreset(key, presetKey, cycle) {
  const p = PRESETS[presetKey];
  if (!p) throw new ToolError(`알 수 없는 지표: ${presetKey}`);
  const supported = Object.keys(p.tables);
  if (!cycle) cycle = supported.includes("D") ? "D" : supported[0];
  if (!p.tables[cycle]) {
    throw new ToolError(`${p.label}은(는) 주기 ${cycle}를 지원하지 않습니다. 가능: ${supported.join(", ")}`);
  }
  const statCode = p.tables[cycle];
  const items = (await getItems(key, statCode)).filter(r => !r.CYCLE || r.CYCLE === cycle);
  const want = norm(p.item);
  let hit = items.find(r => norm(r.ITEM_NAME) === want);
  if (!hit && !p.exact) hit = items.find(r => norm(r.ITEM_NAME).includes(want));
  if (!hit) {
    const names = [...new Set(items.map(r => r.ITEM_NAME))].slice(0, 40).join(", ");
    throw new ToolError(`통계표 ${statCode}에서 '${p.item}' 항목을 찾지 못했습니다. 가능한 항목: ${names}`);
  }
  return { statCode, cycle, itemCode: hit.ITEM_CODE, itemName: hit.ITEM_NAME, unit: hit.UNIT_NAME, label: p.label };
}

async function fetchSeries(key, statCode, cycle, start, end, items, maxRows = 5000) {
  const params = [statCode, cycle, start, end];
  const codes = [...items];
  while (codes.length && !codes[codes.length - 1]) codes.pop();
  for (const c of codes) params.push(c || "?");
  return ecos(key, "StatisticSearch", 1, maxRows, ...params);
}

// ---------------------------------------------------------------------------
// 도구 실행
// ---------------------------------------------------------------------------
async function runTool(name, args, key) {
  args = args || {};
  switch (name) {
    case "get_indicator": {
      const r = await resolvePreset(key, args.indicator, args.cycle);
      const { start, end } = defaultRange(r.cycle, args.start, args.end);
      checkDate(r.cycle, start, "start");
      checkDate(r.cycle, end, "end");
      const { rows } = await fetchSeries(key, r.statCode, r.cycle, start, end, [r.itemCode]);
      if (!rows.length) return `${r.label}: ${start}~${end} 기간에 데이터가 없습니다.`;
      const unit = rows[0].UNIT_NAME || r.unit || "";
      const last = rows[rows.length - 1];
      const lines = rows.map(x => `${x.TIME}\t${fmtNum(x.DATA_VALUE)}`);
      return [
        `## ${r.label} (${r.cycle === "D" ? "일별" : "월별"}, 단위: ${unit})`,
        `통계표 ${r.statCode} / 항목 ${r.itemCode} ${r.itemName}`,
        `최근값: ${last.TIME} = ${fmtNum(last.DATA_VALUE)}  (총 ${rows.length}건)`,
        "",
        "시점\t값",
        ...lines,
        "",
        "출처: 한국은행 경제통계시스템(ECOS)",
      ].join("\n");
    }

    case "rates_as_of": {
      const date = String(args.date || "");
      checkDate("D", date, "date");
      const list = args.indicators && args.indicators.length
        ? args.indicators
        : ["base_rate", "ktb_3y", "ktb_5y", "ktb_10y", "corp_aa_3y", "corp_bbb_3y", "usd_krw"];
      const out = [`## ${date} 기준 지표 (휴일이면 직전 영업일 값)`, "", "지표\t값\t단위\t적용일"];
      for (const ind of list) {
        try {
          const r = await resolvePreset(key, ind, "D");
          const { rows } = await fetchSeries(key, r.statCode, "D", addDays(date, -20), date, [r.itemCode]);
          const valid = rows.filter(x => x.DATA_VALUE !== "" && x.DATA_VALUE !== null && x.TIME <= date);
          const last = valid[valid.length - 1];
          out.push(last
            ? `${r.label}\t${fmtNum(last.DATA_VALUE)}\t${last.UNIT_NAME || r.unit || ""}\t${last.TIME}`
            : `${r.label}\t데이터 없음\t\t`);
        } catch (e) {
          out.push(`${PRESETS[ind] ? PRESETS[ind].label : ind}\t오류: ${e.message}\t\t`);
        }
      }
      out.push("", "출처: 한국은행 경제통계시스템(ECOS)");
      return out.join("\n");
    }

    case "search_statistics": {
      const { stat_code, cycle, start, end } = args;
      checkDate(cycle, start, "start");
      checkDate(cycle, end, "end");
      const maxRows = Math.min(args.max_rows || 500, 5000);
      const { total, rows } = await fetchSeries(key, stat_code, cycle, start, end,
        [args.item_code1, args.item_code2, args.item_code3, args.item_code4], maxRows);
      if (!rows.length) return `데이터가 없습니다 (${stat_code}, ${cycle}, ${start}~${end}).`;
      const head = `## ${rows[0].STAT_NAME} (${stat_code}, 주기 ${cycle})  총 ${total}건 중 ${rows.length}건`;
      const lines = rows.map(x => {
        const items = [x.ITEM_NAME1, x.ITEM_NAME2, x.ITEM_NAME3, x.ITEM_NAME4].filter(Boolean).join(" / ");
        return `${x.TIME}\t${items}\t${fmtNum(x.DATA_VALUE)}\t${x.UNIT_NAME || ""}`;
      });
      return [head, "", "시점\t항목\t값\t단위", ...lines, "", "출처: 한국은행 경제통계시스템(ECOS)"].join("\n");
    }

    case "search_tables": {
      const kw = norm(args.keyword);
      const limit = args.limit || 30;
      const rows = (await getTables(key)).filter(r => norm(r.STAT_NAME).includes(kw));
      if (!rows.length) return `'${args.keyword}'에 해당하는 통계표가 없습니다. 다른 표현으로 검색해 보세요.`;
      const lines = rows.slice(0, limit).map(r =>
        `${r.STAT_CODE}\t${r.STAT_NAME}\t주기:${r.CYCLE || "-"}\t검색가능:${r.SRCH_YN || "-"}`);
      return [`'${args.keyword}' 통계표 ${rows.length}건 (상위 ${Math.min(limit, rows.length)}건)`, "",
        "코드\t통계표명\t주기\t검색가능", ...lines,
        "", "검색가능:Y 인 통계표만 list_items/search_statistics로 조회됩니다."].join("\n");
    }

    case "list_items": {
      let rows = await getItems(key, args.stat_code);
      if (args.keyword) rows = rows.filter(r => norm(r.ITEM_NAME).includes(norm(args.keyword)));
      if (!rows.length) return `항목이 없습니다 (${args.stat_code}${args.keyword ? `, '${args.keyword}'` : ""}).`;
      const limit = args.limit || 100;
      const lines = rows.slice(0, limit).map(r =>
        `${r.GRP_NAME || ""}\t${r.ITEM_CODE}\t${r.ITEM_NAME}\t${r.CYCLE || "-"}\t${r.START_TIME || "?"}~${r.END_TIME || "?"}\t${r.UNIT_NAME || ""}`);
      return [`## ${rows[0].STAT_NAME} (${args.stat_code}) 항목 ${rows.length}건`, "",
        "그룹\t항목코드\t항목명\t주기\t수록기간\t단위", ...lines].join("\n");
    }

    case "key_statistics": {
      let { rows } = await ecos(key, "KeyStatisticList", 1, 200);
      if (args.keyword) rows = rows.filter(r => norm(r.KEYSTAT_NAME).includes(norm(args.keyword)) || norm(r.CLASS_NAME).includes(norm(args.keyword)));
      if (!rows.length) return "해당 지표가 없습니다.";
      const lines = rows.map(r => `${r.CLASS_NAME}\t${r.KEYSTAT_NAME}\t${fmtNum(r.DATA_VALUE)}\t${r.UNIT_NAME || ""}\t${r.CYCLE}`);
      return ["## 100대 통계지표", "", "분류\t지표\t값\t단위\t시점", ...lines, "", "출처: 한국은행 경제통계시스템(ECOS)"].join("\n");
    }

    case "search_word": {
      const { rows } = await ecos(key, "StatisticWord", 1, 10, args.word);
      if (!rows.length) return `'${args.word}' 용어를 찾지 못했습니다.`;
      return rows.map(r => `### ${r.WORD}\n${r.CONTENT}`).join("\n\n");
    }

    default:
      throw new ToolError(`알 수 없는 도구: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC 처리
// ---------------------------------------------------------------------------
async function handleMessage(msg, key) {
  const isRequest = msg && msg.id !== undefined && msg.id !== null;
  const reply = result => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: isRequest ? msg.id : null, error: { code, message } });

  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return fail(-32600, "Invalid Request");
  }
  if (!isRequest) return null; // notifications (예: notifications/initialized)

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params && msg.params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "한국은행 ECOS 경제통계 조회 서버. 기준금리·국고채·회사채·CD·콜금리·환율·CPI는 get_indicator(기간) 또는 " +
          "rates_as_of(특정 기준일)로 이름만으로 조회한다. 그 밖의 통계는 search_tables → list_items → search_statistics 순서로 찾는다. " +
          "값을 인용할 때는 시점과 단위, 출처(한국은행 ECOS)를 함께 표기한다.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (!TOOLS.find(t => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      if (!key) {
        return reply({
          isError: true,
          content: [{ type: "text", text: "ECOS 인증키가 없습니다. 커넥터 주소 끝에 ?ecos_key=본인인증키 를 붙여 다시 등록하세요." }],
        });
      }
      try {
        const text = await runTool(name, args, key);
        return reply({ content: [{ type: "text", text }] });
      } catch (e) {
        const text = e instanceof ToolError ? e.message : `처리 중 오류: ${e.message}`;
        return reply({ isError: true, content: [{ type: "text", text }] });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== "") {
    if (typeof req.body === "string") return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

function getKey(req) {
  const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
  return q.ecos_key || req.headers["x-ecos-key"] || process.env.ECOS_API_KEY || "";
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(obj === undefined ? "" : JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, X-Ecos-Key");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method === "GET" || req.method === "DELETE") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed. Use POST." } });
  }
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  const key = getKey(req);
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(m => handleMessage(m, key)))).filter(Boolean);
    if (!out.length) { res.statusCode = 202; return res.end(); }
    return send(res, 200, out);
  }
  const out = await handleMessage(body, key);
  if (!out) { res.statusCode = 202; return res.end(); }
  return send(res, 200, out);
};

// 테스트용 내보내기
module.exports._internal = { runTool, handleMessage, PRESETS };
