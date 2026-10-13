// 工具注册表。要加新工具：写一个 { name, title, description, inputSchema, annotations, run } ，
// 在这里 import 后塞进列表即可 —— 所有工具都必须声明 readOnlyHint: true，服务端启动时会强制校验。
import { listRootsTool } from './roots.js';
import { lsTool } from './ls.js';
import { statTool } from './stat.js';
import { catTool } from './cat.js';
import { tailTool } from './tail.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { Out } from './base.js';
import { ToolError } from '../util.js';
import { makeDeadline } from '../primitives.js';

export const tools = [listRootsTool, lsTool, globTool, statTool, catTool, tailTool, grepTool];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));

/** 每个工具必须显式声明只读，否则启动就报错 —— 杜绝以后有人塞进来一个会写文件的工具 */
export function assertReadOnlyToolset() {
  for (const t of tools) {
    if (!t.annotations || t.annotations.readOnlyHint !== true) {
      throw new Error(`工具 ${t.name} 没有声明 readOnlyHint: true；本服务只允许只读工具`);
    }
  }
}

export function listTools() {
  return tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

export async function handleToolCall(name, args, ctx) {
  const tool = toolsByName.get(name);
  if (!tool) {
    throw new ToolError(`没有这个工具：${name}`, {
      code: 'E_NO_TOOL',
      hint: `可用工具：${tools.map((t) => t.name).join(', ')}`,
    });
  }
  const deadline = makeDeadline(ctx.config.callTimeoutMs);
  const started = Date.now();
  const result = await tool.run(args || {}, { ...ctx, deadline });
  const elapsed = Date.now() - started;
  if (result instanceof Out) {
    result.set('ms', elapsed);
    const text = result.render();
    return {
      text,
      structured: { meta: result.meta, truncatedByServer: text.includes('[TRUNCATED]') },
      elapsedMs: elapsed,
    };
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return { text, structured: null, elapsedMs: elapsed };
}
