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

/**
 * @typedef {object} StreamEntry
 * @property {string} [file] 文件路径
 * @property {number} line 行号（1 起，按「该行起点之前有多少个换行」计）
 * @property {number} byteStart 行起点字节偏移
 * @property {number} [byteEnd] 行结束字节偏移（含换行符）
 * @property {string} text 行内容（已按上限截断）
 * @property {boolean} [truncated] 本行是否被截断
 * @property {'before'|'after'} [context] 上下文行标记；命中行没有这个字段
 * @property {boolean} [match] 命中行标记
 */

/**
 * @typedef {object} StreamStats
 * @property {number} startByte
 * @property {number} endByte
 * @property {number} linesParsed 扫过的逻辑行数（含未输出的行）
 * @property {number} emitted 回调次数（含上下文行）
 * @property {number} bytesOut 输出字节数
 * @property {number} longestLineSeen 输出过的最大行字符数
 * @property {number} [discardedChars] 因超长被丢掉的字符数
 * @property {boolean} truncatedLongestLine
 * @property {boolean} stoppedEarly
 * @property {string | null} stopReason
 * @property {boolean} endedWithNewline
 * @property {boolean} sawAnyByte
 */

/**
 * @typedef {object} Deadline
 * @property {number} budgetMs
 * @property {() => boolean} expired
 * @property {() => number} elapsed
 */

/**
 * @typedef {object} StreamOptions
 * @property {number} [startByte] 起始字节偏移
 * @property {RegExp | null} [pattern] 只回调命中行
 * @property {number} [beforeContext] 命中行前带几行上下文
 * @property {number} [afterContext] 命中行后带几行上下文
 * @property {number} [maxLines] 最多回调多少条
 * @property {number} [maxBytes] 最多输出多少字节
 * @property {number} [longestLine] 单行硬上限，超过就丢中间
 * @property {number} [maxLineChars] 单行输出字符上限
 * @property {AbortSignal} [signal] 客户端断开信号
 * @property {Deadline} [deadline] 时间预算
 * @property {(entry: StreamEntry) => boolean | void} [onLine] 回调；返回 false 表示「够了，停止扫描」
 */

/**
 * @param {string} file
 * @returns {Promise<import('node:fs').Stats>}
 */
export async function statFile(file) {
  return fsp.stat(file);
}

/**
 * 二进制识别：NUL 或大量控制字符 → 不是给人看的文本。
 * @param {string} file
 * @returns {Promise<boolean>}
 */
