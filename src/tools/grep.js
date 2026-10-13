// grep：跨文件、跨目录搜索。目标场景就是「日志散落各处，人肉翻太累」。
// 实现要点：每个文件独立流式扫描、并发上限、命中数与文件数双封顶、到点即停并明确告诉 AI 怎么收窄。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Out, defineTool } from './base.js';
import { ToolError, formatBytes, makeNameMatcher, toPosix } from '../util.js';
import { DEFAULT_MAX_LINE_CHARS, streamLines } from '../primitives.js';
import { createHeavyGate, mapPool, walkFiles } from '../walk.js';

const DEFAULT_GLOBS = ['*.log', '*.log.*', '*.txt', '*.out', '*.err', '*.json', '*.ndjson', '*.trace', '*.csv'];

// 单次调用最多读多少字节。这是防「为凑够 N 条命中把整年日志读完」的硬闸：
// 超过就停，并告诉 AI 已经扫了多少、怎么收窄。
const DEFAULT_SCAN_BYTES = 256 * 1024 * 1024;
// 同一时刻全局只允许 2 个重扫描（AI 超时重试时不会叠加把 IO 打满）
const heavyGate = createHeavyGate(2);

export const grepTool = defineTool({
  name: 'grep',
  title: '搜索文件内容',
  description:
    '在文件或整个目录里搜索文本/正则（只读），逐行流式扫描，超大日志也能搜。' +
    '默认忽略 node_modules/.git/vendor，默认大小写不敏感，可带上下文行。' +
    '注意：limit 限的是「返回多少条命中」，另外还有单次最多读 256MB 的扫描预算（maxScanBytes）；' +
    '命中稀疏时会在读满后停止并提示怎么收窄——搜大范围日志请先用更窄的 glob（如 2026-10-1*.log）或更具体的子目录。',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('要搜索的关键字或正则（默认大小写不敏感）'),
    path: z.string().optional().describe('文件或目录路径；目录会递归搜索。默认项目根。'),
    project: z.string().optional().describe('项目别名，来自 list_roots'),
    glob: z.string().optional().describe('只搜匹配这些名字的文件（逗号分隔），如 "*.log,*.err"；默认常见日志/文本类'),
    ignoreCase: z.boolean().optional().describe('是否忽略大小写，默认 true'),
    literal: z.boolean().optional().describe('按纯文本搜索、不当正则解释（含 . * ( ) 等字符时用），默认 false'),
    beforeContext: z.number().int().min(0).max(10).optional().describe('每个命中行前面额外带几行上下文，默认 0'),
    afterContext: z.number().int().min(0).max(10).optional().describe('每个命中行后面额外带几行上下文，默认 0'),
    maxDepth: z.number().int().min(1).max(8).optional().describe('目录递归深度，默认 4，最大 8'),
    limit: z.number().int().min(1).max(1000).optional().describe('最多返回多少条命中行，默认 100，最大 1000'),
    maxFiles: z.number().int().min(1).max(3000).optional().describe('最多扫描多少个文件，默认 300，最大 3000'),
    maxScanBytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(8 * 1024 * 1024 * 1024)
      .optional()
      .describe('单次调用最多读多少字节（默认 256MB）。命中稀少时会在读满后停止并提示收窄，需要更大范围请显式提高'),
    includeHidden: z.boolean().optional().describe('是否搜索隐藏文件/目录，默认 false'),
  }),
  async run(args, ctx) {
    const {
      pattern: patternText,
      project,
      path: relPath = '',
      glob: globArg,
      ignoreCase = true,
      literal = false,
      beforeContext = 0,
      afterContext = 0,
      maxDepth = 4,
      limit = 100,
      maxFiles = 300,
      maxScanBytes = DEFAULT_SCAN_BYTES,
      includeHidden = false,
    } = args;

    const src = literal ? patternText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : patternText;
    /** @type {RegExp} */
    let regex;
    try {
      regex = new RegExp(src, ignoreCase ? 'i' : '');
    } catch (err) {
      throw new ToolError(`正则不合法：${patternText} → ${/** @type {Error} */ (err).message}`, {
        code: 'E_REGEX',
        hint: '用 literal=true 按纯文本搜，或修正正则',
      });
    }
    const nameMatcher = makeNameMatcher(globArg ? globArg.split(',') : DEFAULT_GLOBS);

    const out = new Out({ tool: 'grep', pattern: patternText }, { maxChars: ctx.config.maxTextChars });
    if (literal) out.set('literal', true);
    if (!ignoreCase) out.set('ignoreCase', false);

    const target = await ctx.roots.resolveTarget(project, relPath);
    const allowed = await ctx.roots.checkAllowed(target.path);
    if (!allowed.exists) throw new ToolError(`路径不存在：${toPosix(allowed.abs)}`, { code: 'E_NOT_FOUND' });
    const st = await fsp.stat(allowed.real);
    out.set('path', toPosix(allowed.abs));

    /** @type {string[]} */
    let files = [];
    /** @type {Awaited<ReturnType<typeof walkFiles>> | null} */
    let walkInfo = null;
    /** @type {string | null} */
    let stopped = null;
    // 重活走全局闸门：同时最多 2 个递归扫描，避免 AI 超时重试叠加把服务器 IO 打满
    const gateWaitStart = Date.now();
    const scanResult = await heavyGate(async () => {
      if (st.isDirectory()) {
        const walk = await walkFiles(allowed.real, {
          maxDepth,
          maxFiles,
          signal: ctx.signal,
          deadline: ctx.deadline,
          ignoreDirs: ctx.config.ignoreDirs,
          includeHidden,
        });
        walkInfo = walk;
        files = walk.files.filter((f) => nameMatcher(path.basename(f)));
      } else {
        files = [allowed.real];
      }

      /** @type {{ file: string, line: number, text: string, context?: 'before'|'after', truncated?: boolean }[]} */
      const collected = [];
      /** @type {{ file: string, message: string }[]} */
      const errors = [];
      let withMatch = 0;
      let scannedFiles = 0;
      let scannedBytes = 0;
      let longLineSeen = false;
      /** @type {string | null} */
      let stop = null;

      await mapPool(files, 3, async (file) => {
        if (stop || ctx.signal?.aborted) {
          stop = stop || '客户端已断开';
          return null;
        }
        if (ctx.deadline?.expired()) {
          stop = stop || '时间预算用尽';
          return null;
        }
        if (collected.length >= limit) {
          stop = stop || `命中数达到上限 limit=${limit}`;
          return null;
        }
        // 扫描量预算：命中稀少时不要为了凑数把整年日志读完
        if (scannedBytes >= maxScanBytes) {
          stop = stop || `扫描量达到上限 maxScanBytes=${formatBytes(maxScanBytes)}`;
          return null;
        }
        scannedFiles += 1;
        const display = toPosix(st.isDirectory() ? path.relative(allowed.real, file) : allowed.abs);
        let localHits = 0;
        try {
          const stats = await streamLines(file, {
            pattern: regex,
            beforeContext,
            afterContext,
            maxLineChars: DEFAULT_MAX_LINE_CHARS,
            signal: ctx.signal,
            deadline: ctx.deadline,
            maxLines: Infinity,
            maxBytes: Infinity,
            onLine: (entry) => {
              // 命中数到顶：返回 false 让 streamLines 立刻收手，
              // 否则会把这个文件剩下的几 GB 继续 regex 扫完再丢结果
              if (collected.length >= limit) {
                stop = stop || `命中数达到上限 limit=${limit}`;
                return false;
              }
              if (!entry.context) localHits += 1;
              collected.push({
                file: display,
                line: entry.line,
                text: entry.text,
                context: entry.context,
                truncated: entry.truncated,
              });
              return collected.length >= limit ? false : undefined;
            },
          });
          scannedBytes += stats.endByte - stats.startByte;
          if (stats.truncatedLongestLine) longLineSeen = true;
          if (localHits > 0) withMatch += 1;
        } catch (err) {
          if (err instanceof ToolError && err.code === 'E_NOT_FOUND') return null;
          errors.push({ file: display, message: /** @type {Error} */ (err).message });
        }
        return null;
      });

      return { collected, errors, withMatch, scannedFiles, scannedBytes, longLineSeen, stop };
    });
    const gateWaitMs = Date.now() - gateWaitStart;

    const matches = scanResult.collected;
    const readErrors = scanResult.errors;
    const filesWithMatch = scanResult.withMatch;
    const filesScanned = scanResult.scannedFiles;
    const bytesScanned = scanResult.scannedBytes;
    const truncatedLongLineInFile = scanResult.longLineSeen;
    stopped = scanResult.stop;
    const walkDetail = /** @type {Awaited<ReturnType<typeof walkFiles>> | null} */ (walkInfo);
    if (walkDetail) out.set('walked', `${walkDetail.files.length} files`);
    if (gateWaitMs > 500) out.set('queued', `${gateWaitMs}ms`);

    out.set('matches', matches.length);
    out.set('filesScanned', filesScanned);
    out.push('');

    if (files.length === 0 && st.isDirectory()) {
      out.push(`(目录 ${toPosix(allowed.abs)} 下没有可搜的文件，或都被 glob / 忽略规则过滤了)`);
      out.push('[hint] 放宽 glob（如 glob="*"）、提高 maxDepth，或 includeHidden=true 再试。');
      return out;
    }

    if (matches.length === 0) {
      out.push(`(没有命中 "${patternText}"${st.isDirectory() ? `，已扫描 ${filesScanned} 个文件` : ''})`);
      out.push(
        '[hint] 没命中时按顺序试：① 去掉 glob 限制 glob="*"；② includeHidden=true；③ 提高 maxDepth；④ 把关键字换短一点或换成正则片段。',
      );
      if (walkDetail?.stopReason) out.push(`[hint] 补充：目录遍历被截断（${walkDetail.stopReason}），可能还有文件没扫到。`);
      if (stopped) out.push(`[hint] 另外本次是提前停止的：${stopped}`);
      return out;
    }

    let lastFile = null;
    for (const m of matches) {
      if (m.file !== lastFile) {
        out.push(`${m.file}`);
        lastFile = m.file;
      }
      out.push(`  ${m.line}${m.context ? '-' : ':'} ${m.text}`);
    }

    out.push('');
    out.push(
      `[meta] 命中 ${matches.length} 行，分布在 ${filesWithMatch} 个文件；已扫描 ${filesScanned} 个文件 / ${formatBytes(bytesScanned)}。`,
    );
    const stopReason = /** @type {string | null} */ (stopped);
    if (stopReason) {
      out.push(`[hint] 已提前停止：${stopReason}。`);
      const isScanCap = stopReason.includes('maxScanBytes');
      out.push(
        isScanCap
          ? `[action] 本次只读了 ${formatBytes(bytesScanned)} 就停了（上限 ${formatBytes(maxScanBytes)}）。命中太稀疏时不要靠加大上限硬搜：把 path 收到具体子目录、把 glob 写成 "2026-10-1*.log" 这种更窄的时间片，或把 pattern 换成一个必然出现的前缀（例如只搜 "Call to undefined"）。确实要更大范围再显式加 maxScanBytes=${maxScanBytes * 4}。`
          : `[action] 收窄范围再搜：限定目录 path="<更具体的子目录>"、加 glob="*.err"、把 pattern 写具体（例如带上 traceId），或把 limit 提到 ${limit * 5}。`,
      );
    }
    if (walkDetail?.stopReason) {
      out.push(`[hint] 目录遍历也被截断：${walkDetail.stopReason}；提高 maxFiles/maxDepth 可覆盖更多文件。`);
    }
    if (truncatedLongLineInFile) {
      out.push('[hint] 有文件含超长行（>1MB），这类行只搜了开头 1MB；如果关键字在超长行靠后位置，可能漏报。');
    }
    if (readErrors.length > 0) {
      out.push('');
      out.push(`[hint] 另有 ${readErrors.length} 个文件读取失败（未计入上面的命中数）：`);
      for (const e of readErrors.slice(0, 5)) out.push(`  · ${e.file} → ${e.message}`);
      if (readErrors.length > 5) out.push(`  · …还有 ${readErrors.length - 5} 个`);
      out.push('[action] 失败多为权限不足或文件被删除；需要看单个文件时直接对它调 cat/tail。');
    }
    return out;
  },
});
