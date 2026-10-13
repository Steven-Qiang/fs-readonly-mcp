// 端到端自测：造一批真实日志文件 → 起真实服务 → 走完整 MCP Streamable HTTP 流程 → 逐个工具断言。
// 跑法：node test/test.js      退出码 0 = 全通过
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const PORT = Number(process.env.TEST_PORT || 8000 + Math.floor(Math.random() * 900));
const TOKEN = 'test-token-please-change';
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`);
  }
}

// ---------- 测试用目录与文件 ----------
async function makeFixtures(root) {
  const projA = path.join(root, 'projA');
  const projB = path.join(root, 'projB');
  const logsA = path.join(projA, 'logs');
  await fsp.mkdir(logsA, { recursive: true });
  await fsp.mkdir(path.join(projB, 'sub'), { recursive: true });

  await fsp.writeFile(
    path.join(logsA, 'app.log'),
    [
      '2026-01-01 10:00:00 INFO  boot ok',
      '2026-01-01 10:00:01 INFO  loaded config',
      '2026-01-01 10:00:02 ERROR connect redis failed: timeout',
      '2026-01-01 10:00:03 INFO  retrying',
      '2026-01-01 10:00:04 ERROR connect redis failed: timeout',
      '2026-01-01 10:00:05 recovered',
    ].join('\n') + '\n',
    'utf8',
  );
  await fsp.writeFile(path.join(logsA, 'error.log'), 'ERROR boom\n', 'utf8');
  await fsp.writeFile(path.join(logsA, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x00, 0x10]), 'binary');
  await fsp.writeFile(path.join(projA, '.env'), 'DB_PASSWORD=super-secret\n', 'utf8');
  await fsp.writeFile(path.join(projB, 'sub', 'today.out'), 'worker started\nworker done\n', 'utf8');
  await fsp.writeFile(path.join(projB, 'notes.txt'), 'hello world\n', 'utf8');
  await fsp.mkdir(path.join(projA, 'node_modules', 'left-pad'), { recursive: true });
  await fsp.writeFile(path.join(projA, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n', 'utf8');

  // 大文件：约 2.7MB / 5 万行，用来验证「大文件不整读 + 能定位到尾部」
  const big = path.join(logsA, 'big.log');
  const handle = await fsp.open(big, 'w');
  const line = (i) => `2026-01-01 12:00:${String(i % 60).padStart(2, '0')} INFO  request id=${i} latency=${i % 997}ms\n`;
  let buf = '';
  for (let i = 0; i < 50_000; i += 1) {
    buf += line(i);
    if (buf.length > 512 * 1024) {
      await handle.write(buf);
      buf = '';
    }
  }
  await handle.write(buf);
  await handle.close();
  return { projA, projB, logsA, big };
}

// ---------- HTTP 小客户端 ----------
function request(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${urlPath}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let nextId = 1;
async function rpc(method, params, sessionId, { accept = 'application/json, text/event-stream', token = TOKEN } = {}) {
  const id = nextId++;
  const headers = {
    'content-type': 'application/json',
    accept,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await request('POST', '/mcp', { headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  let payload = null;
  if (res.headers['content-type']?.includes('text/event-stream')) {
    const m = /^data: (.*)$/m.exec(res.text);
    payload = m ? JSON.parse(m[1]) : null;
  } else {
    try {
      payload = res.text ? JSON.parse(res.text) : null;
    } catch {
      payload = null;
    }
  }
  if (payload?.error) throw new Error(`JSON-RPC ${payload.error.code}: ${payload.error.message}`);
  return { status: res.status, headers: res.headers, payload, result: payload?.result, raw: res.text };
}

async function callTool(session, name, args) {
  const { result } = await rpc('tools/call', { name, arguments: args }, session);
  assert.ok(result, `tools/call ${name} 没有返回 result`);
  const text = result.content?.[0]?.text ?? '';
  return { text, isError: !!result.isError };
}

// ---------- 主流程 ----------
async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fsmcp-test-'));
  const auditFile = path.join(root, 'audit.ndjson');
  const fixtures = await makeFixtures(root);
  console.log(`临时目录: ${root}`);
  console.log(`服务端口: ${PORT}\n`);

  const child = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.js')], {
    env: {
      ...process.env,
      MCP_PORT: String(PORT),
      MCP_HOST: '127.0.0.1',
      MCP_TOKEN: TOKEN,
      MCP_ROOTS: `${fixtures.projA},${fixtures.projB}`,
      MCP_AUDIT_LOG: auditFile,
      MCP_CALL_TIMEOUT_MS: '20000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => {
    serverLog += d.toString();
  });
  child.stderr.on('data', (d) => {
    serverLog += d.toString();
  });

  const cleanup = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill('SIGKILL');
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  };

  try {
    // 等端口起来
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await request('GET', '/healthz');
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!ready) throw new Error(`服务没起来。日志：\n${serverLog}`);

    console.log('— 传输层 —');
    await check('GET /healthz 返回只读信息与工具清单', async () => {
      const res = await request('GET', '/healthz');
      assert.equal(res.status, 200);
      const info = JSON.parse(res.text);
      assert.equal(info.ok, true);
      assert.equal(info.writeable, false);
      assert.deepEqual(info.tools, ['list_roots', 'ls', 'glob_files', 'stat', 'cat', 'tail', 'grep']);
      assert.equal(info.roots.length, 2);
    });

    await check('没有 token 一律 401', async () => {
      const res = await request('POST', '/mcp', {
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      assert.equal(res.status, 401);
    });

    await check('token 不对也是 401', async () => {
      const res = await rpc('initialize', { protocolVersion: '2025-06-18' }, null, { token: 'wrong' }).catch((e) => e);
      // rpc 抛错说明服务端返回了 error，这里直接单独发一次请求确认状态码
      const raw = await request('POST', '/mcp', {
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer wrong',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
      });
      assert.equal(raw.status, 401);
      void res;
    });

    await check('坏 JSON → 400 + -32700', async () => {
      const res = await request('POST', '/mcp', {
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
        body: '{not json',
      });
      assert.equal(res.status, 400);
      assert.equal(JSON.parse(res.text).error.code, -32700);
    });

    let session = null;
    let auditSession = null;
    await check('initialize 协商协议并返回 Mcp-Session-Id', async () => {
      const res = await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.result.protocolVersion, '2025-06-18');
      assert.ok(res.result.capabilities.tools);
      assert.ok(res.result.instructions.includes('只读'));
      session = res.headers['mcp-session-id'];
      assert.ok(session, '响应头缺少 mcp-session-id');
      auditSession = session;
    });

    await check('旧协议版本被降级到服务端支持的最新版', async () => {
      const res = await rpc('initialize', { protocolVersion: '1999-01-01' });
      assert.equal(res.result.protocolVersion, '2025-06-18');
    });

    await check('未 initialize 就调 tools/list → 400', async () => {
      const res = await request('POST', '/mcp', {
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
      });
      assert.equal(res.status, 400);
      assert.match(res.text, /initialize/);
    });

    await check('伪造 session id → 404', async () => {
      const res = await request('POST', '/mcp', {
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'mcp-session-id': 'deadbeefdeadbeef',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list', params: {} }),
      });
      assert.equal(res.status, 404);
    });

    await check('tools/list 返回 7 个只读工具且 schema 完整', async () => {
      const res = await rpc('tools/list', {}, session);
      const tools = res.result.tools;
      assert.equal(tools.length, 7);
      for (const t of tools) {
        assert.equal(t.annotations.readOnlyHint, true, `${t.name} 没声明 readOnlyHint`);
        assert.ok(t.description.length > 20, `${t.name} 描述太短`);
        assert.equal(t.inputSchema.type, 'object');
      }
      assert.ok(tools.some((t) => t.name === 'grep'));
      assert.ok(tools.some((t) => t.name === 'tail'));
    });

    await check('通知（无 id）返回 202', async () => {
      const res = await request('POST', '/mcp', {
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'mcp-session-id': session,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.equal(res.status, 202);
    });

    console.log('\n— 工具：ls / list_roots —');
    await check('list_roots 列出两个根目录且标记可读', async () => {
      const { text, isError } = await callTool(session, 'list_roots', {});
      assert.equal(isError, false);
      assert.match(text, /project="projA"/);
      assert.match(text, /project="projB"/);
      assert.match(text, /可读/);
    });

    await check('ls 一层目录：目录带 /，文件带大小，忽略 node_modules', async () => {
      const { text } = await callTool(session, 'ls', { path: 'logs', project: 'projA' });
      assert.match(text, /app\.log/);
      assert.match(text, /binary\.bin/);
      assert.match(text, /\[meta\]/);
      assert.ok(!text.includes('node_modules'), 'node_modules 不该出现');
    });

    await check('ls 递归 + pattern 能找到下层的 .out', async () => {
      const { text } = await callTool(session, 'ls', { path: '', project: 'projB', depth: 3, pattern: '*.out' });
      assert.match(text, /sub\/today\.out/);
    });

    await check('ls 不存在的路径 → isError + 明确提示', async () => {
      const { text, isError } = await callTool(session, 'ls', { path: 'nope/nowhere', project: 'projA' });
      assert.equal(isError, true);
      assert.match(text, /E_NOT_FOUND|找不到/);
    });

    console.log('\n— 工具：cat —');
    await check('cat 小文件带行号', async () => {
      const { text } = await callTool(session, 'cat', { path: 'logs/app.log', project: 'projA' });
      assert.match(text, /1\| 2026-01-01 10:00:00 INFO/);
      assert.match(text, /3\| .*ERROR connect redis failed/);
    });

    await check('cat 大文件不整读，返回尾部预览 + 三种读法提示', async () => {
      const { text } = await callTool(session, 'cat', { path: 'logs/big.log', project: 'projA' });
      assert.match(text, /没有整读/);
      assert.match(text, /尾部预览/);
      assert.match(text, /tail path=/);
      assert.match(text, /grep path=/);
      assert.ok(text.length < 8000, `预览不该这么长：${text.length}`);
      assert.match(text, /nextOffset|offset=/);
    });

    await check('cat 大文件仍可显式分片读（offset+limit 不受阈值影响）', async () => {
      const { text } = await callTool(session, 'cat', { path: 'logs/big.log', project: 'projA', offset: 0, limit: 3 });
      assert.match(text, /1\| /);
      assert.match(text, /3\| /);
    });

    await check('cat 分片续读：offset 接着上一片', async () => {
      const first = await callTool(session, 'cat', { path: 'logs/big.log', project: 'projA', offset: 0, limit: 5 });
      assert.match(first.text, /1\| /);
      const m = /offset=(\d+)/.exec(first.text);
      assert.ok(m, `第一片没给出 nextOffset：${first.text.slice(0, 300)}`);
      const second = await callTool(session, 'cat', { path: 'logs/big.log', project: 'projA', offset: Number(m[1]), limit: 5 });
      assert.match(second.text, /6\| /, `续读行号不对：${second.text.slice(0, 200)}`);
    });

    await check('cat 拒绝二进制文件', async () => {
      const { text, isError } = await callTool(session, 'cat', { path: 'logs/binary.bin', project: 'projA' });
      assert.equal(isError, true);
      assert.match(text, /二进制/);
    });

    await check('cat 能读 .env（跳板机内网环境不做凭据拦截）', async () => {
      const { text, isError } = await callTool(session, 'cat', { path: '.env', project: 'projA' });
      assert.equal(isError, false);
      assert.match(text, /1\| DB_PASSWORD=super-secret/);
    });

    console.log('\n— 工具：tail —');
    await check('tail 大日志只读尾部，快且带收尾提示', async () => {
      const t0 = Date.now();
      const { text } = await callTool(session, 'tail', { path: 'logs/big.log', project: 'projA', lines: 5 });
      const ms = Date.now() - t0;
      assert.match(text, /id=49999/);
      assert.ok(ms < 3000, `tail 太慢：${ms}ms`);
      assert.match(text, /\[hint\]/);
    });

    await check('tail 支持多文件对比', async () => {
      const { text } = await callTool(session, 'tail', { path: 'logs/app.log,logs/error.log', project: 'projA', lines: 2 });
      assert.match(text, /app\.log/);
      assert.match(text, /error\.log/);
      assert.match(text, /ERROR boom/);
    });

    await check('tail mode=bytes 返回原始字节', async () => {
      const { text } = await callTool(session, 'tail', { path: 'logs/app.log', project: 'projA', mode: 'bytes', bytes: 30 });
      assert.match(text, /末 30 字节/);
      assert.match(text, /recovered/);
    });
    console.log('\n— 工具：grep / glob / stat —');
    await check('grep 目录递归命中并带 file:line', async () => {
      const { text } = await callTool(session, 'grep', { pattern: 'ERROR', path: '', project: 'projA' });
      assert.match(text, /logs\/app\.log/);
      assert.match(text, /3: .*connect redis failed/);
      assert.match(text, /5: .*connect redis failed/);
    });

    await check('grep beforeContext 带上下文行（用 - 标记）', async () => {
      const { text } = await callTool(session, 'grep', {
        pattern: 'ERROR connect',
        path: 'logs/app.log',
        project: 'projA',
        beforeContext: 1,
      });
      assert.match(text, /2- .*loaded config/);
      assert.match(text, /3: .*connect redis failed/);
    });

    await check('grep literal 把正则元字符当纯文本', async () => {
      const { text } = await callTool(session, 'grep', { pattern: 'INFO  boot', path: 'logs/app.log', project: 'projA', literal: true });
      assert.match(text, /boot ok/);
    });

    await check('grep 非法正则 → isError 且提示 literal', async () => {
      const { text, isError } = await callTool(session, 'grep', { pattern: '([', path: '', project: 'projA' });
      assert.equal(isError, true);
      assert.match(text, /literal/);
    });

    await check('grep 大文件能命中尾部内容（流式扫描）', async () => {
      const { text } = await callTool(session, 'grep', { pattern: 'id=49999', path: 'logs/big.log', project: 'projA' });
      assert.match(text, /49999/);
      assert.match(text, /命中 1 行/);
    });

    await check('grep 无命中时给出收窄建议', async () => {
      const { text } = await callTool(session, 'grep', { pattern: 'ZZZ_NOT_THERE', path: '', project: 'projA' });
      assert.match(text, /没有命中/);
      assert.match(text, /\[hint\]/);
    });

    await check('glob_files 按通配找文件并推荐最新那个', async () => {
      const { text } = await callTool(session, 'glob_files', { pattern: '*.log', path: '', project: 'projA' });
      assert.match(text, /logs\/app\.log/);
      assert.match(text, /logs\/big\.log/);
      assert.match(text, /最新的一个是/);
    });

    await check('stat 给出大小/行数/是否在写/末尾预览', async () => {
      const { text } = await callTool(session, 'stat', { path: 'logs/app.log', project: 'projA' });
      assert.match(text, /type=file/);
      assert.match(text, /lines=6/);
      assert.match(text, /末尾 \d 行预览/);
      assert.match(text, /recovered/);
    });

    console.log('\n— 只读边界 —');
    await check('跨越白名单的绝对路径被拒（/etc/passwd 或 C:\\Windows）', async () => {
      const outside = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd';
      const { text, isError } = await callTool(session, 'cat', { path: outside });
      assert.equal(isError, true);
      assert.match(text, /不允许|不在允许的根目录/);
    });

    await check('项目别名穿越（project + ../../）被拒', async () => {
      const { text, isError } = await callTool(session, 'cat', { path: '../../etc/passwd', project: 'projA' });
      assert.equal(isError, true);
      assert.match(text, /不允许|\.\./);
    });

    await check('目录当文件读 → 明确报错并建议 ls', async () => {
      const { text, isError } = await callTool(session, 'cat', { path: 'logs', project: 'projA' });
      assert.equal(isError, true);
      assert.match(text, /是目录/);
    });

    await check('不存在的工具名 → isError 并列出可用工具', async () => {
      const { text, isError } = await callTool(session, 'rm_rf', { path: '/' });
      assert.equal(isError, true);
      assert.match(text, /没有这个工具/);
    });

    await check('不存在的工具方法 → -32601', async () => {
      let code = null;
      try {
        await rpc('fs/write', { path: '/tmp/x' }, session);
      } catch (err) {
        code = err.message;
      }
      assert.match(String(code), /-32601/);
    });

    console.log('\n— 会话与审计 —');
    await check('DELETE 会话后旧 session 失效', async () => {
      const fresh = await rpc('initialize', { protocolVersion: '2025-06-18' });
      const sid = fresh.headers['mcp-session-id'];
      const del = await request('DELETE', '/mcp', {
        headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sid },
      });
      assert.equal(del.status, 204);
      const after = await request('POST', '/mcp', {
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'mcp-session-id': sid,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 500, method: 'tools/list', params: {} }),
      });
      assert.equal(after.status, 404);
    });

    await check('审计日志按 NDJSON 记录了每次调用', async () => {
      await new Promise((r) => setTimeout(r, 300));
      const lines = (await fsp.readFile(auditFile, 'utf8')).trim().split('\n').filter(Boolean);
      assert.ok(lines.length >= 10, `审计行数太少：${lines.length}`);
      const rec = JSON.parse(lines[lines.length - 1]);
      assert.ok(rec.tool);
      assert.ok(rec.ts);
      assert.equal(rec.session, auditSession);
    });

    await check('SSE 模式（Accept: text/event-stream）也能拿到结果', async () => {
      const res = await rpc('tools/call', { name: 'list_roots', arguments: {} }, session, {
        accept: 'text/event-stream',
      });
      assert.match(res.headers['content-type'] || '', /text\/event-stream/);
      assert.match(res.raw, /event: message/);
      assert.ok(res.result.content[0].text.includes('projA'));
    });

    await check('服务端进程全程没有写业务目录（fixtures 只读）', async () => {
      const entries = await fsp.readdir(fixtures.logsA);
      assert.deepEqual(entries.sort(), ['app.log', 'big.log', 'binary.bin', 'error.log']);
      const st = await fsp.stat(path.join(fixtures.logsA, 'app.log'));
      assert.ok(st.size > 0);
    });
  } finally {
    await cleanup();
  }

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  if (failed > 0) {
    for (const f of failures) console.log(`\n✗ ${f.name}\n${f.err.stack}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('测试自身崩了：', err);
  process.exit(2);
});