export async function sniffBinary(file) {
  /** @type {import('node:fs/promises').FileHandle | undefined} */
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
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
    throw err;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * @param {RegExp | null} re
 * @param {string} text
 * @returns {RegExpExecArray | null}
 */
function matchAt(re, text) {
  if (!re) return null;
  re.lastIndex = 0;
  return re.exec(text);
}

/**
 * 数一段 Buffer 里的换行数，并记录最后一个换行的位置。
 * @param {Buffer} buf
 * @param {number} [from]
 * @param {number} [to]
 * @returns {{ n: number, last: number }}
 */
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
 * - 单行超长保护（保留开头、丢弃中间、换行照样数）、可中断、带时间预算
 * @param {string} file
 * @param {StreamOptions} [opts]
 * @returns {Promise<StreamStats>}
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

  /** @type {StreamStats} */
  const stats = {
    startByte,
    endByte: startByte,
    linesParsed: 0,
    emitted: 0,
    bytesOut: 0,
    longestLineSeen: 0,
    truncatedLongestLine: false,
    stoppedEarly: false,
    stopReason: null,
    endedWithNewline: false,
    sawAnyByte: false,
  };

  const stream = fs.createReadStream(file, { start: startByte, highWaterMark: CHUNK_SIZE });
  const decoder = new StringDecoder('utf8');

  let buffer = '';
  let bytesConsumed = startByte;
  let lineNo = 1;
  let discardingMiddle = false;
  let discardingStart = startByte; // 跨块丢弃时的真实行起点
  let checkCounter = 0;
  /** @type {{ line: number, byteStart: number, byteEnd: number, text: string, truncated: boolean }[]} */
  const before = [];
  let afterRemaining = 0;
  let limitReached = false;
  let callerStopped = false;

  /** @param {string} reason */
  const stopWith = (reason) => {
    if (!stats.stoppedEarly) {
      stats.stoppedEarly = true;
      stats.stopReason = reason;
    }
  };

  /** @param {StreamEntry} entry */
  const emit = (entry) => {
    stats.emitted += 1;
    stats.bytesOut += Buffer.byteLength(entry.text, 'utf8') + 2;
    if (entry.text.length > stats.longestLineSeen) stats.longestLineSeen = entry.text.length;
    if (entry.truncated) stats.truncatedLongestLine = true;
    // onLine 返回 false = 调用方已经够了（例如 grep 命中数到顶），立刻停，不再往下读
    if (onLine?.(entry) === false) callerStopped = true;
  };

  /** @returns {boolean} true 表示应当停止读取 */
  const hardStop = () => {
    if (callerStopped) {
      stopWith('调用方已取够结果，提前停止');
      return true;
    }
    if (limitReached) return true;
    if (stats.emitted >= maxLines) {
      limitReached = true;
      stopWith('达到行数上限 maxLines=' + maxLines);
      return true;
    }
    if (stats.bytesOut >= maxBytes) {
      limitReached = true;
      stopWith('达到输出上限 maxBytes=' + maxBytes);
      return true;
    }
    return false;
  };

  /**
   * @param {string} text
   * @param {number} byteStart
   * @param {number} byteEnd
   * @param {boolean} truncated
   */
  const handleLine = (text, byteStart, byteEnd, truncated) => {
    stats.linesParsed += 1;
    const body = truncated ? text : stripInvisible(text);
    const isMatch = !pattern || matchAt(pattern, body) !== null;

    if (isMatch) {
      if (beforeContext > 0 && before.length > 0) {
        for (const b of before) {
          emit({ file, line: b.line, byteStart: b.byteStart, byteEnd: b.byteEnd, text: b.text, truncated: b.truncated, context: 'before' });
          if (hardStop()) return;
        }
        before.length = 0;
      }
      emit({ file, line: lineNo, byteStart, byteEnd, text: body, truncated: Boolean(truncated), match: true });
      afterRemaining = afterContext;
      return;
    }

    if (afterRemaining > 0) {
      afterRemaining -= 1;
      emit({ file, line: lineNo, byteStart, byteEnd, text: body, truncated: Boolean(truncated), context: 'after' });
      return;
    }

    if (beforeContext > 0) {
      before.push({ line: lineNo, byteStart, byteEnd, text: body, truncated: Boolean(truncated) });
      while (before.length > beforeContext) before.shift();
    }
  };

  /**
   * 超长行（超过 longestLine）：只保留开头一段当预览，中间整段丢弃，遇到换行时按「一整行」输出一次。
   * @param {string} head
   * @returns {string}
   */
  const longLinePreview = (head) =>
    cleanLine(head, { maxLen: maxLineChars }).text +
    '…[本行超过 ' + Math.round(longestLine / 1024) + 'KB 上限，中间内容已丢弃；要完整内容请用 grep 精确定位到具体片段]';

  /**
   * @param {string} str
   * @returns {number}
   */
  const countNewlinesInText = (str) => {
    let n = 0;
    for (let i = 0; i < str.length; i += 1) if (str.charCodeAt(i) === 10) n += 1;
    return n;
  };

  /**
   * 去掉行尾的 \r。
   * @param {string} str
   * @param {number} nlIdx
   * @returns {string}
   */
  const byteAfterCrlf = (str, nlIdx) => {
    let end = nlIdx;
    if (end > 0 && str.charCodeAt(end - 1) === 13) end -= 1;
    return str.slice(0, end);
  };

  /**
   * 收尾一行。注意它不碰 buffer —— 剩余内容由调用方（drainLines / 分块循环）负责，
   * 否则会把「后面还没处理的行」一起冲掉（每块只出一行就是这么来的）。
   * @param {string} raw
   * @param {number} byteStart
   * @param {number} lineEnd
   * @param {number} discardedChars
   */
  const finalizeLine = (raw, byteStart, lineEnd, discardedChars) => {
    if (discardedChars > 0) stats.truncatedLongestLine = true;
    handleLine(discardedChars > 0 ? longLinePreview(raw) : raw, byteStart, lineEnd, discardedChars > 0);
    lineNo += 1;
  };

  /** 处理缓冲区里的完整行；@returns {boolean} true 表示应当停止读取 */
  const drainLines = () => {
    for (;;) {
      if (hardStop()) return true;
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const lineEnd = bytesConsumed - Buffer.byteLength(buffer.slice(nl + 1), 'utf8');
      let raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (raw.charCodeAt(raw.length - 1) === 13) raw = raw.slice(0, -1);
      const byteStart = lineEnd - 1 - Buffer.byteLength(raw, 'utf8');
      const discarded = raw.length > longestLine ? raw.length - longestLine : 0;
      if (discarded > 0) raw = raw.slice(0, longestLine);
      finalizeLine(raw, byteStart, lineEnd, discarded);
      if (hardStop()) return true;
      if (deadline && lineNo % 256 === 0 && deadline.expired()) {
        stopWith('达到单次调用时间预算 ' + deadline.budgetMs + 'ms');
        return true;
      }
    }
    return false;
  };

  try {
    for await (const chunk of stream) {
      checkCounter += 1;
      // 每 4 个 chunk（约 1MB）就看一次是否该收手：大文件上预算过期/客户端断开要尽快生效
      if (checkCounter % 4 === 0) {
        if (signal?.aborted) {
          stopWith('客户端已断开，停止扫描');
          break;
        }
        if (deadline && deadline.expired()) {
          stopWith('达到单次调用时间预算 ' + deadline.budgetMs + 'ms');
          break;
        }
      }

      const text = decoder.write(chunk);
      bytesConsumed += Buffer.byteLength(text, 'utf8');
      stats.sawAnyByte = true;

      if (discardingMiddle) {
        // 上一块就因为超长开始丢中间内容了：继续丢，直到遇到换行
        const nl = text.indexOf('\n');
        if (nl === -1) continue;
        const discardedChars = buffer.length + nl - longestLine;
        const droppedLines = countNewlinesInText(text.slice(0, nl));
        let rest = text.slice(nl + 1);
        const restBytes = Buffer.byteLength(rest, 'utf8');
        const lineEnd = bytesConsumed - restBytes - 1;
        const head = buffer;
        buffer = '';
        discardingMiddle = false;
        finalizeLine(head, discardingStart, lineEnd, discardedChars > 0 ? discardedChars : 1);
        // 块内被丢掉的换行也要计数，否则行号会随 chunk 边界漂移
        lineNo += droppedLines;
        if (hardStop()) break;
        if (rest.charCodeAt(0) === 10) rest = rest.slice(1);
        buffer = rest;
        if (drainLines()) break;
        continue;
      }

      buffer += text;

      if (buffer.indexOf('\n') === -1 && buffer.length > longestLine) {
        // 整块都没有换行且已经超过单行上限：留下开头，中间继续丢
        const discardedChars = buffer.length - longestLine;
        discardingStart = bytesConsumed - Buffer.byteLength(buffer, 'utf8');
        buffer = buffer.slice(0, longestLine);
        discardingMiddle = true;
        stats.truncatedLongestLine = true;
        stats.discardedChars = (stats.discardedChars || 0) + discardedChars;
        continue;
      }

      if (drainLines()) break;
    }

    const tailText = decoder.end();
    if (tailText) {
      bytesConsumed += Buffer.byteLength(tailText, 'utf8');
      buffer += tailText;
    }
    if (!stats.stoppedEarly) {
      if (buffer.length > 0) {
        const byteStart = bytesConsumed - Buffer.byteLength(buffer, 'utf8');
        const head = buffer;
        buffer = '';
        finalizeLine(head, byteStart, bytesConsumed, discardingMiddle ? 1 : 0);
      } else if (bytesConsumed > startByte) {
        stats.endByte = bytesConsumed;
      }
      stats.endedWithNewline = buffer.length === 0 && bytesConsumed > startByte && !discardingMiddle;
    }
  } finally {
    stream.destroy();
  }

  if (stats.endByte === startByte && bytesConsumed > startByte) stats.endByte = bytesConsumed;
  return stats;
}

