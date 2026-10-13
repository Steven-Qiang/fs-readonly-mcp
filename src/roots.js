// 路径解析 + 只读白名单校验。
// 两条铁律：
//   1) 任何要读的路径，realpath 之后必须落在某个已配置根目录里（防 symlink 跳出、防 ../ 穿越）；
//   2) 这个模块不提供任何写操作。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ToolError, isInsidePath, isWindows, toPosix } from './util.js';

/**
 * @typedef {import('./config.js').RootEntry} RootEntry
 * @typedef {RootEntry & { dirsResolved: string[] }} ResolvedRoot
 * @typedef {{ path: string, root: ResolvedRoot | null, tried: string[], dirs: string[] }} Target
 * @typedef {{ abs: string, real: string, root: ResolvedRoot, dir: string, exists: boolean }} Allowed
 * @typedef {{ root: ResolvedRoot, dir: string }} RootHit
 */

/**
 * 取「真实路径」。Windows 上必须用 native 版：普通 realpath 在短路径名（8.3，如 ADMINI~1）上
 * 可能不展开，而 fsp.realpath 会展开，两边不一致就会把合法路径误判成越界。
 * @param {string} p
 * @returns {string}
 */
function realpathSyncSafe(p) {
  for (const fn of [
    () => fs.realpathSync.native(p),
    () => fs.realpathSync(p),
  ]) {
    try {
      return fn();
    } catch {
      /* 试下一种 */
    }
  }
  return p;
}

export class Roots {
  /** @param {RootEntry[]} roots */
  constructor(roots) {
    // 注意：配置里的根目录和请求路径都要取真实路径再比，否则符号链接、短路径名都会误判
    /** @type {ResolvedRoot[]} */
    this.roots = roots.map((r) => ({
      ...r,
      dirsResolved: r.dirs.map((d) => realpathSyncSafe(path.resolve(d))),
      candidates: r.candidates.map((d) => path.resolve(d)),
    }));
    /** @type {Map<string, ResolvedRoot>} */
    this.byName = new Map(this.roots.map((r) => [r.name.toLowerCase(), r]));
  }

  /** @returns {string[]} 全部项目别名 */
  get names() {
    return this.roots.map((r) => r.name);
  }

  /** @returns {{ name: string, dirs: string[], description: string, exists: boolean }[]} 给 list_roots / healthz 用的清单 */
  describe() {
    return this.roots.map((r) => ({
      name: r.name,
      dirs: r.dirsResolved.map(toPosix),
      description: r.description,
      // 「全盘」根不需要探测存在性
      exists: r.allRoots ? true : r.dirsResolved.some((c) => fs.existsSync(c)),
    }));
  }

  /**
   * 把 (path, project) 解析成服务器上的绝对路径。
   * - project 给了：该项目的候选项按顺序拼相对路径，取第一个存在的
   * - project 没给：所有根目录按「候选目录多的优先」顺序试，命中即用
   * @param {string | undefined} project
   * @param {string | undefined} relPath
   * @returns {Promise<Target>}
   */
  async resolveTarget(project, relPath) {
    const rel = relPath ? toPosix(relPath) : '';
    // 必须同时认 '\' 和 '/'：Windows 上 "..\..\x" 会被 path.resolve 当真分隔符解析并逃出根目录，
    // 而 toPosix 只换 '/'，所以这里要在归一化后的结果上按两种分隔符切段检查。
    const segments = rel.split(/[/\\]+/);
    if (segments.includes('..')) {
      throw new ToolError(`路径里不允许出现 ".."：${relPath}`, { code: 'E_TRAVERSAL' });
    }

    if (project) {
      const root = this.byName.get(String(project).toLowerCase());
      if (!root) {
        throw new ToolError(`没有配置项目别名 "${project}"`, {
          code: 'E_NO_PROJECT',
          hint: `可用项目名：${this.names.join('、')}`,
        });
      }
      /** @type {string[]} */
      const tried = [];
      for (const dir of root.candidates) {
        const full = path.resolve(dir, rel);
        tried.push(toPosix(full));
        if (await exists(full)) {
          return { path: full, root, tried, dirs: root.dirsResolved };
        }
      }
      throw new ToolError(`项目 "${project}" 下找不到路径：${rel || '/'}`, {
        code: 'E_NOT_FOUND',
        hint: `已尝试：${tried.join(' , ')}\n[action] 用 ls 看项目根：ls project="${project}" path=""`,
      });
    }

    if (path.isAbsolute(toPosix(rel)) || /^[A-Za-z]:[\\/]/.test(rel)) {
      const abs = path.resolve(toPosix(rel));
      if (await exists(abs)) return { path: abs, root: null, tried: [toPosix(abs)], dirs: [] };
      // 不存在也放行两种情况，好让 checkAllowed 给出准确报错：
      //   · 路径落在某个根目录内（例如根目录里的文件写错了名）
      //   · 有「全盘」根（MCP_ROOTS 没配或写了 /）—— 整机可读，任意盘符都算数
      if (this.matchRoot(abs) || this.roots.some((r) => r.allRoots)) {
        return { path: abs, root: null, tried: [toPosix(abs)], dirs: [] };
      }
      throw new ToolError(`路径不存在：${toPosix(abs)}`, { code: 'E_NOT_FOUND' });
    }

    const ordered = [...this.roots].sort((a, b) => b.candidates.length - a.candidates.length);
    /** @type {string[]} */
    const tried = [];
    for (const root of ordered) {
      for (const dir of root.candidates) {
        const full = path.resolve(dir, rel);
        if (await exists(full)) return { path: full, root, tried: [...tried, toPosix(full)], dirs: root.dirsResolved };
        tried.push(toPosix(full));
      }
    }
    if (rel === '') {
      throw new ToolError('没给 path，需要至少一个根目录存在才能列默认目录', { code: 'E_NO_BASE' });
    }
    throw new ToolError(`在所有配置根目录下都找不到：${rel}`, {
      code: 'E_NOT_FOUND',
      hint: `已尝试：${tried.slice(0, 12).join(' , ')}\n[action] 先 ls_roots 看有哪些根目录/项目别名`,
    });
  }

