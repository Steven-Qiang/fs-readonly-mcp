// 只读文件系统 MCP 服务 —— HTTP Streamable 传输（协议 2025-03-26 / 2025-06-18 兼容）。
//
// 设计前提：
//   · 零运行时依赖，只用 Node 内置模块（服务器上拷过去就能 node src/server.js 起）
//   · 只有读操作：所有工具声明 readOnlyHint，进程里不存在任何写文件的代码路径
//   · 路径必须先过根目录白名单 + realpath，防 symlink 逃逸
import crypto from 'node:crypto';
import http from 'node:http';
import { loadConfig } from './config.js';
import { Roots } from './roots.js';
import { ToolError } from './util.js';
import { createAudit } from './audit.js';
import { assertReadOnlyToolset, handleToolCall, listTools } from './tools/index.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_NAME = 'fs-readonly-mcp';
const SERVER_VERSION = '1.0.0';

const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

// 浏览器/网页版客户端要用的跨域头。服务在内网、且有 token 保护，放开 origin 是刻意的。
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-session-id, mcp-protocol-version',
  'access-control-expose-headers': 'mcp-session-id',
  'access-control-max-age': '86400',
};

const config = loadConfig();
assertReadOnlyToolset();
const roots = new Roots(config.roots);
const audit = createAudit(config);

const sessions = new Map(); // sessionId -> { createdAt, lastSeen, clientInfo, sse:Set<res> }

function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

function textResult(text, { isError = false, structured = null } = {}) {
  const out = { content: [{ type: 'text', text }] };
  if (isError) out.isError = true;
  if (structured) out.structuredContent = structured;
  return out;
}

function errorText(err) {
  if (err instanceof ToolError) {
    return `[error] ${err.code}: ${err.message}${err.hint ? `\n[hint] ${err.hint}` : ''}`;
  }
  return `[error] E_INTERNAL: ${err?.message || String(err)}`;
}

function readBody(req, limitBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new ToolError('请求体过大', { code: 'E_BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function sseStart(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // 让 nginx 别缓存，事件立刻下发
  });
  res.write(': stream open\n\n');
}

function sseSend(res, message, { eventId } = {}) {
  if (eventId) res.write(`id: ${eventId}\n`);
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

function parseAccept(header) {
  return String(header || '')
    .split(',')
    .map((s) => s.split(';')[0].trim().toLowerCase())
    .filter(Boolean);
}

function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authorize(req) {
  if (!config.token) return { ok: true, anonymous: true };
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  let provided = m ? m[1].trim() : '';
  if (!provided) {
    const url = new URL(req.url, 'http://localhost');
    provided = url.searchParams.get('token') || '';
  }
  if (!provided) return { ok: false, reason: '缺少凭据：请带 Authorization: Bearer <MCP_TOKEN>' };
  if (!tokenMatches(provided, config.token)) return { ok: false, reason: '凭据不正确' };
  return { ok: true, anonymous: false };
}

function getSessionId(req) {
  const header = req.headers['mcp-session-id'];
  if (header) return String(header);
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('sessionId') || '';
}

function newSession(clientInfo) {
  const id = crypto.randomBytes(16).toString('hex');
  sessions.set(id, { id, createdAt: Date.now(), lastSeen: Date.now(), clientInfo, sse: new Set() });
  return sessions.get(id);
}

function dropSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  for (const res of s.sse) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  sessions.delete(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.sse.size === 0 && now - s.lastSeen > config.sessionTtlMs) dropSession(id);
  }
}, 60_000).unref();

function handleInitialize(params) {
  const requested = params?.protocolVersion;
  const version = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, title: '只读文件系统（ls/grep/cat/tail）' },
    instructions:
      '这是一个只读文件系统服务：只能看，不能改任何文件。' +
      '排查顺序建议：list_roots 看能读哪些目录 → glob_files/ls 定位文件 → stat 判断文件大小与是否在写 → ' +
      'tail 看最新日志 / grep 定位关键字 / cat 按 offset 分片读。' +
      '遇到大文件不要整读：结果里的 [hint] 会写明下一步该用什么参数。',
  };
}

async function handleToolsCall(params, ctx) {
  const name = params?.name;
  if (typeof name !== 'string' || !name) {
    throw new ToolError('tools/call 需要 params.name', { code: 'E_PARAM' });
  }
  const args = params?.arguments ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolError('params.arguments 必须是对象', { code: 'E_PARAM' });
  }
  try {
    const res = await handleToolCall(name, args, ctx);
    audit.write({
      ts: new Date().toISOString(),
      session: ctx.sessionId,
      client: ctx.clientInfo?.name || null,
      tool: name,
      args,
      ok: true,
      ms: res.elapsedMs,
      chars: res.text.length,
      truncated: !!res.structured?.truncatedByServer,
    });
    return textResult(res.text, { structured: res.structured });
  } catch (err) {
    audit.write({
      ts: new Date().toISOString(),
      session: ctx.sessionId,
      client: ctx.clientInfo?.name || null,
      tool: name,
      args,
      ok: false,
      code: err?.code || 'E_INTERNAL',
      message: err?.message,
    });
    if (!(err instanceof ToolError)) log(`ERROR tools/call ${name}: ${err?.stack || err}`);
    return textResult(errorText(err), { isError: true });
  }
}

