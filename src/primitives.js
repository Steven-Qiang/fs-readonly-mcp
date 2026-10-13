// 只读 IO 原语。铁律：
//   - tail 只读文件末尾的窗口，成本与文件总大小无关（除非显式要 totalLines）；
//   - cat 的分片读不做全文件扫描，行号靠「本次分片的起点行号」推出；
//   - 任何一处都不会把整个文件读进内存。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { ToolError, cleanLine, stripInvisible } from './util.js';

export const CHUNK_SIZE = 256 * 1024;
export const LINE_HARD_CAP = 1024 * 1024; // 单行超过 1MB 直接截断，防止一行吃掉全部内存
export const DEFAULT_MAX_LINE_CHARS = 4096; // 输出给 AI 的单行字符上限
const TAIL_WINDOW = 256 * 1024;
const TAIL_WINDOW_MAX = 8 * 1024 * 1024; // 单个超长行时最多回退到 8MB

export async function statFile(file) {
  return fsp.stat(file);
}

/** 二进制识别：NUL 或大量控制字符 → 不是给人看的文本 */
export async function sniffBinary(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return false;
    const sample = buf.subarray(0, bytesRead);
    if (sample.includes(0)) return true;
    let ctrl = 0;
    for (const b of sample) {
      const printable = b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127);
      if (!printable) ctrl += 1;
    }
    return ctrl / sample.length > 0.1;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function matchAt(re, text) {
  if (!re) return null;
  re.lastIndex = 0;
  return re.exec(text);
}

function countNewlines(buf, from = 0, to = buf.length) {
  let n = 0;
  let last = -1;
  for (let i = from; i < to; i += 1) {
    if (buf[i] === 10) {
      n += 1;
      last = i;
    }
  }
  return { n, last };
}

/**
 * 流式扫描一个文件，逐行回调。ls/grep/cat/tail 的行语义全部由这里统一。
 * - 行号连续计数（按「该行起点之前有多少个换行」定义，跨分片续读不重不漏）
 * - 单行超长保护、可中断、带时间预算
 */
