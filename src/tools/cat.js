// cat：读文件内容。默认给行号，支持 offset/limit 分片续读。
// 大文件不整读、二进制不硬灌、凭据类文件默认挡住 —— 而且每种拒绝都要给出「下一步怎么读」。
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { Out, bool, num, str } from './base.js';
import { ToolError, formatBytes, formatTime, toPosix } from '../util.js';
import {
  DEFAULT_MAX_LINE_CHARS,
  readLinesRange,
  readTailLines,
  sniffBinary,
  statFile,
} from '../primitives.js';

// 单次最多吐这么多原始字节，同时是「超过就不整读」的门槛：
// 1MB 文本约等于几十万 token，再大就不是给人看的了，必须让 AI 走 tail/grep/分片。
const HARD_MAX_BYTES = 1024 * 1024;
const PREFIX_SCAN_MAX = 8 * 1024 * 1024; // offset 之前超过这个量就不为行号做全前缀扫描了

/** 数出 offset 之前有多少行，用来给分片续读定行号；前缀太大时返回近似 */
async function linesBeforeOffset(file, offset) {
  if (offset <= 0) return { line: 1, exact: true };
  if (offset > PREFIX_SCAN_MAX) return { line: null, exact: false };
  const st = await statFile(file);
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    let pos = 0;
    let lines = 0;
    const end = Math.min(offset, st.size);
    while (pos < end) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
      if (bytesRead <= 0) break;
      for (let i = 0; i < bytesRead; i += 1) if (buf[i] === 10) lines += 1;
      pos += bytesRead;
    }
    return { line: lines + 1, exact: true };
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function readTailPreview(file, size, ctx) {
  const tail = await readTailLines(file, { size, maxLines: 10, maxBytes: 4096, maxLineChars: 200, signal: ctx.signal });
  return tail.entries.map((e) => `  ${e.text}`);
}

/** gzip 日志：解压后按行取尾部（文件大小先设上限，避免解压炸弹） */
export async function readGzipTail(file, { lines = 200, maxLineChars = DEFAULT_MAX_LINE_CHARS, signal } = {}) {
  const st = await statFile(file);
  if (st.size > 512 * 1024 * 1024) {
    throw new ToolError(`gzip 文件 ${formatBytes(st.size)} 太大，拒绝解压扫描`, { code: 'E_TOO_LARGE' });
  }
  const ring = [];
  const stream = fs.createReadStream(file).pipe(zlib.createGunzip());
  try {
    await streamLinesFromStream(stream, {
      maxLineChars,
      signal,
      onLine: (text) => {
        ring.push(text);
        while (ring.length > lines + 1) ring.shift();
      },
    });
  } finally {
    stream.destroy();
  }
  return ring.slice(-lines);
}

/** 从任意可读流逐行（沿用同一套单行截断策略） */
export async function streamLinesFromStream(stream, { maxLineChars = DEFAULT_MAX_LINE_CHARS, signal, onLine }) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let counter = 0;
  for await (const chunk of stream) {
    counter += 1;
    if (counter % 32 === 0 && signal?.aborted) break;
    pending += decoder.write(chunk);
    let nl;
    while ((nl = pending.indexOf('\n')) !== -1) {
      const raw = pending.slice(0, nl).replace(/\r$/, '');
      onLine(raw.length > maxLineChars ? `${raw.slice(0, maxLineChars)}…[截断]` : raw);
      pending = pending.slice(nl + 1);
    }
    if (pending.length > 4 * 1024 * 1024) pending = pending.slice(-1024 * 1024);
  }
  pending += decoder.end();
  if (pending) onLine(pending.replace(/\r$/, ''));
}

