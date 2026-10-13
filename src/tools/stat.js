// stat：文件元信息 + 尾部预览。用来「先搞清楚这是什么文件、有多大、在不在写」，再决定怎么读。
import fsp from 'node:fs/promises';
import { z } from 'zod';
import { Out, defineTool } from './base.js';
import { ToolError, formatBytes, formatTime, toPosix } from '../util.js';
import { countLines, readTailLines, sniffBinary } from '../primitives.js';

const COUNT_LINES_MAX = 64 * 1024 * 1024; // 超过这个大小就不数行数了（数行要全文件扫描）

function ago(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.round(ms / 60000)} 分钟前`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} 小时前`;
  return `${(ms / 86_400_000).toFixed(1)} 天前`;
}

export const statTool = defineTool({
  name: 'stat',
  title: '文件/目录元信息',
  description:
    '查看路径的大小、修改时间、权限、是否二进制、行数（小文件），并给出末尾几行预览，' +
    '用来判断「这是不是我要找的日志、它还在不在写、该用哪种读法」。',
  inputSchema: z.object({
    path: z.string().min(1).describe('文件或目录路径；也可以传逗号分隔的多个路径'),
    project: z.string().optional().describe('项目别名，来自 list_roots'),
    previewLines: z.number().int().min(0).max(50).optional().describe('末尾预览行数，默认 3，0 = 不预览'),
    countLines: z.boolean().optional().describe('是否统计总行数（仅对 <=64MB 的文件生效），默认 true'),
  }),
  async run(args, ctx) {
    const { path: rawPath, project, previewLines = 3, countLines: wantCount = true } = args;
    const out = new Out({ tool: 'stat' }, { maxChars: ctx.config.maxTextChars });
    const paths = rawPath
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (paths.length > 20) throw new ToolError('一次最多 stat 20 个路径', { code: 'E_PARAM' });

    for (const one of paths) {
      const target = await ctx.roots.resolveTarget(project, one);
      const allowed = await ctx.roots.checkAllowed(target.path);
      if (!allowed.exists) {
        out.push(`${toPosix(allowed.abs)}  →  不存在`);
        continue;
      }
      const st = await fsp.stat(allowed.real);
      const ageMs = Date.now() - st.mtimeMs;
      out.push(toPosix(allowed.abs));
      out.push(
        `  type=${st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'} size=${formatBytes(st.size)}(${st.size}B) ` +
          `mtime=${formatTime(st.mtime)} mode=${(st.mode & 0o777).toString(8)}`,
      );
      out.push(`  lastWrite=${ago(ageMs)}${ageMs < 300_000 ? '  ← 正在写（近 5 分钟有更新）' : ''}`);

      if (st.isDirectory()) {
        out.push(`  [action] ls path="${toPosix(allowed.abs)}" 看里面的文件`);
        out.push('');
        continue;
      }
      if (await sniffBinary(allowed.real)) {
        out.push('  [注意] 二进制文件，内容不按文本返回');
        out.push('');
        continue;
      }
      if (wantCount) {
        if (st.size <= COUNT_LINES_MAX) {
          const counted = await countLines(allowed.real, { signal: ctx.signal, deadline: ctx.deadline });
          out.push(counted.lines === null ? '  lines=未统计（超时）' : `  lines=${counted.lines}`);
        } else {
          out.push(`  lines=未统计（${formatBytes(st.size)} 超过 64MB，数行需全文件扫描）`);
        }
      }
      if (previewLines > 0 && st.size > 0) {
        const tail = await readTailLines(allowed.real, {
          size: st.size,
          maxLines: previewLines,
          maxBytes: 2048,
          signal: ctx.signal,
        });
        out.push(`  末尾 ${tail.entries.length} 行预览：`);
        for (const e of tail.entries) out.push(`    | ${e.text}`);
      }
      out.push(
        `  [action] 看尾部：tail path="${toPosix(allowed.abs)}" lines=200 ｜ 找关键字：grep path="${toPosix(
          allowed.abs,
        )}" pattern="ERROR"`,
      );
      out.push('');
    }
    return out;
  },
});
