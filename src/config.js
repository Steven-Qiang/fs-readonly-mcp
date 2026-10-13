// 配置来源：进程环境变量 > <项目根>/.env > 内置默认值。
// 这个文件不 import 任何本地模块，避免循环依赖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 7801;
const DEFAULT_ROOTS = '/'; // 不配 MCP_ROOTS = 整个文件系统可读
const DEFAULT_MAX_TEXT_CHARS = 64000;
const DEFAULT_CALL_TIMEOUT_MS = 60000;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows 下 '/' 解析出来是「当前盘符根」，这里显式取一次，避免受 cwd 影响
const DRIVE_ROOT = path.parse(PROJECT_ROOT).root;

function parseDotEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function loadEnvFile() {
  const p = path.join(PROJECT_ROOT, '.env');
  try {
    return parseDotEnv(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function asInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function asPosix(value) {
  return String(value).replace(/\\/g, '/');
}

/**
 * MCP_ROOTS：逗号或分号分隔的可见根目录。
 * 不配 = 整个文件系统可读（默认值 '/'）。
 * 每项写法：
 *   "/srv/app-a/logs"                → 项目名取末段目录名（logs）
 *   "app-a=/srv/app-a"               → 指定项目名，AI 就能 ls project="app-a"
 */
function normalizeRoots(raw) {
  const items = String(raw)
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error('MCP_ROOTS 是空的：要么整行删掉（=整个文件系统可读），要么写至少一个绝对路径，如 /srv/app-a/logs');
  }

  const roots = items.map((item, index) => {
    const eq = item.indexOf('=');
    const explicitName = eq > 0 ? item.slice(0, eq).trim() : '';
    const rawPath = asPosix(eq > 0 ? item.slice(eq + 1).trim() : item);
    // '/' 显式解析：Windows 上 path.resolve('/') 会跟随当前盘符
    const isFsRoot = /^\/+$/.test(rawPath);
    const dir = isFsRoot ? DRIVE_ROOT : path.resolve(rawPath);
    const name = explicitName || (isFsRoot ? 'all' : path.basename(dir)) || `root${index + 1}`;
    return {
      name,
      candidates: [dir],
      dirs: [dir],
      description: isFsRoot ? '整个文件系统' : '',
      allRoots: isFsRoot, // 标记成「全盘」：Windows 上其它盘符的绝对路径也直接放行
    };
  });

  const seen = new Set();
  for (const r of roots) {
    if (seen.has(r.name)) throw new Error(`MCP_ROOTS 里项目名重复：${r.name}（用 别名=/绝对路径 区分）`);
    seen.add(r.name);
  }
  return roots;
}

export function loadConfig() {
  const env = process.env;
  const envFile = loadEnvFile();
  const pick = (keys) => {
    for (const k of keys) {
      if (env[k] !== undefined && env[k] !== '') return env[k];
    }
    for (const k of keys) {
      if (envFile[k] !== undefined && envFile[k] !== '') return envFile[k];
    }
    return undefined;
  };

  const ignoreDirsRaw = pick(['MCP_IGNORE_DIRS']) ?? 'node_modules,.git,.svn,.hg,vendor,.cache';

  return {
    projectRoot: PROJECT_ROOT,
    host: String(pick(['MCP_HOST']) ?? '0.0.0.0'),
    port: asInt(pick(['MCP_PORT']), DEFAULT_PORT, { min: 1, max: 65535 }),
    token: String(pick(['MCP_TOKEN']) ?? ''),
    roots: normalizeRoots(pick(['MCP_ROOTS']) ?? DEFAULT_ROOTS),
    maxTextChars: asInt(pick(['MCP_MAX_TEXT_CHARS']), DEFAULT_MAX_TEXT_CHARS, { min: 2000, max: 4_000_000 }),
    callTimeoutMs: asInt(pick(['MCP_CALL_TIMEOUT_MS']), DEFAULT_CALL_TIMEOUT_MS, { min: 1000, max: 600_000 }),
    auditLog: String(pick(['MCP_AUDIT_LOG']) ?? ''),
    ignoreDirs: new Set(
      String(ignoreDirsRaw)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}
