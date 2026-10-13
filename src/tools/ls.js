// ls：列目录。默认只列一层（最快）；depth>1 走有界 BFS，条目数封顶，超了给明确提示。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Out, bool, num, str } from './base.js';
import { ToolError, formatBytes, formatTime, makeNameMatcher, toPosix } from '../util.js';
import { listDir, walkFiles } from '../walk.js';

function typeMark(type) {
  if (type === 'dir') return 'd';
  if (type === 'file') return '-';
  if (type === 'broken') return '!';
  return '?';
}

export const lsTool = {
  name: 'ls',
  title: '列目录',
  description:
    '列目录内容（只读）。不传 path 时列出所有可读根目录；传 project 则从该项目的根/日志目录出发。' +
    '默认只列一层，快；需要看结构用 depth=2~4。输出格式：类型 d/- + 大小 + 修改时间 + 名字。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，绝对路径或相对 project 的路径。空 = 列根目录。' },
      project: { type: 'string', description: '项目别名，来自 list_roots' },
      depth: { type: 'integer', description: '递归层数，默认 1（只列当前层），最大 6' },
      pattern: { type: 'string', description: '名字通配，如 "*.log" / "*error*" / "{a,b}.log"' },
      filesOnly: { type: 'boolean', description: '只列文件，不列目录' },
      includeHidden: { type: 'boolean', description: '是否包含点开头的隐藏项，默认 true' },
      includeIgnored: { type: 'boolean', description: '是否包含 node_modules/.git/vendor 等默认忽略目录，默认 false' },
      maxEntries: { type: 'integer', description: '最多返回多少条，默认 300，最大 2000' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    const project = str(args, 'project');
    const relPath = str(args, 'path', '');
    const depth = num(args, 'depth', 1, { min: 1, max: 6 });
    const maxEntries = num(args, 'maxEntries', 300, { min: 1, max: 2000 });
    const filesOnly = bool(args, 'filesOnly', false);
    const includeHidden = bool(args, 'includeHidden', true);
    const includeIgnored = bool(args, 'includeIgnored', false);
    const pattern = str(args, 'pattern');
    const matcher = pattern ? makeNameMatcher(pattern) : null;
    const ignoreDirs = includeIgnored ? new Set() : ctx.config.ignoreDirs;

    const out = new Out({ tool: 'ls' }, { maxChars: ctx.config.maxTextChars });
    out.set('project', project);

    // 不指定 path/project → 相当于把根目录清单再说一遍
    if (!project && (relPath === '' || relPath === '.' || relPath === undefined)) {
      out.push('[meta] tool=ls 未指定 path/project，列出全部根目录');
      out.push('');
      for (const r of ctx.roots.describe()) {
        out.push(`project="${r.name}"  ${r.dirs.map(toPosix).join(' , ')}`);
      }
      out.push('');
      out.push(`[hint] 指定 path 或 project 再列一次，例如：ls project="${ctx.roots.names[0] || 'x'}" path=""`);
      return out;
    }

    const target = await ctx.roots.resolveTarget(project, relPath);
    const allowed = await ctx.roots.checkAllowed(target.path);
    if (!allowed.exists) {
      throw new ToolError(`路径不存在：${toPosix(allowed.abs)}`, { code: 'E_NOT_FOUND' });
    }
    const st = await fsp.stat(allowed.real);
    if (!st.isDirectory()) {
      out.push(`[meta] tool=ls path=${toPosix(allowed.abs)} 是文件不是目录`);
      out.push('');
      out.push(
        `${typeMark('file')} ${formatBytes(st.size)}  ${formatTime(st.mtime)}  ${toPosix(path.basename(allowed.abs))}`,
      );
      out.push('');
      out.push(
        `[hint] 这是个文件。看内容用 cat path="${toPosix(allowed.abs)}"，看尾部用 tail path="${toPosix(
          allowed.abs,
        )}"，元信息用 stat。`,
      );
      return out;
    }

    const base = allowed.real;
    out.set('path', toPosix(allowed.abs));
    out.set('depth', depth === 1 ? undefined : depth);
    out.set('pattern', pattern);

    if (depth === 1) {
      const { entries, moreByType, scanned } = await listDir(base, {
        limit: maxEntries,
        ignoreDirs,
        signal: ctx.signal,
      });
      const shownEntries = includeHidden ? entries : entries.filter((e) => !e.name.startsWith('.'));
      const filtered = matcher ? shownEntries.filter((e) => matcher(e.name)) : shownEntries;
      const visible = filesOnly ? filtered.filter((e) => e.type !== 'dir') : filtered;
      out.set('entries', visible.length);
      out.set('scanned', scanned);
      out.push('');
      for (const e of visible) {
        out.push(
          `${typeMark(e.type)} ${e.type === 'dir' ? '       -' : formatBytes(e.size ?? 0).padStart(8)}  ${
            e.mtime ? formatTime(e.mtime) : '                '
          }  ${e.name}${e.type === 'dir' ? '/' : ''}`,
        );
      }
      const more =
        (moreByType.dir || 0) + (moreByType.file || 0) + (moreByType.other || 0) + (filtered.length - visible.length);
      if (more > 0) {
        out.push('');
        out.push(`[hint] 还有约 ${more} 条没显示（目录 ${moreByType.dir} / 文件 ${moreByType.file}）。`);
        out.push('[action] 缩小范围：加 pattern="*.log"，或用 filesOnly=true，或提高 maxEntries，或直接定位到子目录。');
      }
      if (visible.length === 0) {
        out.push(
          matcher
            ? `(当前层没有匹配 "${pattern}" 的项${filesOnly ? '（且只列文件）' : ''})`
            : '(空目录，或全部被忽略规则过滤；includeIgnored=true 可包含 node_modules 等)',
        );
        if (!matcher) out.push('[hint] 想找下层的日志：ls path="." depth=3 pattern="*.log"。');
      }
      return out;
    }

    // 递归列目录：文件优先（找日志就是要找文件），目录按剩余额度补
    const walk = await walkFiles(base, {
      maxDepth: depth - 1,
      maxFiles: maxEntries,
      signal: ctx.signal,
      deadline: ctx.deadline,
      ignoreDirs,
      includeHidden,
    });
    const files = walk.files.filter((f) => !matcher || matcher(path.basename(f)));
    const dirs = filesOnly
      ? []
      : walk.dirsVisited
          .filter((d) => d !== base)
          .map((d) => toPosix(path.relative(base, d)))
          .filter((d) => !matcher || matcher(path.basename(d)));

    const dirBudget = Math.min(
      dirs.length,
      files.length >= maxEntries ? 0 : Math.max(5, Math.floor(maxEntries * 0.2)),
    );
    out.set('dirs', dirs.length);
    out.set('files', files.length);
    out.push('');
    for (const d of dirs.slice(0, dirBudget)) out.push(`d         -  ${d}/`);
    if (dirs.length > dirBudget) out.push(`d         -  …还有 ${dirs.length - dirBudget} 个目录未列出`);
    const fileBudget = Math.max(0, maxEntries - Math.min(dirs.length, dirBudget));
    for (const f of files.slice(0, fileBudget)) {
      let size = null;
      let mtime = null;
      try {
        const s = await fsp.stat(f);
        size = s.size;
        mtime = s.mtime;
      } catch {
        /* ignore */
      }
      out.push(
        `- ${formatBytes(size ?? 0).padStart(8)}  ${mtime ? formatTime(mtime) : '                '}  ${toPosix(
          path.relative(base, f),
        )}`,
      );
    }
    if (walk.stopReason) {
      out.push('');
      out.push(`[hint] 递归被截断：${walk.stopReason}。`);
      out.push('[action] 缩小 depth、加 pattern="*.log"，或从更具体的子目录出发。');
    } else if (files.length > fileBudget) {
      out.push('');
      out.push(`[hint] 还有 ${files.length - fileBudget} 个文件未列出（上限 maxEntries=${maxEntries}）。`);
      out.push('[action] 提高 maxEntries、加 pattern 过滤，或缩小 depth。');
    }
    if (files.length === 0 && dirs.length === 0) {
      out.push('(没有匹配项)');
    }
    return out;
  },
};
