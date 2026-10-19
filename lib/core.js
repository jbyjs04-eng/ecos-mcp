// 공통 MCP(Streamable HTTP, JSON 응답) 처리기 — KOSIS·KRX 엔드포인트가 함께 쓴다.

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

class ToolError extends Error {}

const norm = s => String(s == null ? "" : s).replace(/\s+/g, "").toLowerCase();

function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}
function addDays(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function getJson(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json", ...(opts.headers || {}) } });
  } catch (e) {
    throw new ToolError(`서버 접속 실패: ${e.message}`);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new ToolError(`인증 실패(HTTP ${res.status}). 인증키가 맞는지, 해당 서비스 이용신청이 승인됐는지 확인하세요. ${text.slice(0, 200)}`);
  }
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    throw new ToolError(`응답을 해석할 수 없습니다 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

function createHandler({ serverInfo, instructions, tools, keyParam, keyHeader, envVar, run }) {
  async function handleMessage(msg, key) {
    const isRequest = msg && msg.id !== undefined && msg.id !== null;
    const reply = result => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id: isRequest ? msg.id : null, error: { code, message } });

    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid Request");
    if (!isRequest) return null;

    switch (msg.method) {
      case "initialize": {
        const requested = msg.params && msg.params.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools });
      case "tools/call": {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        if (!tools.find(t => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
        if (!key) {
          return reply({ isError: true, content: [{ type: "text", text: `인증키가 없습니다. 커넥터 주소 끝에 ?${keyParam}=본인인증키 를 붙여 다시 등록하세요.` }] });
        }
        try {
          return reply({ content: [{ type: "text", text: await run(name, args, key) }] });
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

  function send(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
  }

  const handler = async function (req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", `Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, ${keyHeader}`);
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed. Use POST." } });
    }
    let body;
    try { body = await readBody(req); }
    catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }

    const q = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
    const key = q[keyParam] || req.headers[keyHeader.toLowerCase()] || process.env[envVar] || "";

    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(m => handleMessage(m, key)))).filter(Boolean);
      if (!out.length) { res.statusCode = 202; return res.end(); }
      return send(res, 200, out);
    }
    const out = await handleMessage(body, key);
    if (!out) { res.statusCode = 202; return res.end(); }
    return send(res, 200, out);
  };
  return handler;
}

module.exports = { createHandler, ToolError, norm, kstToday, addDays, getJson };
