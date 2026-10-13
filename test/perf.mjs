// 性能验证：造一个真实体量的大日志，实测 tail / grep / ls 的耗时与内存峰值。
// 跑法：node test/perf.mjs      默认 500MB，可用 PERF_MB=200 调整
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const PORT = Number(process.env.PERF_PORT || 8911);
const TARGET_MB = Number(process.env.PERF_MB || 500);
const TOKEN = 'perf-token';

function request(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${PORT}${urlPath}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let id = 1;
async function rpc(method, params, session) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` };
  if (session) headers['mcp-session-id'] = session;
  const res = await request('POST', '/mcp', { headers, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) });
  const payload = JSON.parse(res.text);
  if (payload.error) throw new Error(payload.error.message);
  return { result: payload.result, headers: res.headers };
}

async function callTool(session, name, args) {
  const { result } = await rpc('tools/call', { name, arguments: args }, session);
  return result.content[0].text;
}

async function makeLog(dir, targetMb) {
  const file = path.join(dir, 'huge-app.log');
  const handle = await fsp.open(file, 'w');
  const start = Date.now();
  let written = 0;
  let i = 0;
  let buf = '';
  const target = targetMb * 1024 * 1024;
  while (written < target) {
    const ts = `2026-10-13 13:${String(i % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
    const level = i % 5000 === 0 ? 'ERROR' : i % 97 === 0 ? 'WARN ' : 'INFO ';
    const line = `${ts} ${level} [user-service] trace=${(i * 2654435761).toString(16).slice(0, 16)} uid=${1000000 + (i % 900000)} step=${i % 37} msg=handled request in ${i % 1999}ms\n`;
    buf += line;
    i += 1;
    if (buf.length > 4 * 1024 * 1024) {
      await handle.write(buf);
      written += Buffer.byteLength(buf);
      buf = '';
    }
  }
  await handle.write(buf);
  await handle.close();
  const st = await fsp.stat(file);
  console.log(`造好日志：${file}  ${(st.size / 1024 / 1024).toFixed(1)}MB  ${i} 行  （耗时 ${((Date.now() - start) / 1000).toFixed(1)}s）`);
  return { file, lines: i, bytes: st.size };
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fsmcp-perf-'));
  const { file, lines, bytes } = await makeLog(root, TARGET_MB);

  const child = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.js')], {
    env: { ...process.env, MCP_PORT: String(PORT), MCP_HOST: '127.0.0.1', MCP_TOKEN: TOKEN, MCP_ROOTS: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  child.stdout.on('data', (d) => (serverOut += d.toString()));
  child.stderr.on('data', (d) => (serverOut += d.toString()));

  const cleanup = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  };

  try {
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await request('GET', '/healthz');
        if (r.status === 200) break;
      } catch {
        /* wait */
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'perf', version: '1' } });
    const session = init.headers['mcp-session-id'];
    void session;

    const t = async (label, fn, expect) => {
      const rss0 = child.exitCode === null ? process.memoryUsage().rss : 0;
      const t0 = Date.now();
      const text = await fn();
      const ms = Date.now() - t0;
      const ok = expect ? expect(text) : true;
      console.log(`${ok ? '✓' : '✗'} ${label.padEnd(46)} ${String(ms).padStart(7)}ms   输出 ${(text.length / 1024).toFixed(1)}KB`);
      if (!ok) console.log(`   ✗ 断言不通过：${text.slice(0, 300)}`);
      void rss0;
      return ms;
    };

    console.log(`\n文件总量 ${(bytes / 1024 / 1024).toFixed(0)}MB / ${lines} 行\n`);

    await t('tail 200 行（应远小于 1s，与文件大小无关）', () => callTool(session, 'tail', { path: file, lines: 200 }), (x) =>
      x.includes(`id=${lines - 1}`) || x.includes('msg=handled request'),
    );
    await t('tail 5000 行', () => callTool(session, 'tail', { path: file, lines: 5000 }));
    await t('tail mode=bytes 64KB', () => callTool(session, 'tail', { path: file, mode: 'bytes', bytes: 65536 }));
    await t('cat 无 limit（应拒绝整读并给预览）', () => callTool(session, 'cat', { path: file }), (x) => x.includes('没有整读'));
    await t('cat limit=500 显式分片', () => callTool(session, 'cat', { path: file, limit: 500 }), (x) => x.includes('1| '));
    await t('stat（不应数行，因为 >64MB）', () => callTool(session, 'stat', { path: file }), (x) => x.includes('lines=未统计'));
    await t('grep 命中稀疏关键字（全文件扫描）', () => callTool(session, 'grep', { path: file, pattern: 'ERROR \\[user-service\\]', limit: 20 }));
    await t('grep 命中极多（应提前停止并提示收窄）', () => callTool(session, 'grep', { path: file, pattern: 'step=7 ', limit: 100 }), (x) =>
      x.includes('已提前停止'),
    );
    await t('grep 无命中（全文件扫描）', () => callTool(session, 'grep', { path: file, pattern: 'ZZZ_NEVER_MATCHES' }), (x) =>
      x.includes('没有命中'),
    );
    await t('ls 一层目录', () => callTool(session, 'ls', { path: root }));
    await t('list_roots', () => callTool(session, 'list_roots', {}));

    // 读一份大文件时，服务端不该把整个文件读进内存
    const rss = child.exitCode === null ? await rssOf(child.pid) : null;
    console.log(`\n服务端进程内存：${rss ? `${(rss / 1024 / 1024).toFixed(0)}MB` : '进程已退出'}`);
    console.log('（判据：应远小于日志体积本身，例如 500MB 日志下 RSS 保持几十 MB 量级）');
    void serverOut;
  } finally {
    await cleanup();
  }
  process.exit(0);
}

function rssOf(pid) {
  return new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (d) => (out += d.toString()));
    ps.on('close', () => resolve(Number.parseInt(out.trim(), 10) || null));
    ps.on('error', () => resolve(null));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