export async function streamLines(file, opts = {}) {
  const {
    startByte = 0,
    pattern = null,
    beforeContext = 0,
    afterContext = 0,
    maxLines = Infinity,
    maxBytes = Infinity,
    longestLine = LINE_HARD_CAP,
    maxLineChars = DEFAULT_MAX_LINE_CHARS,
    signal,
    onLine,
    deadline,
  } = opts;

  const stats = {
    startByte,
    endByte: startByte,
    lines: 0,
    bytesOut: 0,
    longestLineSeen: 0,
    truncatedLongestLine: false,
    stoppedEarly: false,
    stopReason: null,
    endedWithNewline: false,
  };

  let stream;
  try {
    stream = fs.createReadStream(file, { start: startByte, highWaterMark: CHUNK_SIZE });
  } catch (err) {
    if (err.code === 'ENOENT') throw new ToolError(`文件不存在：${file}`, { code: 'E_NOT_FOUND' });
    throw err;
  }

  const decoder = new StringDecoder('utf8');
  let pending = '';
  let skippingLongLine = false;
  let offset = startByte;
  let lineno = 1;
  let checkCounter = 0;
  const before = [];
  let afterRemaining = 0;

  const emit = (entry) => {
    stats.lines += 1;
    stats.bytesOut += Buffer.byteLength(entry.text, 'utf8') + 2;
    if (entry.text.length > stats.longestLineSeen) stats.longestLineSeen = entry.text.length;
    if (entry.truncated) stats.truncatedLongestLine = true;
    onLine(entry);
  };

  const hardStop = () => {
    if (stats.lines >= maxLines) {
      stats.stoppedEarly = true;
      stats.stopReason = `达到行数上限 maxLines=${maxLines}`;
      return true;
    }
    if (stats.bytesOut >= maxBytes) {
      stats.stoppedEarly = true;
      stats.stopReason = `达到输出上限 maxBytes=${maxBytes}`;
      return true;
    }
    return false;
  };

  const handleLine = (raw, startByteOfLine, endByteOfLine, truncated) => {
    const text = truncated ? raw : stripInvisible(raw);
    const isMatch = !pattern || matchAt(pattern, text) !== null;

    if (isMatch) {
      if (beforeContext > 0) {
        for (const b of before) {
          emit({ file, line: b.line, byteStart: b.byteStart, byteEnd: b.byteEnd, text: b.text, truncated: b.truncated, context: 'before' });
          if (hardStop()) return;
        }
        before.length = 0;
      }
      emit({ file, line: lineno, byteStart: startByteOfLine, byteEnd: endByteOfLine, text, truncated, match: true });
      afterRemaining = afterContext;
      return;
    }

    if (afterRemaining > 0) {
      afterRemaining -= 1;
      emit({ file, line: lineno, byteStart: startByteOfLine, byteEnd: endByteOfLine, text, truncated, context: 'after' });
      return;
    }

    if (beforeContext > 0) {
      before.push({ line: lineno, byteStart: startByteOfLine, byteEnd: endByteOfLine, text, truncated });
      while (before.length > beforeContext) before.shift();
    }
  };

  /** 返回 false 表示应当停止读取 */
  const processPending = (endByte, final) => {
    let start = 0;
    for (;;) {
      if (hardStop()) return false;
      const nl = pending.indexOf('\n', start);
      if (nl === -1) {
        if (final && start < pending.length) {
          const piece = pending.slice(start);
          const cleaned = cleanLine(piece.replace(/\r$/, ''), { maxLen: longestLine });
          const byteLen = Buffer.byteLength(piece, 'utf8');
          const startByteOfLine = endByte - byteLen;
          handleLine(cleaned.text, startByteOfLine, startByteOfLine + byteLen, cleaned.truncated);
          pending = '';
          lineno += 1;
          stats.endByte = endByte;
          stats.endedWithNewline = false;
        } else {
          pending = pending.slice(start);
        }
        return true;
      }
      const piece = pending.slice(start, nl);
      const cleaned = cleanLine(piece.replace(/\r$/, ''), { maxLen: longestLine });
      const consumed = pending.slice(start, nl + 1);
      const byteLen = Buffer.byteLength(consumed, 'utf8');
      const startByteOfLine = endByte - Buffer.byteLength(pending.slice(start), 'utf8');
      handleLine(cleaned.text, startByteOfLine, startByteOfLine + byteLen, cleaned.truncated);
      start = nl + 1;
      lineno += 1;
      stats.endByte = startByteOfLine + byteLen;
      stats.endedWithNewline = true;
      if (lineno % 512 === 0 && deadline && deadline.expired()) {
        stats.stoppedEarly = true;
        stats.stopReason = `达到单次调用时间预算 ${deadline.budgetMs}ms`;
        return false;
      }
    }
  };

  try {
    for await (const chunk of stream) {
      checkCounter += 1;
      if (checkCounter % 8 === 0) {
        if (signal?.aborted) {
          stats.stoppedEarly = true;
          stats.stopReason = '客户端已断开，停止扫描';
          break;
        }
        if (deadline && deadline.expired()) {
          stats.stoppedEarly = true;
          stats.stopReason = `达到单次调用时间预算 ${deadline.budgetMs}ms`;
          break;
        }
      }
      const text = decoder.write(chunk);
      offset += chunk.length;

      if (skippingLongLine || pending.length + text.length > longestLine) {
        if (!skippingLongLine) {
          pending += text.slice(0, Math.max(0, longestLine - pending.length));
          stats.truncatedLongestLine = true;
          skippingLongLine = true;
        }
        const nl = text.indexOf('\n');
        if (nl === -1) continue;
        skippingLongLine = false;
        pending = text.slice(nl + 1);
        lineno += 1; // 被截断的超长行在此收尾
        continue;
      }

      pending += text;
      if (!processPending(offset, false)) break;
    }
    const tailText = decoder.end();
    if (tailText) pending += tailText;
    if (!stats.stoppedEarly) processPending(offset, true);
  } finally {
    stream.destroy();
  }

  return stats;
}

/**
 * 分片读取：从 startByte 起读若干行。
 * 行号 = startLine（调用方给的起点行号）+ 序号，不做全文件扫描。
 */
export async function readLinesRange(file, { startByte = 0, startLine = 1, limit = 200, maxBytes = 256 * 1024, pattern = null, maxLineChars = DEFAULT_MAX_LINE_CHARS, signal, deadline } = {}) {
  const out = [];
  let truncatedByLine = false;
  const stats = await streamLines(file, {
    startByte,
    pattern,
    maxLines: limit,
    maxBytes,
    maxLineChars,
    signal,
    deadline,
    onLine: (entry) => {
      out.push({
        line: startLine + out.length,
        byteStart: entry.byteStart,
        byteEnd: entry.byteEnd,
        text: entry.text,
        truncated: entry.truncated,
      });
    },
  });
  if (stats.truncatedLongestLine) truncatedByLine = true;
  const last = out[out.length - 1];
  return {
    lines: out,
    stats,
    truncatedByLine,
    // 下一片从「最后一条完整读到的行」之后开始；一条都没读到就退化为文件末尾
    nextByte: last ? last.byteEnd : stats.endByte,
    nextLine: last ? last.line + 1 : startLine,
  };
}

