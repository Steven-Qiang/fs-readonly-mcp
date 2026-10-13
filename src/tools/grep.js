// grep：跨文件、跨目录搜索。目标场景就是「日志散落各处，人肉翻太累」。
// 实现要点：每个文件独立流式扫描、并发上限、命中数与文件数双封顶、到点即停并明确告诉 AI 怎么收窄。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Out, bool, num, str } from './base.js';
import { ToolError, formatBytes, makeNameMatcher, toPosix } from '../util.js';
import { DEFAULT_MAX_LINE_CHARS, streamLines } from '../primitives.js';
import { mapPool, walkFiles } from '../walk.js';

const DEFAULT_GLOBS = ['*.log', '*.log.*', '*.txt', '*.out', '*.err', '*.json', '*.ndjson', '*.trace', '*.csv'];

export const grepTool = {
  name: 'grep',
  title: '搜索文件内容',
  description:
    '在文件或整个目录里搜索文本/正则（只读），逐行流式扫描，超大日志也能搜。' +
    '默认忽略 node_modules/.git/vendor，默认大小写不敏感，可带上下文行。返回 file:line: 内容。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要搜索的关键字或正则（默认大小写不敏感）' },
      path: { type: 'string', description: '文件或目录路径；目录会递归搜索。默认项目根。' },
      project: { type: 'string', description: '项目别名，来自 list_roots' },
      glob: { type: 'string', description: '只搜匹配这些名字的文件（逗号分隔），如 "*.log,*.err"；默认常见日志/文本类' },
      ignoreCase: { type: 'boolean', description: '是否忽略大小写，默认 true' },
      literal: { type: 'boolean', description: '按纯文本搜索、不当正则解释（含 . * ( ) 等字符时用），默认 false' },
      beforeContext: { type: 'integer', description: '每个命中行前面额外带几行上下文，默认 0，最大 10' },
      afterContext: { type: 'integer', description: '每个命中行后面额外带几行上下文，默认 0，最大 10' },
      maxDepth: { type: 'integer', description: '目录递归深度，默认 4，最大 8' },
      limit: { type: 'integer', description: '最多返回多少条命中行，默认 100，最大 1000' },
      maxFiles: { type: 'integer', description: '最多扫描多少个文件，默认 300，最大 3000' },
      includeHidden: { type: 'boolean', description: '是否搜索隐藏文件/目录，默认 false' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    const patternText = str(args, 'pattern');
    if (!patternText) throw new ToolError('必须传 pattern', { code: 'E_PARAM' });
    const project = str(args, 'project');
    const relPath = str(args, 'path', '');
    const globArg = str(args, 'glob');
    const ignoreCase = bool(args, 'ignoreCase', true);
    const literal = bool(args, 'literal', false);
    const beforeContext = num(args, 'beforeContext', 0, { min: 0, max: 10 });
    const afterContext = num(args, 'afterContext', 0, { min: 0, max: 10 });
    const maxDepth = num(args, 'maxDepth', 4, { min: 1, max: 8 });
    const limit = num(args, 'limit', 100, { min: 1, max: 1000 });
    const maxFiles = num(args, 'maxFiles', 300, { min: 1, max: 3000 });
    const includeHidden = bool(args, 'includeHidden', false);

    const src = literal ? patternText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : patternText;
    let regex;
    try {
      regex = new RegExp(src, ignoreCase ? 'i' : '');
    } catch (err) {
      throw new ToolError(`正则不合法：${patternText} → ${err.message}`, {
        code: 'E_REGEX',
        hint: '用 literal=true 按纯文本搜，或修正正则',
      });
    }

    const nameMatcher = makeNameMatcher(globArg ? globArg.split(',') : DEFAULT_GLOBS);

    const out = new Out({ tool: 'grep', pattern: patternText }, { maxChars: ctx.config.maxTextChars });
    if (literal) out.set('literal', true);
    if (!ignoreCase) out.set('ignoreCase', false);

    const target = await ctx.roots.resolveTarget(project, relPath === undefined ? '' : relPath);
    const allowed = await ctx.roots.checkAllowed(target.path);
    if (!allowed.exists) throw new ToolError(`路径不存在：${toPosix(allowed.abs)}`, { code: 'E_NOT_FOUND' });
    const st = await fsp.stat(allowed.real);
    out.set('path', toPosix(allowed.abs));

    let files = [];
    let walkInfo = null;
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
      out.set('walked', `${walk.files.length} files`);
      if (files.length === 0) {
        out.push('');
        out.push(`(目录 ${toPosix(allowed.abs)} 下没有可搜的文件，或都被 glob / 忽略规则过滤了)`);
        out.push('[hint] 放宽 glob（如 glob="*"）、提高 maxDepth，或 includeHidden=true 再试。');
        return out;
      }
    } else {
      files = [allowed.real];
    }

    const matches = [];
    let filesWithMatch = 0;
    let filesScanned = 0;
    let bytesScanned = 0;
    let stopped = null;

    await mapPool(files, 4, async (file) => {
      if (stopped || ctx.signal?.aborted) {
        stopped = stopped || '客户端已断开';
        return null;
      }
      if (ctx.deadline?.expired()) {
        stopped = stopped || '时间预算用尽';
        return null;
      }
      if (matches.length >= limit) {
        stopped = stopped || `命中数达到上限 limit=${limit}`;
        return null;
      }
      filesScanned += 1;
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
            if (matches.length >= limit) {
              stopped = stopped || `命中数达到上限 limit=${limit}`;
              return;
            }
            if (!entry.context) localHits += 1;
            matches.push({
              file: display,
              line: entry.line,
              text: entry.text,
              context: entry.context,
              truncated: entry.truncated,
            });
          },
        });
        bytesScanned += stats.endByte;
        if (localHits > 0) filesWithMatch += 1;
      } catch (err) {
        if (err instanceof ToolError && err.code === 'E_NOT_FOUND') return null;
        matches.push({ file: display, line: 0, text: `[读取失败] ${err.message}`, error: true });
      }
      return null;
    });

    out.set('matches', matches.length);
    out.set('filesScanned', filesScanned);
    out.push('');

    if (matches.length === 0) {
      out.push(`(没有命中 "${patternText}"${st.isDirectory() ? `，已扫描 ${filesScanned} 个文件` : ''})`);
      out.push(
        '[hint] 没命中时按顺序试：① 去掉 glob 限制 glob="*"；② includeHidden=true；③ 提高 maxDepth；④ 把关键字换短一点或换成正则片段。',
      );
      if (walkInfo?.stopReason) out.push(`[hint] 补充：目录遍历被截断（${walkInfo.stopReason}），可能还有文件没扫到。`);
      if (stopped) out.push(`[hint] 另外本次是提前停止的：${stopped}`);
      return out;
    }

    let lastFile = null;
    for (const m of matches) {
      if (m.file !== lastFile) {
        out.push(`${m.file}`);
        lastFile = m.file;
      }
      const mark = m.context ? '-' : ':';
      out.push(`  ${m.line}${mark} ${m.text}`);
    }

    out.push('');
    out.push(
      `[meta] 命中 ${matches.length} 行，分布在 ${filesWithMatch} 个文件；已扫描 ${filesScanned} 个文件 / ${formatBytes(bytesScanned)}。`,
    );
    if (stopped) {
      out.push(`[hint] 已提前停止：${stopped}。`);
      out.push(
        `[action] 收窄范围再搜：限定目录 path="<更具体的子目录>"、加 glob="*.err"、把 pattern 写具体（例如带上 traceId），或把 limit 提到 ${limit * 5}。`,
      );
    }
    if (walkInfo?.stopReason) {
      out.push(`[hint] 目录遍历也被截断：${walkInfo.stopReason}；提高 maxFiles/maxDepth 可覆盖更多文件。`);
    }
    return out;
  },
};
