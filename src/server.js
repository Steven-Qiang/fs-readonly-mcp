// 只读文件系统 MCP 服务 —— HTTP Streamable 传输。
//
// 传输层用官方实现：express + @modelcontextprotocol/express + @modelcontextprotocol/node +
// @modelcontextprotocol/server（createMcpHandler 自动同时服务 2025 与 2026 两代协议，
// 会话、SSE 分帧、Accept 协商、DNS 重绑定防护都由 SDK 负责）。
//
// 本文件只做三件事：起 express、挂 Bearer 鉴权、把只读工具注册进 McpServer。
// 进程里不存在任何写文件的代码路径：所有工具都必须声明 readOnlyHint，启动时强制校验。
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { Roots } from './roots.js';
import { createAudit } from './audit.js';
import { assertReadOnlyToolset, createToolContext, registerTools, toolNames } from './tools/index.js';

/**
 * @typedef {import('express').Request} Req
 * @typedef {import('express').Response} Res
 * @typedef {import('express').NextFunction} Next
 * @typedef {import('./tools/base.js').ToolContext} ToolContext
 */

const SERVER_NAME = 'fs-readonly-mcp';
const SERVER_VERSION = '1.0.0';

const config = loadConfig();
assertReadOnlyToolset();
const roots = new Roots(config.roots);
const audit = createAudit(config);

/**
 * @param {...unknown} args
 * @returns {void}
 */
function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`);
}

/**
 * 定长比较，避免用 === 比 token 时泄漏长度信息。
 * @param {unknown} provided
 * @param {unknown} expected
 * @returns {boolean}
 */
function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Bearer 鉴权：内网跳板机只做连接鉴权，不做任何密钥/隐私文件过滤。
 * 只认 Authorization 头 —— 不接受 query string 里的 token，那个会进 access log。
 * @param {Req} req
 * @param {Res} res
 * @param {Next} next
 * @returns {unknown}
 */
function requireToken(req, res, next) {
  if (!config.token) return next();
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const provided = m ? m[1].trim() : '';
  if (!provided) {
    res.set('www-authenticate', 'Bearer');
    return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '缺少凭据：请带 Authorization: Bearer <MCP_TOKEN>' } });
  }
  if (!tokenMatches(provided, config.token)) {
    res.set('www-authenticate', 'Bearer');
    return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '凭据不正确' } });
  }
  return next();
}

/**
 * 每次调用（每个请求）新建一个 McpServer：工具是纯只读的，天然无状态，不必维护会话内存。
 * @param {ToolContext} ctx
 * @returns {McpServer}
 */
function createServer(ctx) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: '只读文件系统（ls/grep/cat/tail）' },
    {
      instructions:
        '这是一个只读文件系统服务：只能看，不能改任何文件。' +
        '排查顺序建议：list_roots 看能读哪些目录 → glob_files/ls 定位文件 → stat 判断文件大小与是否在写 → ' +
        'tail 看最新日志 / grep 定位关键字 / cat 按 offset 分片读。' +
        '遇到大文件不要整读：结果里的 [hint] 会写明下一步该用什么参数。',
    },
  );
  return registerTools(server, ctx);
}

const handler = createMcpHandler(
  // 每次请求一个全新实例；会话号（规范头 mcp-session-id）带进工具上下文，仅用于审计关联
  (mcpCtx) =>
    createServer(
      createToolContext({
        config,
        roots,
        audit,
        logger: log,
        sessionId: mcpCtx?.requestInfo?.headers?.get('mcp-session-id') ?? null,
      }),
    ),
  {
    legacy: 'stateless', // 2025 代客户端按无状态服务：每个请求独立，不占会话内存
    onerror: (/** @type {Error} */ err) => log(`MCP handler 错误：${err?.stack || err}`),
  },
);
const nodeHandler = toNodeHandler(handler, {
  onerror: (/** @type {Error} */ err) => log(`MCP 适配层错误：${err?.stack || err}`),
  maxRequestBodySize: 1024 * 1024,
});

const app = createMcpExpressApp({
  host: config.host,
  jsonLimit: '1mb',
});

app.get('/healthz', (/** @type {Req} */ _req, /** @type {Res} */ res) => {
  res.json({
    ok: true,
    service: SERVER_NAME,
    version: SERVER_VERSION,
    writeable: false,
    roots: roots.describe(),
    tools: toolNames(),
    auth: config.token ? 'bearer' : 'none',
    uptimeSec: Math.round(process.uptime()),
  });
});

// body 由 createMcpExpressApp 挂的 express.json() 解析（SDK 的约定用法），
// 第三个参数把解析好的 body 交给 SDK —— toNodeHandler 的契约就是要这个。
// 坏 JSON 由下面的 express 错误处理映射成 400 + -32700，符合 JSON-RPC 规范。
app.all('/mcp', requireToken, (/** @type {Req} */ req, /** @type {Res} */ res) => {
  void nodeHandler(req, res, req.body);
});

app.use((/** @type {Req} */ _req, /** @type {Res} */ res) => {
  res.status(404).json({ error: 'not_found', hint: 'MCP 端点是 /mcp ；健康检查是 GET /healthz' });
});

app.use((/** @type {any} */ err, /** @type {Req} */ _req, /** @type {Res} */ res, /** @type {Next} */ _next) => {
  log(`express 错误：${err?.stack || err}`);
  // body 解析类错误按 400 回，其余才是 500
  const isBodyError = err?.type === 'entity.parse.failed' || err instanceof SyntaxError;
  const status = isBodyError ? 400 : err?.status || err?.statusCode || 500;
  const code = isBodyError ? -32700 : -32603;
  res.status(status).json({ jsonrpc: '2.0', id: null, error: { code, message: err?.message || '内部错误' } });
});

const httpServer = app.listen(config.port, config.host, () => {
  log(`${SERVER_NAME} v${SERVER_VERSION} listening on http://${config.host}:${config.port}/mcp`);
  log(`健康检查: http://${config.host}:${config.port}/healthz`);
  log(`鉴权: ${config.token ? 'Bearer Token 已启用' : '⚠ 未配置 MCP_TOKEN，任何能访问该端口的人都能读这些目录'}`);
  log(`单次调用预算: ${config.callTimeoutMs}ms；输出上限: ${config.maxTextChars} 字符`);
  log(audit.info);
  for (const r of roots.describe()) {
    log(`  project=${r.name}  ${r.dirs.join(' , ')}${r.exists ? '' : '  [不存在]'}`);
  }
});

httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 70_000;
httpServer.requestTimeout = 0; // 长耗时 grep/tail 不能被默认超时掐断

/** 两个信号都注册了，加个闸门避免重复关闭 */
let shuttingDown = false;

/**
 * @param {string} signal
 * @returns {void}
 */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，关闭中…`);
  httpServer.close(() => {
    handler.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (/** @type {unknown} */ err) => log(`unhandledRejection: ${/** @type {Error} */ (err)?.stack || err}`));
process.on('uncaughtException', (/** @type {unknown} */ err) => log(`uncaughtException: ${/** @type {Error} */ (err)?.stack || err}`));