/**
 * @typedef {object} LineSlice
 * @property {number} line 行号
 * @property {number} byteStart
 * @property {number} [byteEnd]
 * @property {string} text
 * @property {boolean} [truncated]
 */

/**
 * 分片读取：从 startByte 起读若干行。
 * @param {string} file
 * @param {{ startByte?: number, startLine?: number, limit?: number, maxBytes?: number, pattern?: RegExp | null, maxLineChars?: number, signal?: AbortSignal, deadline?: Deadline }} [options]
 * @returns {Promise<{ lines: LineSlice[], stats: StreamStats, truncatedByLine: boolean, nextByte: number, nextLine: number }>}
 */
export async function readLinesRange(
  file,
  { startByte = 0, startLine = 1, limit = 200, maxBytes = 256 * 1024, pattern = null, maxLineChars = DEFAULT_MAX_LINE_CHARS, signal, deadline } = {},
) {
  /** @type {LineSlice[]} */
  const out = [];
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
      // 「够了就停」：返回 false 让扫描立刻收手，不必把整块读完
      return out.length >= limit ? false : undefined;
    },
  });
  const last = out[out.length - 1];
  return {
    lines: out,
    stats,
    truncatedByLine: stats.truncatedLongestLine,
    // 下一片从「最后一条读到的行」之后开始（byteEnd 已含换行符，不会重复读同一行）
    nextByte: last?.byteEnd ?? stats.endByte,
    // 行号按「扫过多少行」推，不用 out.length —— 带上下文时 out 里会有重复行
    nextLine: startLine + stats.linesParsed,
  };
}