export const catTool = {
  name: 'cat',
  title: '读取文件内容',
  description:
    '读文本文件内容（只读），输出带行号。默认读前 200 行；文件很大时不会整读，而是先给一段末尾预览。' +
    '大文件请用 offset（字节偏移）+ limit 分片续读；只想看最新日志用 tail 更快。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（绝对路径，或相对 project 的路径）' },
      project: { type: 'string', description: '项目别名，来自 list_roots' },
      offset: { type: 'integer', description: '起始字节偏移，默认 0；续读时用上一次返回的 nextOffset' },
      limit: { type: 'integer', description: '最多返回多少行，默认 200，最大 20000' },
      lineNumbers: { type: 'boolean', description: '是否输出行号，默认 true' },
      maxLineChars: { type: 'integer', description: '单行最多输出多少字符，默认 4096' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    const project = str(args, 'project');
    const p = str(args, 'path');
    if (!p) throw new ToolError('必须传 path', { code: 'E_PARAM' });
    const offset = num(args, 'offset', 0, { min: 0 });
    const limit = num(args, 'limit', 200, { min: 1, max: 20000 });
    const lineNumbers = bool(args, 'lineNumbers', true);
    const maxLineChars = num(args, 'maxLineChars', DEFAULT_MAX_LINE_CHARS, { min: 80, max: 100000 });

    const target = await ctx.roots.resolveTarget(project, p);
    const allowed = await ctx.roots.checkAllowed(target.path);
    if (!allowed.exists) throw new ToolError(`文件不存在：${toPosix(allowed.abs)}`, { code: 'E_NOT_FOUND' });
    const st = await fsp.stat(allowed.real);
    if (st.isDirectory()) {
      throw new ToolError(`${toPosix(allowed.abs)} 是目录，不是文件`, {
        code: 'E_IS_DIR',
        hint: `[action] 用 ls path="${toPosix(allowed.abs)}" 看里面有什么`,
      });
    }

    const out = new Out({ tool: 'cat' }, { maxChars: ctx.config.maxTextChars });
    out.set('path', toPosix(allowed.abs));
    out.set('size', `${formatBytes(st.size)}/${st.size}B`);
    out.set('mtime', formatTime(st.mtime));

    if (st.size === 0) {
      out.push('');
      out.push('(空文件)');
      return out;
    }
    if (await sniffBinary(allowed.real)) {
      throw new ToolError(`这是二进制文件，不按文本返回：${toPosix(allowed.abs)}`, {
        code: 'E_BINARY',
        hint: '二进制内容会污染上下文。要看大小/时间用 stat；确实需要请在服务器上自行处理。',
      });
    }

    // 「整读」才拦截：显式给了 limit 说明对方就是要一个分片，照给
    const explicitLimit = args.limit !== undefined && args.limit !== null && args.limit !== '';
    if (offset === 0 && !explicitLimit && st.size > HARD_MAX_BYTES) {
      const preview = await readTailPreview(allowed.real, st.size, ctx);
      out.push('');
      out.push(`[hint] 文件较大（${formatBytes(st.size)}），没有整读。下面是末尾 ${preview.length} 行预览，用来判断内容类型。`);
      out.push('---- 尾部预览 ----');
      for (const line of preview) out.push(line);
      out.push('---- 预览结束 ----');
      out.push('');
      out.push('[action] 按需选一种读法（不要改用更大上限重试整读）：');
      out.push(`  · 看开头：cat path="${toPosix(allowed.abs)}" offset=0 limit=200`);
      out.push(`  · 看尾部：tail path="${toPosix(allowed.abs)}" lines=500`);
      out.push(`  · 找关键行：grep path="${toPosix(allowed.abs)}" pattern="ERROR|Exception" beforeContext=3 limit=100`);
      out.push(
        `  · 分片推进：cat path="${toPosix(allowed.abs)}" offset=<上一次的 nextOffset> limit=2000（每次返回都会给 nextOffset）`,
      );
      return out;
    }

    const startInfo = await linesBeforeOffset(allowed.real, offset);
    const slice = await readLinesRange(allowed.real, {
      startByte: offset,
      startLine: startInfo.line ?? 1,
      limit,
      maxLineChars,
      maxBytes: HARD_MAX_BYTES,
      signal: ctx.signal,
      deadline: ctx.deadline,
    });

    if (slice.lines.length === 0) {
      out.push('');
      out.push(
        offset >= st.size
          ? `(offset=${offset} 已到文件末尾，没有更多内容；文件总大小 ${formatBytes(st.size)})`
          : '(该位置之后没有可读的行)',
      );
      return out;
    }

    out.set('lines', `${slice.lines[0].line}-${slice.lines[slice.lines.length - 1].line}`);
    if (!startInfo.exact) out.set('lineNumberNote', 'offset 较大，行号为估算');
    out.push('');
    for (const l of slice.lines) {
      out.push(lineNumbers ? `${l.line}| ${l.text}` : l.text);
    }
    out.push('');

    if (slice.stats.stoppedEarly) {
      out.push(`[hint] 读到第 ${slice.lines[slice.lines.length - 1].line} 行就停了：${slice.stats.stopReason || '达到上限'}。`);
      out.push(
        `[action] 继续读下一片：cat path="${toPosix(allowed.abs)}" offset=${slice.nextByte} limit=${limit}` +
          (lineNumbers ? `（下一片行号从 ${slice.nextLine} 开始）` : ''),
      );
    } else if (slice.nextByte < st.size) {
      out.push(`[hint] 已读到文件 ${formatBytes(slice.nextByte)} / ${formatBytes(st.size)} 处。`);
      out.push(`[action] 继续：cat path="${toPosix(allowed.abs)}" offset=${slice.nextByte} limit=${limit}`);
    }
    if (slice.truncatedByLine || slice.stats.truncatedLongestLine) {
      out.push('[hint] 有超长行被截断（单行上限 4096 字符 / 硬上限 1MB）；需要完整内容请提高 maxLineChars 后按 offset 定位。');
    }
    return out;
  },
};
