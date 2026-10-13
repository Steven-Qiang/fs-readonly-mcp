// 工具注册表：把声明式工具挂到官方 McpServer 上。
// 与传输层（express + @modelcontextprotocol/*）完全解耦：这里只管「有哪些只读工具、怎么执行」。
import { z } from 'zod';
import { listRootsTool } from './roots.js';
import { lsTool } from './ls.js';
import { statTool } from './stat.js';
import { catTool } from './cat.js';
import { tailTool } from './tail.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { errorText } from './base.js';

/**
 * @typedef {import('./base.js').Tool} Tool
 * @typedef {import('./base.js').ToolContext} ToolContext
 * @typedef {import('@modelcontextprotocol/server').McpServer} McpServer
 * @typedef {import('@modelcontextprotocol/server').CallToolResult} CallToolResult
 * @typedef {import('@modelcontextprotocol/server').ServerContext} ServerContext
 */

/** @type {Tool[]} */
export const tools = [listRootsTool, lsTool, globTool, statTool, catTool, tailTool, grepTool];

/** @type {Map<string, Tool>} */
export const toolsByName = new Map(tools.map((t) => [t.name, t]));

/** 启动即校验：任何工具没声明只读就拒绝启动，杜绝以后有人塞进来一个会写文件的工具 */
export function assertReadOnlyToolset() {
  for (const t of tools) {
    const config = /** @type {{ annotations?: { readOnlyHint?: boolean }, inputSchema?: unknown }} */ (t.config);
    if (config.annotations?.readOnlyHint !== true) {
      throw new Error(`工具 ${t.name} 没有声明 readOnlyHint: true；本服务只允许只读工具`);
    }
    if (!(config.inputSchema instanceof z.ZodType)) {
      throw new Error(`工具 ${t.name} 的 inputSchema 必须是 zod schema`);
    }
  }
}

/**
 * 工具的静态依赖：进程级单例，一次调用内不变。
 * @param {object} deps
 * @param {import('../config.js').Config} deps.config
 * @param {import('../roots.js').Roots} deps.roots
 * @param {import('../audit.js').Audit} deps.audit
 * @param {(msg: string) => void} [deps.logger]
 * @param {string | null} [deps.sessionId] 会话号，仅用于审计关联
 * @returns {ToolContext}
 */
export function createToolContext({ config, roots, audit, logger = () => {}, sessionId = null }) {
  return { config, roots, audit, logger, sessionId };
}

/**
 * 执行一次工具调用：统一处理异常、耗时与审计。
 * @param {string} name 工具名
 * @param {unknown} args 已经过 zod 校验的参数
 * @param {ToolContext} ctx 静态依赖
 * @param {{ signal?: AbortSignal }} [options] 客户端断开信号
 * @returns {Promise<CallToolResult>} 官方 SDK 要求的 CallToolResult（content + isError）
 */
export async function callTool(name, args, ctx, { signal } = {}) {
  const tool = toolsByName.get(name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: errorText(new Error(`没有这个工具：${name}。可用工具：${tools.map((t) => t.name).join(', ')}`)) }],
      isError: true,
    };
  }
  try {
    const { text, elapsedMs } = await tool.execute(args, { ...ctx, signal });
    ctx.audit?.write({
      ts: new Date().toISOString(),
      session: ctx.sessionId || undefined,
      tool: name,
      args: /** @type {Record<string, unknown>} */ (args),
      ok: true,
      ms: elapsedMs,
      chars: text.length,
      truncated: text.includes('[TRUNCATED]'),
    });
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const e = /** @type {{ code?: string, message?: string }} */ (err);
    ctx.audit?.write({
      ts: new Date().toISOString(),
      session: ctx.sessionId || undefined,
      tool: name,
      args: /** @type {Record<string, unknown>} */ (args),
      ok: false,
      code: e?.code || 'E_INTERNAL',
      message: e?.message,
    });
    ctx.logger?.(`工具 ${name} 失败：${e?.code || ''} ${e?.message}`);
    return { content: [{ type: 'text', text: errorText(err) }], isError: true };
  }
}

/**
 * 把全部工具注册到一个 McpServer 实例上。
 * @param {McpServer} server
 * @param {ToolContext} ctx
 * @returns {McpServer}
 */
export function registerTools(server, ctx) {
  for (const tool of tools) {
    // SDK 把本次请求的上下文作为第二个参数传进来；http 请求上的 AbortSignal 用于客户端断开时停止扫描
    server.registerTool(
      tool.name,
      /** @type {any} */ (tool.config),
      async (/** @type {unknown} */ args, /** @type {ServerContext} */ handlerCtx) => {
        const signal = handlerCtx?.http?.req?.signal;
        return callTool(tool.name, args, ctx, { signal });
      },
    );
  }
  return server;
}

/** @returns {string[]} 全部工具名，按注册顺序 */
export function toolNames() {
  return tools.map((t) => t.name);
}