/**
 * @typedef {object} TailResult
 * @property {{ text: string, truncated: boolean }[]} entries
 * @property {number} [windowStart]
 * @property {number} [windowBytes]
 * @property {boolean} truncatedHead 更早的行没返回
 * @property {boolean} [windowTruncatedLine]
 * @property {string} [note]
 */

/**
 * 取文件末尾若干行。定位读，只碰文件尾部那一小段。
 * 对齐规则：窗口内第一个 \n 之后算起 → 最后 N 个完整行（和第 1 行同语义）。
 * @param {string} file
 * @param {{ size?: number, maxLines?: number, maxBytes?: number, maxLineChars?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<TailResult>}
 */
export async function readTailLines(file, { size, maxLines = 100, maxBytes = 256 * 1024, maxLineChars = DEFAULT_MAX_LINE_CHARS, signal } = {}) {
  const total = size ?? (await statFile(file)).size;
  if (total === 0) {
    return { entries: [], windowStart: 0, truncatedHead: false, note: '文件是空的' };
  }

  let windowSize = Math.min(TAIL_WINDOW, total);
  let windowStart = total - windowSize;
  /** @type {{ text: string, truncated: boolean }[]} */
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

/**
 * 只要末尾 N 个原始字节（看 JSON 尾巴、看截断的堆栈时有用）。
 * @param {string} file
 * @param {{ size?: number, bytes: number }} options
 * @returns {Promise<{ buffer: Buffer, start: number, total: number }>}
 */
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

/**
 * 数一个文件有多少行（唯一一处会全文件扫描的地方，调用方必须显式要）。
 * @param {string} file
 * @param {{ signal?: AbortSignal, deadline?: Deadline }} [options]
 * @returns {Promise<{ lines: number | null, bytes: number, aborted: boolean, reason?: string }>}
 */
export async function countLines(file, { signal, deadline } = {}) {
  /** @type {import('node:fs/promises').FileHandle | undefined} */
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
