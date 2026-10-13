// tail：看文件末尾。只读文件尾部窗口，成本与文件总大小无关（看大日志首选）。
import fsp from 'node:fs/promises';
import { Out, bool, num, str } from './base.js';
import { ToolError, formatBytes, formatTime, toPosix } from '../util.js';
import { DEFAULT_MAX_LINE_CHARS, countLines, readTailBytes, readTailLines, statFile } from '../primitives.js';
import { readGzipTail } from './cat.js';

const NUMBER_IF_SMALLER_THAN = 2 * 1024 * 1024; // 小于 2MB 才顺手把总行数算出来

async function tailOne(allowed, ctx, out, { label, lines, bytes, maxLineChars, number, mode }) {
  const st = await statFile(allowed.real);
  if (st.isDirectory()) {
    throw new ToolError(`${toPosix(allowed.abs)} 是目录`, {
      code: 'E_IS_DIR',
      hint: `[action] 用 ls path="${toPosix(allowed.abs)}" 看里面的文件`,
    });
  }
  if (st.size === 0) {
    out.push(`${label}${toPosix(allowed.abs)}  (空文件)`);
    return;
  }
  out.push(`${label}${toPosix(allowed.abs)}  (${formatBytes(st.size)}, ${formatTime(st.mtime)})`);

  if (mode === 'bytes') {
    const { buffer, start } = await readTailBytes(allowed.real, { size: st.size, bytes });
    out.push(`---- 末 ${buffer.length} 字节（起点 offset ${start}）----`);
    out.push(buffer.toString('utf8'));
    out.push('---- 结束 ----');
    return;
  }

  if (/\.gz$/i.test(allowed.abs)) {
    const rows = await readGzipTail(allowed.real, { lines, maxLineChars, signal: ctx.signal });
    out.push('[note] 这是 gzip 文件，已解压后取末尾');
    out.push(`---- 末 ${rows.length} 行 ----`);
    for (const r of rows) out.push(r);
    out.push('---- 结束 ----');
    return;
  }

  const tail = await readTailLines(allowed.real, {
    size: st.size,
    maxLines: lines,
    maxLineChars,
    signal: ctx.signal,
  });
  let startLine = null;
  if (number) {
    if (st.size <= NUMBER_IF_SMALLER_THAN) {
      const counted = await countLines(allowed.real, { signal: ctx.signal, deadline: ctx.deadline });
      if (counted.lines !== null) {
        startLine = counted.lines - tail.entries.length + 1;
        out.set('totalLines', counted.lines);
      }
    } else {
      out.push('[note] 文件较大，没算总行号；要精确行号请用 cat offset 定位');
    }
  }
  if (tail.entries.length === 0) {
    out.push('(没有可读的行)');
    return;
  }
  out.set('shown', `${tail.entries.length}${lines ? `/${lines}` : ''}`);
  out.push(`---- 末 ${tail.entries.length} 行 ----`);
  for (let i = 0; i < tail.entries.length; i += 1) {
    const e = tail.entries[i];
    out.push(number && startLine !== null ? `${startLine + i}| ${e.text}` : e.text);
  }
  out.push('---- 结束 ----');
  if (tail.truncatedHead) {
    out.push('[hint] 只返回了文件末尾这些行，更早的内容没有带出来。');
    out.push(
      `[action] 要更多：tail path="${toPosix(allowed.abs)}" lines=${Math.min(lines * 4, 5000)}；` +
        `按关键字定位：grep path="${toPosix(allowed.abs)}" pattern="ERROR" beforeContext=2；` +
        `按位置推进：cat path="${toPosix(allowed.abs)}" offset=<字节偏移> limit=2000。`,
    );
  }
}

export const tailTool = {
  name: 'tail',
  title: '看文件末尾',
  description:
    '读取文件末尾若干行（只读），与文件总大小无关，是看大日志最快的方式。' +
    '支持多文件一次对比；.gz 日志自动解压后取尾部；mode=bytes 可直接看末 N 字节。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径；多个文件用英文逗号分隔' },
      project: { type: 'string', description: '项目别名，来自 list_roots' },
      lines: { type: 'integer', description: '看末尾多少行，默认 100，最大 5000' },
      bytes: { type: 'integer', description: '配合 mode=bytes：看末尾多少字节，默认 4096，最大 1048576' },
      mode: { type: 'string', enum: ['lines', 'bytes'], description: 'lines（默认，按行）或 bytes（按原始字节）' },
      number: { type: 'boolean', description: '是否带行号（文件小于 2MB 时精确），默认 false' },
      maxLineChars: { type: 'integer', description: '单行最多输出多少字符，默认 4096' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx) {
    const project = str(args, 'project');
    const rawPath = str(args, 'path');
    if (!rawPath) throw new ToolError('必须传 path', { code: 'E_PARAM' });
    const lines = num(args, 'lines', 100, { min: 1, max: 5000 });
    const bytes = num(args, 'bytes', 4096, { min: 1, max: 1024 * 1024 });
    const mode = str(args, 'mode', 'lines') === 'bytes' ? 'bytes' : 'lines';
    const number = bool(args, 'number', false);
    const maxLineChars = num(args, 'maxLineChars', DEFAULT_MAX_LINE_CHARS, { min: 80, max: 100000 });

    const out = new Out({ tool: 'tail', mode }, { maxChars: ctx.config.maxTextChars });
    const paths = rawPath
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (paths.length > 10) throw new ToolError('一次最多 tail 10 个文件', { code: 'E_PARAM' });

    for (let i = 0; i < paths.length; i += 1) {
      const target = await ctx.roots.resolveTarget(project, paths[i]);
      const allowed = await ctx.roots.checkAllowed(target.path);
      if (!allowed.exists) throw new ToolError(`文件不存在：${toPosix(allowed.abs)}`, { code: 'E_NOT_FOUND' });
      await tailOne(allowed, ctx, out, {
        label: paths.length > 1 ? '== ' : '',
        lines,
        bytes,
        maxLineChars,
        number,
        mode,
      });
      if (paths.length > 1 && i !== paths.length - 1) out.push('');
    }
    return out;
  },
};