  /**
   * 找到包含该路径的根（取最具体的一个）。absPath 必须是 realpath 之后的结果。
   * 配了「全盘」根（MCP_ROOTS 没配 / 写了 /）时，它管辖的是同一个「根」之内的一切：
   *   · POSIX：根就是 /，等于整机
   *   · Windows：根是具体盘符（如 D:\），只放行该盘；别的盘仍算越界
   * @param {string} absPath
   * @returns {RootHit | null}
   */
  matchRoot(absPath) {
    /** @type {RootHit | null} */
    let best = null;
    for (const root of this.roots) {
      for (const dir of root.dirsResolved) {
        if (isInsidePath(dir, dir, absPath)) {
          if (!best || dir.length > best.dir.length) best = { root, dir };
        }
      }
    }
    if (best) return best;

    const all = this.roots.find((r) => r.allRoots);
    if (!all) return null;
    const parsed = path.parse(path.resolve(absPath));
    const scope = all.dirsResolved[0];
    // 盘符必须一致，否则「只放开这个盘」会被放大成「整机」
    const sameScope = isWindows() ? parsed.root.toLowerCase() === path.parse(scope).root.toLowerCase() : true;
    return sameScope ? { root: all, dir: parsed.root } : null;
  }

  /**
   * 校验（必要时 realpath）并返回安全可读的绝对路径。
   * @param {string} absPath
   * @returns {Promise<Allowed>}
   */
  async checkAllowed(absPath) {
    const abs = path.resolve(absPath);
    /** @type {string} */
    let real;
    try {
      real = await fsp.realpath(abs);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code === 'ENOENT') {
        // 文件还不存在（例如路径写错了）：用父目录的 realpath 判断归属，好给出准确报错。
        // 父目录的 realpath 取不到时必须 fail closed：否则会拿未解析的路径去判归属，
        // 白名单之外的位置（EACCES / ELOOP / 中间目录缺失）会被误判成「在根目录内」。
        const parent = path.dirname(abs);
        /** @type {string | null} */
        let realParent;
        try {
          realParent = await fsp.realpath(parent);
        } catch {
          realParent = null;
        }
        if (!realParent) {
          throw new ToolError(`无法确认路径归属（父目录不可访问）：${toPosix(abs)}`, {
            code: 'E_OUTSIDE',
            hint: `父目录 ${toPosix(parent)} 的 realpath 取不到（权限不足或中间目录不存在），按越界处理`,
          });
        }
        const probe = this.matchRoot(realParent);
        if (!probe) {
          throw new ToolError(`路径不在允许的根目录内：${toPosix(abs)}`, {
            code: 'E_OUTSIDE',
            hint: `允许的根目录：${this.roots.map((r) => toPosix(r.dirsResolved[0])).join(' , ')}`,
          });
        }
        return { abs, real: path.join(realParent, path.basename(abs)), root: probe.root, dir: probe.dir, exists: false };
      }
      throw err;
    }

    const hit = this.matchRoot(real);
    if (!hit) {
      throw new ToolError(`路径不在允许的根目录内：${toPosix(abs)}`, {
        code: 'E_OUTSIDE',
        hint: `允许的根目录：${this.roots.map((r) => toPosix(r.dirsResolved[0])).join(' , ')}`,
      });
    }
    return { abs, real, root: hit.root, dir: hit.dir, exists: true };
  }
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function exists(p) {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

export { exists };