/**
 * 取文件末尾若干行。定位读，只碰文件尾部那一小段。
 * 对齐规则：窗口内第一个 \n 之后算起 → 最后 N 个完整行（和第 1 行同语义）。
 */
export async function readTailLines(file, { size, maxLines = 100, maxBytes = 256 * 1024, maxLineChars = DEFAULT_MAX_LINE_CHARS, signal } = {}) {
  const total = size ?? (await statFile(file)).size;
  if (total === 0) {
    return { entries: [], windowStart: 0, truncatedHead: false, note: '文件是空的' };
  }

  let windowSize = Math.min(TAIL_WINDOW, total);
  let windowStart = total - windowSize;
  let entries = [];
  let truncatedHead = false;
  let windowTruncatedLine = false;

  for (;;) {
    if (signal?.aborted) throw new ToolError('客户端已断开', { code: 'E_ABORTED' });
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(windowSize);
      const { bytesRead } = await fh.read(buf, 0, windowSize, windowStart);
      const slice = buf.subarray(0, bytesRead);
      const start = windowStart === 0 ? 0 : slice.indexOf(0x0a) + 1;
      const text = slice.subarray(start).toString('utf8');
      const rawLines = text.split('\n');
      if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
      entries = [];
      let bytes = 0;
      for (let i = rawLines.length - 1; i >= 0; i -= 1) {
        const cleaned = cleanLine(rawLines[i].replace(/\r$/, ''), { maxLen: maxLineChars });
        bytes += Buffer.byteLength(cleaned.text, 'utf8') + 1;
        if (bytes > maxBytes && entries.length > 0) {
          truncatedHead = true;
          break;
        }
        if (cleaned.truncated) windowTruncatedLine = true;
        entries.unshift({ text: cleaned.text, truncated: cleaned.truncated });
      }
      truncatedHead = truncatedHead || (start > 0 && entries.length >= rawLines.length && rawLines.length < maxLines);
      if (entries.length >= maxLines || windowStart === 0 || windowSize >= TAIL_WINDOW_MAX) {
        // 行数够了，或者已经到头
        if (entries.length > maxLines) {
          truncatedHead = true;
          entries = entries.slice(entries.length - maxLines);
        }
        return {
          entries,
          windowStart: windowStart + start,
          windowBytes: windowSize - start,
          truncatedHead: truncatedHead || windowStart > 0,
          windowTruncatedLine,
        };
      }
    } finally {
      await fh.close().catch(() => {});
    }
    windowSize = Math.min(windowSize * 4, TAIL_WINDOW_MAX, total);
    windowStart = Math.max(0, total - windowSize);
  }
}

/** 只要末尾 N 个原始字节（看 JSON 尾巴、看截断的堆栈时有用） */
export async function readTailBytes(file, { size, bytes }) {
  const total = size ?? (await statFile(file)).size;
  const n = Math.min(bytes, total);
  const start = total - n;
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, start);
    return { buffer: buf.subarray(0, bytesRead), start, total };
  } finally {
    await fh.close().catch(() => {});
  }
}

/** 数一个文件有多少行（唯一一处会全文件扫描的地方，调用方必须显式要） */
export async function countLines(file, { signal, deadline } = {}) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const st = await fh.stat();
    const buf = Buffer.alloc(CHUNK_SIZE);
    let pos = 0;
    let lines = 0;
    let lastNewlinePos = -1;
    let counter = 0;
    while (pos < st.size) {
      counter += 1;
      if (counter % 16 === 0) {
        if (signal?.aborted) return { lines: null, aborted: true, bytes: st.size };
        if (deadline && deadline.expired()) return { lines: null, aborted: true, bytes: st.size, reason: '时间预算用尽' };
      }
      const want = Math.min(buf.length, st.size - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) break;
      const { n, last } = countNewlines(buf, 0, bytesRead);
      lines += n;
      if (last !== -1) lastNewlinePos = pos + last;
      pos += bytesRead;
    }
    if (st.size > 0 && lastNewlinePos !== st.size - 1) lines += 1;
    return { lines, bytes: st.size, aborted: false };
  } finally {
    await fh?.close().catch(() => {});
  }
}
