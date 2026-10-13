// 配置来源：进程环境变量 > <项目根>/.env > <项目根>/mcp.config.json > 内置默认值。
// 这个文件不 import 任何本地模块，避免循环依赖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 7801;
const DEFAULT_MAX_TEXT_CHARS = 64000;
const DEFAULT_CALL_TIMEOUT_MS = 60000;

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function loadJsonFile() {
  const p = path.join(PROJECT_ROOT, 'mcp.config.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new Error(`mcp.config.json 解析失败: ${err.message}`);
  }
}

function firstOf(env, envFile, json, keys) {
  for (const k of keys) {
    if (env[k] !== undefined && env[k] !== '') return env[k];
  }
  for (const k of keys) {
    if (envFile[k] !== undefined && envFile[k] !== '') return envFile[k];
  }
  for (const k of keys) {
    if (json[k] !== undefined && json[k] !== null) return json[k];
  }
  return undefined;
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
 * roots 三种写法都支持：
 *   "D:/logs"                                      → 名字取末段目录名
 *   { "path": "D:/logs", "name": "logs" }          → 指定名字
 *   { "name": "cjjlapi", "logs": "D:/www/cjjlapi/logs", "candidates": [...] }
 *     → 项目别名：AI 可以直接 ls path="today.log" project="cjjlapi"
 */
function normalizeRoot(raw, index) {
  const fallbackName = `root${index + 1}`;
  let name;
  let candidates = [];
  let extraDirs = [];
  let description = '';

  if (typeof raw === 'string') {
    candidates = [raw];
  } else if (raw && typeof raw === 'object') {
    name = raw.name ? String(raw.name) : undefined;
    description = raw.description ? String(raw.description) : '';
    if (raw.candidates) {
      if (!Array.isArray(raw.candidates)) throw new Error(`roots[${index}].candidates 必须是数组`);
      candidates = raw.candidates;
    }
    if (raw.path) candidates = [raw.path, ...candidates];
    if (raw.logs) extraDirs = [raw.logs, ...extraDirs];
  } else {
    throw new Error(`roots[${index}] 写法不对，只能是字符串或对象`);
  }

  candidates = candidates.filter(Boolean).map((p) => path.resolve(asPosix(p)));
  extraDirs = extraDirs.filter(Boolean).map((p) => path.resolve(asPosix(p)));
  if (candidates.length === 0) throw new Error(`roots[${index}] 没有任何可用路径`);

  const dirs = [...new Set([...candidates, ...extraDirs])];
  const primary = extraDirs[0] || candidates[0];
  return {
    name: name || path.basename(candidates[0]) || fallbackName,
    candidates,
    dirs,
    primary,
    description,
  };
}

function normalizeRoots(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('必须配置至少一个可见根目录（环境变量 MCP_ROOTS，或 mcp.config.json 的 roots）');
  }
  const roots = raw.map(normalizeRoot);
  const seen = new Set();
  for (const r of roots) {
    if (seen.has(r.name)) throw new Error(`roots 里项目名重复：${r.name}`);
    seen.add(r.name);
  }
  return roots;
}

export function loadConfig() {
  const env = process.env;
  const envFile = loadEnvFile();
  const json = loadJsonFile();

  const jsonRoots = json.roots;
  const envRoots = firstOf(env, envFile, {}, ['MCP_ROOTS']);
  let rootsRaw = jsonRoots;
  if (envRoots) {
    rootsRaw = String(envRoots)
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!rootsRaw && json.roots === undefined) {
    throw new Error(
      '没有配置可见根目录。请设置环境变量 MCP_ROOTS=/data/logs,/www/wwwroot，' +
        `或在 ${path.join(PROJECT_ROOT, 'mcp.config.json')} 里写 roots 数组`,
    );
  }

  const ignoreDirsRaw = json.ignoreDirs ?? ['node_modules', '.git', '.svn', '.hg', 'vendor', '.cache'];
  const ignoreDirs = new Set(ignoreDirsRaw.map((s) => String(s).toLowerCase()));

  const config = {
    projectRoot: PROJECT_ROOT,
    host: String(firstOf(env, envFile, json, ['MCP_HOST', 'host']) ?? '0.0.0.0'),
    port: asInt(firstOf(env, envFile, json, ['MCP_PORT', 'port']), DEFAULT_PORT, { min: 1, max: 65535 }),
    token: String(firstOf(env, envFile, json, ['MCP_TOKEN', 'token']) ?? ''),
    roots: normalizeRoots(rootsRaw),
    maxTextChars: asInt(
      firstOf(env, envFile, json, ['MCP_MAX_TEXT_CHARS', 'maxTextChars']),
      DEFAULT_MAX_TEXT_CHARS,
      { min: 2000, max: 4_000_000 },
    ),
    callTimeoutMs: asInt(
      firstOf(env, envFile, json, ['MCP_CALL_TIMEOUT_MS', 'callTimeoutMs']),
      DEFAULT_CALL_TIMEOUT_MS,
      { min: 1000, max: 600_000 },
    ),
    sessionTtlMs: asInt(firstOf(env, envFile, json, ['MCP_SESSION_TTL_MS', 'sessionTtlMs']), 1_800_000, {
      min: 30_000,
      max: 86_400_000,
    }),
    auditLog: String(firstOf(env, envFile, json, ['MCP_AUDIT_LOG', 'auditLog']) ?? ''),
    ignoreDirs,
    // 这些名称在通配符里视为「日志文件」
    logFilePatterns: ['*.log', '*.log.*', '*access*', '*error*', '*.out', '*.err', '*.trace', '*.ndjson'],
  };

  return config;
}
