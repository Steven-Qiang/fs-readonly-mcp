// list_roots：AI 的入口。先看清「这台机器上我能读什么」，再决定 ls/grep 打哪儿。
import fsp from 'node:fs/promises';
import { z } from 'zod';
import { Out, defineTool } from './base.js';
import { toPosix } from '../util.js';

/**
 * 探测一个目录当前是否可读，结果直接写进给 AI 的清单里。
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function probe(dir) {
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return `不是目录（${st.isFile() ? '文件' : '其它'}）`;
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    return code === 'ENOENT' ? '不存在' : `不可访问(${code})`;
  }
  try {
    const h = await fsp.opendir(dir);
    try {
      for await (const d of h) {
        return `可读，例如 ${toPosix(d.name)}`;
      }
      return '可读（空目录）';
    } finally {
      await h.close().catch(() => {});
    }
  } catch (err) {
    return `权限不足(${/** @type {NodeJS.ErrnoException} */ (err).code})`;
  }
}

export const listRootsTool = defineTool({
  name: 'list_roots',
  title: '列出可读根目录',
  description:
    '列出本服务允许读取的根目录 / 项目别名，以及每个目录当前是否可读。' +
    '排查前先调它：后续 ls / grep / cat / tail 的 project 参数就用这里返回的 name。',
  inputSchema: z.object({}),
  async run(_args, ctx) {
    const out = new Out({ tool: 'list_roots' }, { maxChars: ctx.config.maxTextChars });
    out.set('roots', ctx.roots.roots.length);
    out.push('');
    for (const r of ctx.roots.describe()) {
      out.push(`project="${r.name}"${r.description ? `  # ${r.description}` : ''}`);
      for (const d of r.dirs) {
        out.push(`  ${d}  →  ${await probe(d)}`);
      }
    }
    out.push('');
    out.push('[hint] 下一步：ls project="<上面的 name>" path="" 看项目根目录；也可以直接 ls path="/绝对/路径"。');
    return out;
  },
});
