// 目录遍历：非递归用 opendir（流式、不 sort 全量），递归用有界 BFS + 并发上限。
// 所有遍历都尊重 ignoreDirs，并且随时可中断。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { toPosix } from './util.js';

export async function statType(full, dirent) {
  if (dirent) {
    if (dirent.isSymbolicLink()) {
      try {
        const st = await fsp.stat(full);
        return st.isDirectory() ? 'dir' : 'file';
      } catch {
        return 'broken';
      }
    }
    if (dirent.isDirectory()) return 'dir';
    if (dirent.isFile()) return 'file';
    return 'other';
  }
  try {
    const st = await fsp.stat(full);
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'other';
  } catch {
    return 'missing';
  }
}

export function isIgnoredName(name, ignoreDirs) {
  return ignoreDirs.has(String(name).toLowerCase());
}

/**
 * 列一层目录。返回 { entries, moreByType, scanned }，条目数封顶，避免一个十万文件的目录直接糊满上下文。
 */
export async function listDir(dir, { limit = 500, ignoreDirs, signal, withStat = true } = {}) {
  const entries = [];
  const moreByType = { dir: 0, file: 0, other: 0 };
  let scanned = 0;
  const dirHandle = await fsp.opendir(dir);
  try {
    for await (const dirent of dirHandle) {
      if (signal?.aborted) break;
      scanned += 1;
      if (isIgnoredName(dirent.name, ignoreDirs)) continue;
      if (entries.length >= limit) {
        const t = dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : 'other';
        moreByType[t] += 1;
        continue;
      }
      const full = path.join(dir, dirent.name);
      const type = dirent.isSymbolicLink() ? await statType(full, dirent) : dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : 'other';
      let size = null;
      let mtime = null;
      if (withStat && type !== 'dir') {
        try {
          const st = await fsp.stat(full);
          size = st.size;
          mtime = st.mtime;
        } catch {
          /* 读不到就算了 */
        }
      }
      entries.push({ name: dirent.name, type, size, mtime, full });
    }
  } finally {
    await dirHandle.close().catch(() => {});
  }
  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (b.type === 'dir' && a.type !== 'dir') return 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  const hidden = entries.filter((e) => e.name.startsWith('.')).length;
  return { entries, moreByType, scanned, hidden };
}

/**
 * 有界 BFS 走目录，收集文件路径。
 * 限制：最大深度、最大文件数、最大访问目录数、最大耗时；到点即停并给出 stopReason。
 */
export async function walkFiles(rootDir, opts = {}) {
  const {
    maxDepth = 4,
    maxFiles = 2000,
    maxDirs = 400,
    signal,
    deadline,
    ignoreDirs,
    includeHidden = true,
  } = opts;

  const files = [];
  const dirsVisited = [];
  const queue = [{ dir: rootDir, depth: 0 }];
  let stopReason = null;
  let dirCount = 0;

  while (queue.length > 0) {
    if (signal?.aborted) {
      stopReason = '客户端已断开';
      break;
    }
    if (deadline && deadline.expired()) {
      stopReason = '时间预算用尽';
      break;
    }
    if (files.length >= maxFiles) {
      stopReason = `达到文件数上限 maxFiles=${maxFiles}`;
      break;
    }
    if (dirCount >= maxDirs) {
      stopReason = `达到目录数上限 maxDirs=${maxDirs}`;
      break;
    }
    const { dir, depth } = queue.shift();
    dirCount += 1;
    dirsVisited.push(dir);

    let dirHandle;
    try {
      dirHandle = await fsp.opendir(dir);
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'ENOENT') continue;
      throw err;
    }
    const subdirs = [];
    try {
      for await (const dirent of dirHandle) {
        if (files.length >= maxFiles) {
          stopReason = `达到文件数上限 maxFiles=${maxFiles}`;
          break;
        }
        const name = dirent.name;
        if (!includeHidden && name.startsWith('.')) continue;
        if (ignoreDirs.has(name.toLowerCase())) continue;
        const full = path.join(dir, name);
        if (dirent.isDirectory()) {
          if (depth + 1 <= maxDepth) subdirs.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (dirent.isSymbolicLink()) {
          const t = await statType(full, dirent);
          if (t === 'file') files.push(full);
          else if (t === 'dir' && depth + 1 <= maxDepth) subdirs.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (dirent.isFile()) files.push(full);
      }
    } finally {
      await dirHandle.close().catch(() => {});
    }
    if (stopReason && stopReason.startsWith('达到文件数')) break;
    for (const s of subdirs) queue.push(s);
  }

  return { files, dirsVisited, stopReason, truncated: stopReason !== null && !stopReason.includes('断开') };
}

/** 并发映射，保持结果顺序；一项失败不影响其它项 */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        out[i] = { __error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export function relPath(from, full) {
  const rel = path.relative(from, full);
  return rel ? toPosix(rel) : '.';
}