async function dispatch(msg, { session, signal }) {
  const method = msg.method;
  const clientInfo = session?.clientInfo || null;

  if (method === 'initialize') {
    return { result: handleInitialize(msg.params), isInitialize: true, clientInfo: msg.params?.clientInfo };
  }
  if (method === 'ping') return { result: {} };
  if (method === 'tools/list') return { result: { tools: listTools() } };
  if (method === 'tools/call') {
    const ctx = {
      config,
      roots,
      signal,
      sessionId: session?.id,
      clientInfo,
      logger: log,
    };
    return { result: await handleToolsCall(msg.params, ctx) };
  }
  if (method === 'resources/list') return { result: { resources: [] } };
  if (method === 'prompts/list') return { result: { prompts: [] } };
  if (method === 'logging/setLevel') return { result: {} };
  return { error: rpcError(msg.id, RPC_METHOD_NOT_FOUND, `不支持的方法：${method}`) };
}

/**
 * 内容协商：MCP 客户端一般同时接受 application/json 和 text/event-stream，两边都合规。
 * 这里默认优先「直接回 JSON」，原因：SSE 一旦开始推流就再也设不了响应头，
 * 而 initialize 必须靠 Mcp-Session-Id 响应头把会话交出去。
 * 只有客户端明确不接受 JSON（或给 JSON 打了 q=0）时才走 SSE。
 */
function prefersJson(acceptHeader) {
  const parts = parseAccept(acceptHeader);
  if (parts.length === 0) return true;
  let jsonQ = null;
  let sseQ = null;
  for (const raw of String(acceptHeader).split(',')) {
    const [type, ...params] = raw.split(';').map((s) => s.trim().toLowerCase());
    let q = 1;
    for (const p of params) {
      const m = /^q=([0-9.]+)$/.exec(p);
      if (m) q = Number.parseFloat(m[1]);
    }
    if (type === 'application/json' || type === 'application/*' || type === '*/*') jsonQ = Math.max(jsonQ ?? 0, q);
    if (type === 'text/event-stream' || type === 'text/*') sseQ = Math.max(sseQ ?? 0, q);
  }
  if (jsonQ !== null && jsonQ > 0) return true;
  if (sseQ !== null && sseQ > 0) return false;
  return true;
}

async function handleMcpPost(req, res) {
  const accept = parseAccept(req.headers.accept);
  const wantsSse = accept.includes('text/event-stream');
  const useSse = wantsSse && !prefersJson(req.headers.accept);
  if (!wantsSse && !accept.includes('application/json') && !accept.includes('*/*')) {
    return sendJson(res, 406, rpcError(null, RPC_INVALID_REQUEST, 'Accept 需要包含 application/json 或 text/event-stream'));
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    return sendJson(res, 413, rpcError(null, RPC_PARSE_ERROR, err.message));
  }

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    return sendJson(res, 400, rpcError(null, RPC_PARSE_ERROR, `JSON 解析失败：${err.message}`));
  }
  if (Array.isArray(msg)) {
    return sendJson(res, 400, rpcError(null, RPC_INVALID_REQUEST, '本服务不支持批量请求'));
  }
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    return sendJson(res, 400, rpcError(msg?.id, RPC_INVALID_REQUEST, '请求必须是带 method 的 JSON-RPC 对象'));
  }

  const method = msg.method;
  const isNotification = msg.id === undefined || msg.id === null;
  const sessionId = getSessionId(req);
  let session = sessionId ? sessions.get(sessionId) : null;
  if (sessionId && !session && isNotification) return res.writeHead(202).end();
  if (sessionId && !session) {
    return sendJson(res, 404, rpcError(msg.id, RPC_INVALID_REQUEST, '会话不存在或已过期，请重新 initialize'));
  }
  if (method === 'initialize') {
    session = newSession(msg.params?.clientInfo);
  } else if (!session) {
    return sendJson(res, 400, rpcError(msg.id, RPC_INVALID_REQUEST, '还没有 initialize：请先调用 initialize 并带上返回的 Mcp-Session-Id'));
  }

  session.lastSeen = Date.now();
  if (method === 'initialize' && msg.params?.clientInfo) session.clientInfo = msg.params.clientInfo;
  if (isNotification) return res.writeHead(202).end();

  const controller = new AbortController();
  // 走流式响应时客户端可能提前断开，这时要真的停下来，别让 grep 继续空转扫盘
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  if (useSse) {
    sseStart(res);
    res.on('close', onClose);
  }

  const extraHeaders = method === 'initialize' ? { 'mcp-session-id': session.id } : {};
  try {
    const outcome = await dispatch(msg, { session, signal: controller.signal });
    const response = outcome.error ? outcome.error : rpcResult(msg.id, outcome.result);
    if (method === 'initialize') {
      log(`initialize ← ${outcome.clientInfo?.name || 'unknown'} ${outcome.clientInfo?.version || ''} → session ${session.id}`);
    }
    if (useSse) {
      sseSend(res, response, { eventId: String(Date.now()) });
      return res.end();
    }
    return sendJson(res, 200, response, extraHeaders);
  } catch (err) {
    log(`ERROR dispatch ${method}: ${err?.stack || err}`);
    const response = rpcError(msg.id, RPC_INTERNAL_ERROR, err?.message || '内部错误');
    if (useSse) {
      sseSend(res, response);
      return res.end();
    }
    return sendJson(res, 200, response);
  } finally {
    res.off('close', onClose);
  }
}

