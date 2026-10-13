// glob_files：按名字找文件。比 ls depth 更直接的「把这个项目下所有 xxx.log 列出来」。
import path from 'node:path';
import fsp from 'node:fs/promises';
import { z } from 'zod';
import { Out, defineTool } from './base.js';
import { ToolError, formatBytes, formatTime, makeNameMatcher, toPosix } from '../util.js';
import { walkFiles } from '../walk.js';

/**
 * 找最新修改的那个文件，供 hint 直接给出「看哪个」。
 * @param {string[]} files
 * @param {string} base
 * @returns {Promise<{ full: string, rel: string, mtimeMs: number } | null>}
 */
async function newestOf(files, base) {
  /** @type {{ full: string, rel: string, mtimeMs: number } | null} */
  let best = null;
  for (const f of files.slice(0, 500)) {
    try {
      const s = await fsp.stat(f);
      if (!best || s.mtimeMs > best.mtimeMs) {
        best = { full: toPosix(f), rel: toPosix(path.relative(base, f)), mtimeMs: s.mtimeMs };
      }
    } catch {
      /* ignore */
    }
  }
  return best;
}

export const globTool = defineTool({
  name: 'glob_files',
  title: '按名字找文件',
  description:
    '按文件名通配符递归找文件（只读），例如 pattern="*.log"、"*2026-01*"、"*error*"。' +
    '只返回路径和大小，不返回内容——先定位，再用 tail/grep/cat 看内容。',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('名字通配（支持 * ? {a,b}），如 "*.log" 或 "*error*"'),
    path: z.string().optional().describe('从哪个目录开始找；默认项目根'),
    project: z.string().optional().describe('项目别名，来自 list_roots'),
    maxDepth: z.number().int().min(1).max(10).optional().describe('递归深度，默认 6，最大 10'),
    limit: z.number().int().min(1).max(2000).optional().describe('最多返回多少个文件，默认 200，最大 2000'),
    includeHidden: z.boolean().optional().describe('是否包含隐藏文件/目录，默认 false'),
  }),
  async run(args, ctx) {
    const { pattern, project, path: relPath = '', maxDepth = 6, limit = 200, includeHidden = false } = args;
    const matcher = makeNameMatcher(pattern);

    const out = new Out({ tool: 'glob_files', pattern }, { maxChars: ctx.config.maxTextChars });
    const target = await ctx.roots.resolveTarget(project, relPath);
    const allowed = await ctx.roots.checkAllowed(target.path);
    if (!allowed.exists) throw new ToolError(`路径不存在：${toPosix(allowed.abs)}`, { code: 'E_NOT_FOUND' });
    const st = await fsp.stat(allowed.real);
    out.set('path', toPosix(allowed.abs));

    const walk = st.isDirectory()
      ? await walkFiles(allowed.real, {
          maxDepth,
          maxFiles: limit,
          signal: ctx.signal,
          deadline: ctx.deadline,
          ignoreDirs: ctx.config.ignoreDirs,
          includeHidden,
        })
      : { files: [allowed.real], stopReason: null, dirsVisited: [allowed.real] };

    /** @param {string} f @returns {string} */
    const rel = (f) => (st.isDirectory() ? toPosix(path.relative(allowed.real, f)) : toPosix(allowed.abs));
    const hits = st.isDirectory() ? walk.files.filter((f) => matcher(path.basename(f)) || matcher(rel(f))) : [allowed.real];

    out.set('found', hits.length);
    out.push('');
    if (hits.length === 0) {
      out.push(`(没有匹配 "${pattern}" 的文件；共扫过 ${walk.files.length} 个文件)`);
      out.push('[hint] 放宽到 pattern="*"、提高 maxDepth、includeHidden=true，或换个更短的片段再试。');
      return out;
    }
    for (const f of hits.slice(0, limit)) {
      let size = 0;
      let mtime = null;
      try {
        const s = await fsp.stat(f);
        size = s.size;
        mtime = s.mtime;
      } catch {
        /* ignore */
      }
      out.push(`${formatBytes(size).padStart(8)}  ${mtime ? formatTime(mtime) : '                '}  ${rel(f)}`);
    }
    out.push('');
    if (hits.length >= limit || walk.stopReason) {
      out.push(
        `[hint] 结果可能被截断（${walk.stopReason || `匹配上限 limit=${limit}`}）。` +
          '[action] 提高 limit、把 pattern 写精确，或指定更具体的 path。',
      );
    }
    if (st.isDirectory()) {
      const newest = await newestOf(hits, allowed.real);
      if (newest) out.push(`[hint] 最新的一个是 "${newest.rel}"，看它：tail path="${newest.full}" lines=200`);
    }
    return out;
  },
});
