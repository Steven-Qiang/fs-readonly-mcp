// 路径解析 + 只读白名单校验。
// 两条铁律：
//   1) 任何要读的路径，realpath 之后必须落在某个已配置根目录里（防 symlink 跳出、防 ../ 穿越）；
//   2) 这个模块不提供任何写操作。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ToolError, isInsidePath, isWindows, toPosix } from './util.js';

function norm(p) {
  const abs = path.resolve(toPosix(p));
  return isWindows() ? abs.toLowerCase() : abs;
}

/**
 * 取「真实路径」。Windows 上必须用 native 版：普通 realpath 在短路径名（8.3，如 ADMINI~1）上
 * 可能不展开，而 fsp.realpath 会展开，两边不一致就会把合法路径误判成越界。
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
  constructor(roots) {
    // 注意：配置里的根目录和请求路径都要取真实路径再比，否则符号链接、短路径名都会误判
    this.roots = roots.map((r) => ({
      ...r,
      dirsResolved: r.dirs.map((d) => realpathSyncSafe(path.resolve(d))),
      candidates: r.candidates.map((d) => path.resolve(d)),
    }));
    this.byName = new Map(this.roots.map((r) => [r.name.toLowerCase(), r]));
  }

  get names() {
    return this.roots.map((r) => r.name);
  }

  describe() {
    return this.roots.map((r) => ({
      name: r.name,
      dirs: r.dirsResolved.map(toPosix),
      description: r.description,
      exists: r.dirsResolved.some((c) => fs.existsSync(c)),
    }));
  }

  /**
   * 把 (path, project) 解析成服务器上的绝对路径。
   * - project 给了：该项目的候选项按顺序拼相对路径，取第一个存在的
   * - project 没给：所有根目录按「候选目录多的优先」顺序试，命中即用
   */
  async resolveTarget(project, relPath) {
    const rel = relPath ? toPosix(relPath) : '';
    if (rel.split('/').includes('..')) {
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
      const tried = [];
      for (const dir of root.candidates) {
        const full = path.resolve(dir, rel);
        tried.push(toPosix(full));
        if (await exists(full)) {
          return { path: full, root, tried, dirs: root.dirsResolved };
        }
      }
      const base = root.dirsResolved[0];
      throw new ToolError(`项目 "${project}" 下找不到路径：${rel || '/'}`, {
        code: 'E_NOT_FOUND',
        hint: `已尝试：${tried.join(' , ')}\n[action] 用 ls 看项目根：ls project="${project}" path=""`,
      });
    }

    if (path.isAbsolute(toPosix(rel))) {
      const abs = path.resolve(toPosix(rel));
      if (await exists(abs)) return { path: abs, root: null, tried: [toPosix(abs)], dirs: [] };
      if (this.matchRoot(abs)) return { path: abs, root: null, tried: [toPosix(abs)], dirs: [] };
      throw new ToolError(`路径不存在：${toPosix(abs)}`, { code: 'E_NOT_FOUND' });
    }

    const ordered = [...this.roots].sort((a, b) => b.candidates.length - a.candidates.length);
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

  /** 找到包含该路径的根（取最具体的一个）。absPath 必须是 realpath 之后的结果 */
  matchRoot(absPath) {
    let best = null;
    for (const root of this.roots) {
      for (const dir of root.dirsResolved) {
        if (isInsidePath(dir, dir, absPath)) {
          if (!best || dir.length > best.dir.length) best = { root, dir };
        }
      }
    }
    return best;
  }

  /** 校验（必要时 realpath）并返回安全可读的绝对路径 */
  async checkAllowed(absPath) {
    const abs = path.resolve(absPath);
    let real;
    try {
      real = await fsp.realpath(abs);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // 文件还不存在（例如路径写错了）：用父目录的 realpath 判断归属，好给出准确报错
        const parent = path.dirname(abs);
        let realParent = parent;
        try {
          realParent = await fsp.realpath(parent);
        } catch {
          /* ignore */
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

async function exists(p) {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

export { exists };
