// 工具基座：统一的输出格式（[meta] 元信息 / 正文 / [hint] 下一步动作）与参数解析。
// 输出纪律：任何被截断的结果都必须带 [hint]，明确告诉 AI 下一步该用什么参数继续，而不是让它瞎猜。
import { ToolError, formatBytes, toPosix, truncateText } from '../util.js';

export class Out {
  constructor(meta = {}, { maxChars = 64000 } = {}) {
    this.meta = { ...meta };
    this.lines = [];
    this.maxChars = maxChars;
  }

  set(key, value) {
    if (value !== undefined && value !== null && value !== '') this.meta[key] = value;
    return this;
  }

  push(text) {
    if (text !== undefined && text !== null && text !== '') this.lines.push(String(text));
    return this;
  }

  pushAll(items) {
    for (const it of items) this.push(it);
    return this;
  }

  metaLine() {
    const parts = Object.entries(this.meta)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`);
    return parts.length ? `[meta] ${parts.join(' ')}` : '';
  }

  render() {
    const head = this.metaLine();
    const body = this.lines.join('\n');
    const text = [head, body].filter(Boolean).join('\n');
    const { text: finalText, truncated } = truncateText(text, this.maxChars);
    if (!truncated) return finalText;
    return `${finalText}\n\n[TRUNCATED] 输出超过服务端单次上限（字符数），已在这里截断。\n[hint] 不要靠加大上限重试：请改用 offset/limit 分片读、加 grep 过滤，或缩小 limit/maxEntries 后再看。`;
  }
}

export function num(args, key, fallback, { min, max } = {}) {
  const raw = args?.[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ToolError(`参数 ${key} 必须是数字，收到：${JSON.stringify(raw)}`, { code: 'E_PARAM' });
  }
  let v = Math.trunc(n);
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}

export function str(args, key, fallback = undefined) {
  const raw = args?.[key];
  if (raw === undefined || raw === null) return fallback;
  return String(raw);
}

export function bool(args, key, fallback = false) {
  const raw = args?.[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

export function compileRegex(pattern, { ignoreCase = true, literal = false } = {}) {
  if (!pattern) return null;
  const src = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  try {
    return new RegExp(src, ignoreCase ? 'i' : '');
  } catch (err) {
    throw new ToolError(`正则不合法：${pattern} → ${err.message}`, {
      code: 'E_REGEX',
      hint: '改用 literal=true 按纯文本搜索，或者修正正则',
    });
  }
}

export function sizeHint(bytes) {
  return `${formatBytes(bytes)} (${bytes} bytes)`;
}

export function fileTooLargeError(file, size, { limitBytes, howTo }) {
  return new ToolError(
    `文件 ${toPosix(file)} 有 ${sizeHint(size)}，超过单次读取上限 ${sizeHint(limitBytes)}，已拒绝整读`,
    {
      code: 'E_TOO_LARGE',
      hint:
        `${howTo}\n` +
        `  · 看尾部：tail path="..." lines=200\n` +
        `  · 看开头：cat path="..." limit=200\n` +
        `  · 定位关键行：grep path="..." pattern="ERROR"\n` +
        `  · 分片继续：cat path="..." offset=<下次的 offset> limit=2000`,
    },
  );
}
