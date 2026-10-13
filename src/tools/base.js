// 工具基座：统一的输出格式（[meta] 元信息 / 正文 / [hint] 下一步动作）。
// 输出纪律：任何被截断的结果都必须带 [hint]，明确告诉 AI 下一步该用什么参数继续，而不是让它瞎猜。
import { ToolError, truncateText } from '../util.js';

/**
 * @typedef {object} ToolContext
 * @property {import('../config.js').Config} config
 * @property {import('../roots.js').Roots} roots
 * @property {import('../audit.js').Audit | null} [audit]
 * @property {(msg: string) => void} [logger]
 * @property {string | null} [sessionId] 会话号，仅用于审计关联
 * @property {AbortSignal} [signal]
 * @property {Deadline} [deadline]
 */

/**
 * @typedef {object} Deadline
 * @property {number} budgetMs
 * @property {() => boolean} expired
 * @property {() => number} elapsed
 */

/**
 * @typedef {object} ToolRunResult
 * @property {string} text 给 AI 的正文
 * @property {number} elapsedMs 执行耗时
 */

/**
 * @typedef {object} Tool
 * @property {string} name
 * @property {object} config 传给 McpServer.registerTool 的配置
 * @property {(args: unknown, ctx: ToolContext) => Promise<ToolRunResult>} execute
 */

/** 工具统一输出容器：负责 [meta] 行、正文、以及超上限截断提示 */
export class Out {
  /**
   * @param {Record<string, unknown>} [meta]
   * @param {{ maxChars?: number }} [options]
   */
  constructor(meta = {}, { maxChars = 64000 } = {}) {
    this.meta = { ...meta };
    /** @type {string[]} */
    this.lines = [];
    this.maxChars = maxChars;
  }

  /**
   * @param {string} key
   * @param {unknown} value 为空/空串时不写入
   * @returns {this}
   */
  set(key, value) {
    if (value !== undefined && value !== null && value !== '') this.meta[key] = value;
    return this;
  }

  /**
   * @param {unknown} text
   * @returns {this}
   */
  push(text) {
    if (text !== undefined && text !== null && text !== '') this.lines.push(String(text));
    return this;
  }

  /**
   * @param {unknown[]} items
   * @returns {this}
   */
  pushAll(items) {
    for (const it of items) this.push(it);
    return this;
  }

  /** @returns {string} 形如 `[meta] tool=ls entries=3 ms=2` */
  metaLine() {
    const parts = Object.entries(this.meta)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`);
    return parts.length ? `[meta] ${parts.join(' ')}` : '';
  }

  /** @returns {string} 最终返回给 AI 的文本（含截断提示） */
  render() {
    const head = this.metaLine();
    const body = this.lines.join('\n');
    const text = [head, body].filter(Boolean).join('\n');
    const { text: finalText, truncated } = truncateText(text, this.maxChars);
    if (!truncated) return finalText;
    return `${finalText}\n\n[TRUNCATED] 输出超过服务端单次上限（字符数），已在这里截断。\n[hint] 不要靠加大上限重试：请改用 offset/limit 分片读、加 grep 过滤，或缩小 limit/maxEntries 后再看。`;
  }
}

/**
 * 单次调用的时间预算。
 * @param {number} budgetMs
 * @returns {Deadline}
 */
export function makeDeadline(budgetMs) {
  const started = Date.now();
  return {
    budgetMs,
    expired: () => Date.now() - started > budgetMs,
    elapsed: () => Date.now() - started,
  };
}

/**
 * 参数被 zod 拒绝时，给 AI 一份「能直接照抄」的修正提示。
 * @param {unknown} error
 * @returns {string}
 */
function describeIssues(error) {
  const issues = /** @type {{ issues?: { path?: (string|number)[], message: string }[], message?: string }} */ (error)?.issues || [];
  if (issues.length === 0) {
    const fallback = /** @type {{ message?: string }} */ (error)?.message;
    return String(fallback ?? error);
  }
  return issues
    .map((i) => {
      const where = Array.isArray(i.path) && i.path.length ? i.path.join('.') : '(入参)';
      return `${where}: ${i.message}`;
    })
    .join('；');
}

/**
 * 定义一个只读工具。
 * 声明式写法的唯一出口：注册表、只读校验、参数校验、耗时统计、审计都在这里统一处理。
 * @template {import('zod').ZodRawShape} S
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.title
 * @param {string} spec.description
 * @param {import('zod').ZodObject<S>} spec.inputSchema
 * @param {Record<string, unknown>} [spec.annotations]
 * @param {(args: import('zod').output<import('zod').ZodObject<S>>, ctx: ToolContext) => Promise<Out | string>} spec.run
 * @returns {Tool}
 */
export function defineTool({ name, title, description, inputSchema, annotations = {}, run }) {
  return {
    name,
    config: {
      title,
      description,
      inputSchema,
      // 只读工具的身份标识，写死在这里，任何人都改不掉
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, ...annotations },
    },
    async execute(args, ctx) {
      const parsed = inputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new ToolError(`参数不合法：${describeIssues(parsed.error)}`, {
          code: 'E_PARAM',
          hint: '按工具说明调整参数后重试；工具说明里每个参数都写了取值范围。',
        });
      }
      const deadline = makeDeadline(ctx.config.callTimeoutMs);
      const started = Date.now();
      const out = await run(parsed.data, { ...ctx, deadline });
      const elapsed = Date.now() - started;
      if (out instanceof Out) {
        out.set('ms', elapsed);
        return { text: out.render(), elapsedMs: elapsed };
      }
      return { text: typeof out === 'string' ? out : JSON.stringify(out), elapsedMs: elapsed };
    },
  };
}

/**
 * 工具报错统一转成 AI 能照着做的文本。
 * @param {unknown} err
 * @returns {string}
 */
export function errorText(err) {
  if (err instanceof ToolError) {
    return `[error] ${err.code}: ${err.message}${err.hint ? `\n[hint] ${err.hint}` : ''}`;
  }
  const message = /** @type {{ message?: string }} */ (err)?.message;
  return `[error] E_INTERNAL: ${message || String(err)}`;
}