function handleMcpGet(req, res) {
  // GET 是可选的「服务端主动推送」通道。很多客户端会提前把它开着，
  // 这里不能因为还没有 session 就报错（否则客户端一上来就失败）。
  const sessionId = getSessionId(req);
  const session = sessionId ? sessions.get(sessionId) : null;
  sseStart(res);
  if (session) {
    session.lastSeen = Date.now();
    session.sse.add(res);
  }
  const ping = setInterval(() => {
    if (res.writableEnded) return;
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);
  res.write(
    `event: endpoint\ndata: ${JSON.stringify({ sessionId: session ? session.id : null, note: session ? undefined : '未带 Mcp-Session-Id：这条通道不会收到推送，请求请走 POST /mcp' })}\n\n`,
  );
  res.on('close', () => {
    clearInterval(ping);
    if (session) session.sse.delete(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/health')) {
    return sendJson(res, 200, {
      ok: true,
      service: SERVER_NAME,
      version: SERVER_VERSION,
      writeable: false,
      roots: roots.describe(),
      tools: listTools().map((t) => t.name),
      auth: config.token ? 'bearer' : 'none',
      sessions: sessions.size,
      uptimeSec: Math.round(process.uptime()),
    });
  }

  if (pathname !== '/mcp') {
    return sendJson(res, 404, { error: 'not_found', hint: 'MCP 端点是 POST /mcp ；健康检查是 GET /healthz' });
  }

  const auth = authorize(req);
  if (!auth.ok) {
    return sendJson(res, 401, rpcError(null, RPC_INVALID_REQUEST, auth.reason), { 'www-authenticate': 'Bearer' });
  }

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }
    if (req.method === 'POST') return await handleMcpPost(req, res);
    if (req.method === 'GET') return handleMcpGet(req, res);
    if (req.method === 'DELETE') {
      const id = getSessionId(req);
      if (id && sessions.has(id)) {
        dropSession(id);
        res.writeHead(204, CORS_HEADERS);
        return res.end();
      }
      return sendJson(res, 404, rpcError(null, RPC_INVALID_REQUEST, '会话不存在'));
    }
    return sendJson(res, 405, rpcError(null, RPC_INVALID_REQUEST, `不支持的方法 ${req.method}`), {
      allow: 'GET, POST, DELETE, OPTIONS',
    });
  } catch (err) {
    log(`ERROR ${req.method} ${pathname}: ${err?.stack || err}`);
    if (!res.headersSent) sendJson(res, 500, rpcError(null, RPC_INTERNAL_ERROR, err?.message || '内部错误'));
    else res.end();
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0; // 长耗时 grep/tail 不能被 5 分钟掐断

server.listen(config.port, config.host, () => {
  log(`${SERVER_NAME} v${SERVER_VERSION} listening on http://${config.host}:${config.port}/mcp`);
  log(`健康检查: http://${config.host}:${config.port}/healthz`);
  log(`鉴权: ${config.token ? 'Bearer Token 已启用' : '⚠ 未配置 MCP_TOKEN，任何能访问该端口的人都能读这些目录'}`);
  log(`会话有效期: ${Math.round(config.sessionTtlMs / 60000)} 分钟；单次调用预算: ${config.callTimeoutMs}ms；输出上限: ${config.maxTextChars} 字符`);
  log(audit.info);
  for (const r of roots.describe()) {
    log(`  project=${r.name}  ${r.dirs.join(' , ')}${r.exists ? '' : '  [不存在]'}`);
  }
});

function shutdown(signal) {
  log(`收到 ${signal}，关闭中…`);
  server.close(() => process.exit(0));
  for (const id of sessions.keys()) dropSession(id);
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log(`unhandledRejection: ${err?.stack || err}`));
process.on('uncaughtException', (err) => log(`uncaughtException: ${err?.stack || err}`));
