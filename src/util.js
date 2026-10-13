// 纯函数工具集，无副作用、无本地依赖。
import path from 'node:path';

export class ToolError extends Error {
  constructor(message, { code = 'E_TOOL', hint = '' } = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hint = hint;
  }
}

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

export function formatTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '?';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export function truncateText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false, omittedChars: 0 };
  let cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf('\n');
  if (nl > maxChars * 0.6) cut = cut.slice(0, nl);
  return { text: cut, truncated: true, omittedChars: text.length - cut.length };
}

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

/** 把 glob 编译成正则；支持 **、*、?、{a,b}。大小写不敏感。 */
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

/** 把 glob 数组/单个 glob 编译成 matcher；pattern 里的 / 和 \ 都当分隔符。 */
export function makeNameMatcher(globs, { caseSensitive = false } = {}) {
  const list = (Array.isArray(globs) ? globs : [globs]).filter(Boolean).map((g) => String(g).replace(/\\/g, '/'));
  if (list.length === 0) return () => false;
  const regexps = list.map((g) => globToRegExp(g, { caseSensitive }));
  return (name) => {
    const n = String(name).replace(/\\/g, '/');
    return regexps.some((re) => re.test(n));
  };
}

/** 去掉对阅读毫无帮助、最容易变成提示注入的零宽字符。 */
export function stripInvisible(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
}

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

export function relativeTo(root, full) {
  const rel = path.relative(root, full);
  if (!rel) return '.';
  return toPosix(rel);
}

export function isWindows() {
  return process.platform === 'win32';
}

export function samePath(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return isWindows() ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function isInsidePath(root, dir, child) {
  if (!root) return false;
  const norm = (p) => (isWindows() ? path.resolve(p).toLowerCase() : path.resolve(p));
  const r = norm(dir);
  let c = norm(child);
  if (!c.startsWith(r)) return false;
  if (c.length === r.length) return true;
  const sep = r.endsWith(path.sep) ? '' : path.sep;
  if (c.startsWith(r + sep)) return true;
  // Windows：目录可能以 / 结尾混用
  if (isWindows() && c.startsWith(`${r}/`)) return true;
  return false;
}
