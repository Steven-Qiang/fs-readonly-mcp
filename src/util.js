// @ts-check
// 纯函数工具集，无副作用、无本地依赖。
import path from 'node:path';

/** 工具层抛出的、带错误码与「下一步怎么做」提示的错误 */
export class ToolError extends Error {
  /**
   * @param {string} message 给人和 AI 看的一句话
   * @param {{ code?: string, hint?: string }} [options] code 形如 E_NOT_FOUND；hint 是可直接照抄的下一步
   */
  constructor(message, { code = 'E_TOOL', hint = '' } = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hint = hint;
  }
}

/**
 * 人类可读的字节数。无效输入返回 '?'。
 * @param {number} n
 * @returns {string} 例如 `2.7MB`
 */
export function formatBytes(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return '?';
  if (num < 1024) return `${num}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = num / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

/**
 * 固定格式的本地时间，AI 拿它跟日志里的时间戳直接对比。
 * @param {Date | number | string} date
 * @returns {string} `YYYY-MM-DD HH:mm:ss`
 */
export function formatTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '?';
  /**
   * @param {number} n
   * @param {number} [w]
   * @returns {string}
   */
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * 按字符数截断，且尽量切在最后一个换行处，避免把一行切一半。
 * @param {string} text
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean, omittedChars: number }}
 */
export function truncateText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false, omittedChars: 0 };
  let cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf('\n');
  if (nl > maxChars * 0.6) cut = cut.slice(0, nl);
  return { text: cut, truncated: true, omittedChars: text.length - cut.length };
}

/**
 * 清理单行：去掉会污染上下文的控制字符，并按上限截断。
 * @param {string} text
 * @param {{ maxLen?: number, stripControl?: boolean }} [options]
 * @returns {{ text: string, truncated: boolean }}
 */
export function cleanLine(text, { maxLen = 8192, stripControl = true } = {}) {
  let out = text;
  if (stripControl) {
    // 去掉除 tab 以外的控制字符：它们会污染 AI 上下文，也可能被用来做提示注入
    out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }
  let truncated = false;
  if (out.length > maxLen) {
    out = `${out.slice(0, maxLen)}…[本行共 ${out.length} 字符，已截断]`;
    truncated = true;
  }
  return { text: out, truncated };
}

/**
 * 把 glob 编译成正则；支持 `**`、`*`、`?`、`{a,b}`。
 * `*` 不跨 `/`，`**` 跨目录。
 * @param {string} pattern
 * @param {{ caseSensitive?: boolean }} [options]
 * @returns {RegExp}
 */
export function globToRegExp(pattern, { caseSensitive = false } = {}) {
  const src = String(pattern);
  let out = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '*') {
      if (src[i + 1] === '*') {
        i += 1;
        if (src[i + 1] === '/') i += 1;
        out += '(?:.*/)?';
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const end = src.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
      } else {
        const alts = src
          .slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        out += `(?:${alts.join('|')})`;
        i = end;
      }
    } else if ('\\^$.|+()[]'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, caseSensitive ? '' : 'i');
}

/**
 * 生成名字匹配函数。pattern 里的 `/` 与 `\` 都当分隔符。
 * @param {string | string[] | undefined} globs
 * @param {{ caseSensitive?: boolean }} [options]
 * @returns {(name: string) => boolean} 没有 pattern 时永远返回 false
 */
export function makeNameMatcher(globs, { caseSensitive = false } = {}) {
  const list = (Array.isArray(globs) ? globs : [globs]).filter((g) => Boolean(g)).map((g) => String(g).replace(/\\/g, '/'));
  if (list.length === 0) return () => false;
  const regexps = list.map((g) => globToRegExp(g, { caseSensitive }));
  return (name) => {
    const n = String(name).replace(/\\/g, '/');
    return regexps.some((re) => re.test(n));
  };
}

/**
 * 去掉对阅读毫无帮助、最容易变成提示注入的零宽字符。
 * @param {string} text
 * @returns {string}
 */
export function stripInvisible(text) {
  return text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
}

/**
 * 统一成正斜杠，方便日志里显示与比对。
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** @returns {boolean} 当前是否 Windows */
export function isWindows() {
  return process.platform === 'win32';
}

/**
 * 规范化路径用于比较（Windows 下大小写不敏感）。
 * @param {string} p
 * @returns {string}
 */
export function normalizeForCompare(p) {
  const abs = path.resolve(p);
  return isWindows() ? abs.toLowerCase() : abs;
}

/**
 * 判断 child 是否就是 dir 本身或位于 dir 之内。
 * 用「目录 + 分隔符」比较，避免 `/srv/logs-evil` 骗过 `/srv/logs`。
 * @param {string} root 用于比较的根（一般是 realpath 之后的结果）；为空直接返回 false
 * @param {string} dir 目录
 * @param {string} child 待判断路径
 * @returns {boolean}
 */
export function isInsidePath(root, dir, child) {
  if (!root) return false;
  const r = normalizeForCompare(dir);
  const c = normalizeForCompare(child);
  if (c === r) return true;
  const withSep = r.endsWith(path.sep) ? r : r + path.sep;
  if (c.startsWith(withSep)) return true;
  // Windows 上可能混用分隔符
  return isWindows() && c.startsWith(`${r}/`);
}
