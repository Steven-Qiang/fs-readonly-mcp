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

export const tools = [listRootsTool, lsTool, globTool, statTool, catTool, tailTool, grepTool];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));

/** 启动即校验：任何工具没声明只读就拒绝启动，杜绝以后有人塞进来一个会写文件的工具 */
export function assertReadOnlyToolset() {
  for (const t of tools) {
    if (t.config.annotations?.readOnlyHint !== true) {
      throw new Error(`工具 ${t.name} 没有声明 readOnlyHint: true；本服务只允许只读工具`);
    }
    if (!(t.config.inputSchema instanceof z.ZodType)) {
      throw new Error(`工具 ${t.name} 的 inputSchema 必须是 zod schema`);
    }
  }
}

/** 工具的静态依赖：进程级单例，一次调用内不变 */
export function createToolContext({ config, roots, audit, logger = () => {}, clientInfo = null }) {
  return { config, roots, audit, logger, clientInfo };
}

/**
 * 执行一次工具调用：统一处理异常、耗时与审计。
 * 返回官方 SDK 要求的 CallToolResult（content + isError）。
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
      client: ctx.clientInfo?.name || null,
      tool: name,
      args,
      ok: true,
      ms: elapsedMs,
      chars: text.length,
      truncated: text.includes('[TRUNCATED]'),
    });
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    ctx.audit?.write({
      ts: new Date().toISOString(),
      client: ctx.clientInfo?.name || null,
      tool: name,
      args,
      ok: false,
      code: err?.code || 'E_INTERNAL',
      message: err?.message,
    });
    ctx.logger(`工具 ${name} 失败：${err?.code || ''} ${err?.message}`);
    return { content: [{ type: 'text', text: errorText(err) }], isError: true };
  }
}

/** 把全部工具注册到一个 McpServer 实例上 */
export function registerTools(server, ctx) {
  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, async (args) => {
      // SDK 的 handler 上下文里若有 signal（客户端断开），透传给耗时扫描
      return callTool(tool.name, args, ctx, { signal: undefined });
    });
  }
  return server;
}

export function toolNames() {
  return tools.map((t) => t.name);
}
