// 端到端自测：造一批真实日志文件 → 起真实服务（express + 官方 MCP SDK）→ 走完整 MCP 流程 → 逐个工具断言。
// 跑法：node test/test.js      退出码 0 = 全通过
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const PORT = Number(process.env.TEST_PORT || 8000 + Math.floor(Math.random() * 900));
const TOKEN = 'test-token-please-change';
const LONG = 1024 * 1024 + 4096; // 超过单行 1MB 上限，用来验证超长行处理
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
    console.log(`  ✗ ${name}\n      ${String(err.message).split('\n')[0]}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function assertMatch(text, re, label) {
  if (!re.test(text)) {
    throw new Error(`${label || '内容'}不匹配 ${re}\n---实际输出---\n${String(text).slice(0, 1200)}`);
  }
}

// ---------- 测试用目录与文件 ----------
async function makeFixtures(root) {
  const projA = path.join(root, 'projA');
  const projB = path.join(root, 'projB');
  const logsA = path.join(projA, 'logs');
  await fsp.mkdir(logsA, { recursive: true });
  await fsp.mkdir(path.join(projB, 'sub'), { recursive: true });

  const appLines = [
    '2026-01-01 10:00:00 INFO  boot ok',
    '2026-01-01 10:00:01 INFO  loaded config',
    '2026-01-01 10:00:02 ERROR connect redis failed: timeout',
    '2026-01-01 10:00:03 INFO  retrying',
    '2026-01-01 10:00:04 ERROR connect redis failed: timeout',
    '2026-01-01 10:00:05 recovered',
  ];
  await fsp.writeFile(path.join(logsA, 'app.log'), `${appLines.join('\n')}\n`, 'utf8');
  await fsp.writeFile(path.join(logsA, 'error.log'), 'ERROR boom\n', 'utf8');
  await fsp.writeFile(path.join(logsA, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x00, 0x10]), 'binary');
  await fsp.writeFile(path.join(projA, '.env'), 'DB_PASSWORD=some-value\n', 'utf8');
  await fsp.writeFile(path.join(projB, 'sub', 'today.out'), 'worker started\nworker done\n', 'utf8');
  await fsp.writeFile(path.join(projB, 'notes.txt'), 'hello world\n', 'utf8');
  await fsp.mkdir(path.join(projA, 'node_modules', 'left-pad'), { recursive: true });
  await fsp.writeFile(path.join(projA, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n', 'utf8');

  // 大文件：约 2.7MB / 5 万行，用来验证「大文件不整读 + 能定位到尾部」
  const big = path.join(logsA, 'big.log');
  const handle = await fsp.open(big, 'w');
  let buf = '';
  for (let i = 0; i < 50_000; i += 1) {
    buf += `2026-01-01 12:00:${String(i % 60).padStart(2, '0')} INFO  request id=${i} latency=${i % 997}ms\n`;
    if (buf.length > 512 * 1024) {
      await handle.write(buf);
      buf = '';
    }
  }
  await handle.write(buf);
  await handle.close();
  return { projA, projB, logsA, big, appLines };
}

// ---------- HTTP 小客户端 ----------
function request(method, urlPath, { headers = {}, body = null, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let nextId = 1;
async function rpc(method, params, { token = TOKEN, accept = 'application/json, text/event-stream' } = {}) {
  const id = nextId++;
  const headers = { 'content-type': 'application/json', accept };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await request('POST', '/mcp', { headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  let payload = null;
  if ((res.headers['content-type'] || '').includes('text/event-stream')) {
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

async function callTool(name, args) {
  const { result } = await rpc('tools/call', { name, arguments: args });
  assert(result, `tools/call ${name} 没有返回 result`);
  assert(Array.isArray(result.content) && result.content[0]?.type === 'text', `${name} 没有文本 content`);
  return { text: result.content[0].text, isError: !!result.isError };
}

// ---------- 主流程 ----------
async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fsmcp-test-'));
  const auditFile = path.join(root, 'audit.ndjson');
  const fixtures = await makeFixtures(root);
  // 白名单外的哨兵文件：用来证明「配了 roots 会被拦」
  const outsideFile = path.join(os.tmpdir(), `fsmcp-outside-${Date.now()}.log`);
  await fsp.writeFile(outsideFile, 'outside-marker-line\n', 'utf8');
  // 「不配 roots」的默认可见范围 = 当前盘（POSIX 上是 /）。这台机器上临时目录在 C 盘、
  // 项目在 D 盘，所以要在项目所在盘放一个哨兵，才能验证默认范围确实放开了一整个盘。
  const projectVolumeRoot = path.parse(PROJECT).root;
  const volumeSentinel = path.join(projectVolumeRoot, `fsmcp-volume-sentinel-${Date.now()}.log`);
  await fsp.writeFile(volumeSentinel, 'volume-marker-line\n', 'utf8');
  console.log(`临时目录: ${root}`);
  console.log(`服务端口: ${PORT}`);
  console.log(`当前盘哨兵: ${volumeSentinel}\n`);

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
  child.stdout.on('data', (d) => (serverLog += d.toString()));
  child.stderr.on('data', (d) => (serverLog += d.toString()));

  const cleanup = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (child.exitCode === null) child.kill('SIGKILL');
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(outsideFile, { force: true }).catch(() => {});
    await fsp.rm(volumeSentinel, { force: true }).catch(() => {});
  };

  try {
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
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

    console.log('— 传输层（express + 官方 MCP SDK） —');
    await check('GET /healthz 返回只读信息与工具清单', async () => {
      const res = await request('GET', '/healthz');
      assert(res.status === 200, `状态码 ${res.status}`);
      const info = JSON.parse(res.text);
      assert(info.ok === true, 'ok 不为 true');
      assert(info.writeable === false, 'writeable 必须为 false');
      assert(
        JSON.stringify(info.tools) === JSON.stringify(['list_roots', 'ls', 'glob_files', 'stat', 'cat', 'tail', 'grep']),
        `工具清单不对：${JSON.stringify(info.tools)}`,
      );
      assert(info.roots.length === 2, '根目录数不对');
    });

    await check('没有 token 一律 401', async () => {
      const res = await request('POST', '/mcp', {
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      assert(res.status === 401, `状态码 ${res.status}`);
    });

    await check('token 不接受 query string（会进 access log）', async () => {
      const res = await request('POST', `/mcp?token=${encodeURIComponent(TOKEN)}`, {
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
      });
      assert(res.status === 401, `query 里的 token 不该被接受，实际状态码 ${res.status}`);
    });

    await check('token 不对也是 401', async () => {
      const res = await request('POST', '/mcp', {
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer wrong',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
      });
      assert(res.status === 401, `状态码 ${res.status}`);
    });

    await check('坏 JSON → 400', async () => {
      const res = await request('POST', '/mcp', {
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${TOKEN}` },
        body: '{not json',
      });
      assert(res.status === 400, `状态码 ${res.status}`);
    });

    await check('initialize 返回 serverInfo / capabilities / instructions', async () => {
      const res = await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      });
      assert(res.status === 200, `状态码 ${res.status}`);
      assert(res.result, '没有 result');
      assertMatch(JSON.stringify(res.result), /fs-readonly-mcp/, 'serverInfo');
      assert(res.result.capabilities?.tools, '缺少 tools 能力');
      assert(typeof res.result.instructions === 'string', '缺少 instructions');
    });

    await check('tools/list 返回 7 个工具，全部只读且 schema 不含伪必填', async () => {
      const res = await rpc('tools/list', {});
      const tools = res.result.tools;
      assert(tools.length === 7, `工具数 ${tools.length}`);
      for (const t of tools) {
        assert(t.annotations?.readOnlyHint === true, `${t.name} 没声明 readOnlyHint`);
        assert(t.description && t.description.length > 20, `${t.name} 描述太短`);
        assert(t.inputSchema?.type === 'object', `${t.name} inputSchema 不是 object`);
        const req = t.inputSchema.required || [];
        const props = Object.keys(t.inputSchema.properties || {});
        for (const r of req) assert(props.includes(r), `${t.name} 的 required 字段 ${r} 不在 properties 里`);
        // 只有真正必填的参数才允许 required 非空
        const expected = { list_roots: [], ls: [], glob_files: ['pattern'], stat: ['path'], cat: ['path'], tail: ['path'], grep: ['pattern'] }[t.name];
        assert(
          JSON.stringify([...req].sort()) === JSON.stringify([...expected].sort()),
          `${t.name} 的 required 应为 ${JSON.stringify(expected)}，实际 ${JSON.stringify(req)}`,
        );
      }
    });

    await check('协议版本协商：客户端报旧版本不会 500', async () => {
      const res = await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'old-client', version: '0.0.1' },
      });
      assert(res.status === 200, `状态码 ${res.status}`);
      assert(res.result?.protocolVersion, '没有返回 protocolVersion');
    });

    await check('不存在的 JSON-RPC 方法 → -32601', async () => {
      let msg = null;
      try {
        await rpc('fs/write', { path: '/tmp/x' });
      } catch (err) {
        msg = err.message;
      }
      assertMatch(String(msg), /-32601/, '错误码');
    });

    console.log('\n— 工具：list_roots / ls —');
    await check('list_roots 列出两个根目录且标记可读', async () => {
      const { text, isError } = await callTool('list_roots', {});
      assert(!isError, '不应报错');
      assertMatch(text, /project="projA"/, 'projA');
      assertMatch(text, /project="projB"/, 'projB');
      assertMatch(text, /可读/, '可读标记');
    });

    await check('ls 一层目录：忽略 node_modules，列出大小', async () => {
      const { text } = await callTool('ls', { path: 'logs', project: 'projA' });
      assertMatch(text, /app\.log/, 'app.log');
      assertMatch(text, /binary\.bin/, 'binary.bin');
      assert(!text.includes('node_modules'), 'node_modules 不该出现');
    });

    await check('ls 递归 + pattern 能找到下层的 .out', async () => {
      const { text } = await callTool('ls', { path: '', project: 'projB', depth: 3, pattern: '*.out' });
      assertMatch(text, /sub\/today\.out/, 'today.out');
    });

    await check('ls 不存在的路径 → isError + 明确提示', async () => {
      const { text, isError } = await callTool('ls', { path: 'nope/nowhere', project: 'projA' });
      assert(isError === true, '应当 isError');
      assertMatch(text, /E_NOT_FOUND|找不到/, '错误类型');
    });

    console.log('\n— 工具：cat —');
    await check('cat 小文件带行号', async () => {
      const { text } = await callTool('cat', { path: 'logs/app.log', project: 'projA' });
      assertMatch(text, /1\| 2026-01-01 10:00:00 INFO/, '第一行');
      assertMatch(text, /3\| .*ERROR connect redis failed/, '第三行');
    });

    await check('cat 省略所有可选参数也能工作（schema 默认值兜底）', async () => {
      // 同时声明 json 与 sse 时 SDK 可能走 SSE 分帧，用 rpc() 统一解析
      const res = await rpc('tools/call', { name: 'cat', arguments: { path: 'logs/app.log', project: 'projA' } });
      assert(!res.result?.isError, `不应报错：${res.raw.slice(0, 300)}`);
      assertMatch(res.result.content[0].text, /6\| .*recovered/, '最后一行');
    });

    await check('cat 大文件不整读，返回尾部预览 + 三种读法提示', async () => {
      const { text } = await callTool('cat', { path: 'logs/big.log', project: 'projA' });
      assertMatch(text, /没有整读/, '拒绝整读');
      assertMatch(text, /尾部预览/, '预览');
      assertMatch(text, /tail path=/, '提示 tail');
      assertMatch(text, /grep path=/, '提示 grep');
      assert(text.length < 8000, `预览不该这么长：${text.length}`);
    });

    await check('cat 显式分片读不受阈值影响', async () => {
      const { text } = await callTool('cat', { path: 'logs/big.log', project: 'projA', offset: 0, limit: 3 });
      assertMatch(text, /1\| /, '第一行');
      assertMatch(text, /3\| /, '第三行');
    });

    await check('cat 分片续读：offset 接着上一片，行号连续', async () => {
      const first = await callTool('cat', { path: 'logs/big.log', project: 'projA', offset: 0, limit: 5 });
      const m = /offset=(\d+)/.exec(first.text);
      assert(m, `第一片没给出 nextOffset：${first.text.slice(0, 300)}`);
      const second = await callTool('cat', { path: 'logs/big.log', project: 'projA', offset: Number(m[1]), limit: 5 });
      assertMatch(second.text, /6\| /, '第二片行号');
    });

    await check('cat 拒绝二进制文件', async () => {
      const { text, isError } = await callTool('cat', { path: 'logs/binary.bin', project: 'projA' });
      assert(isError === true, '应当 isError');
      assertMatch(text, /二进制/, '二进制提示');
    });

    await check('cat 能读 .env（跳板机内网环境不做凭据拦截）', async () => {
      const { text, isError } = await callTool('cat', { path: '.env', project: 'projA' });
      assert(!isError, '不应报错');
      assertMatch(text, /1\| DB_PASSWORD=some-value/, '.env 内容');
    });

    console.log('\n— 工具：tail —');
    await check('tail 大日志只读尾部，快且带收尾提示', async () => {
      const t0 = Date.now();
      const { text } = await callTool('tail', { path: 'logs/big.log', project: 'projA', lines: 5 });
      const ms = Date.now() - t0;
      const expectedKeys = fixtures.appLines.length;
      void expectedKeys;
      assertMatch(text, /id=49999/, '末尾行');
      assert(ms < 3000, `tail 太慢：${ms}ms`);
      assertMatch(text, /\[hint\]/, '收尾提示');
    });

    await check('tail 支持多文件对比', async () => {
      const { text } = await callTool('tail', { path: 'logs/app.log,logs/error.log', project: 'projA', lines: 2 });
      assertMatch(text, /app\.log/, 'app.log');
      assertMatch(text, /error\.log/, 'error.log');
      assertMatch(text, /ERROR boom/, 'error.log 内容');
    });

    await check('tail mode=bytes 返回原始字节', async () => {
      const { text } = await callTool('tail', { path: 'logs/app.log', project: 'projA', mode: 'bytes', bytes: 30 });
      assertMatch(text, /末 30 字节/, '字节模式');
      assertMatch(text, /recovered/, '末尾内容');
    });

    console.log('\n— 工具：grep / glob_files / stat —');
    await check('grep 目录递归命中并带 file:line', async () => {
      const { text } = await callTool('grep', { pattern: 'ERROR', path: '', project: 'projA' });
      assertMatch(text, /logs\/app\.log/, '文件分组');
      assertMatch(text, /3: .*connect redis failed/, '第 3 行');
      assertMatch(text, /5: .*connect redis failed/, '第 5 行');
    });

    await check('grep beforeContext 带上下文行（用 - 标记）', async () => {
      const { text } = await callTool('grep', {
        pattern: 'ERROR connect',
        path: 'logs/app.log',
        project: 'projA',
        beforeContext: 1,
      });
      assertMatch(text, /2- .*loaded config/, '上下文行');
      assertMatch(text, /3: .*connect redis failed/, '命中行');
    });

    await check('grep literal 把正则元字符当纯文本', async () => {
      const { text } = await callTool('grep', { pattern: 'INFO  boot', path: 'logs/app.log', project: 'projA', literal: true });
      assertMatch(text, /boot ok/, '命中内容');
    });

    await check('grep 非法正则 → isError 且提示 literal', async () => {
      const { text, isError } = await callTool('grep', { pattern: '([', path: '', project: 'projA' });
      assert(isError === true, '应当 isError');
      assertMatch(text, /literal/, '提示 literal');
    });

    await check('grep 大文件能命中尾部内容（流式扫描）', async () => {
      const { text } = await callTool('grep', { pattern: 'id=49999', path: 'logs/big.log', project: 'projA' });
      assertMatch(text, /49999/, '命中');
      assertMatch(text, /命中 1 行/, '命中计数');
    });

    await check('grep 无命中时给出收窄建议', async () => {
      const { text } = await callTool('grep', { pattern: 'ZZZ_NOT_THERE', path: '', project: 'projA' });
      assertMatch(text, /没有命中/, '无命中');
      assertMatch(text, /\[hint\]/, '建议');
    });

    await check('glob_files 按通配找文件并推荐最新那个', async () => {
      const { text } = await callTool('glob_files', { pattern: '*.log', path: '', project: 'projA' });
      assertMatch(text, /logs\/app\.log/, 'app.log');
      assertMatch(text, /logs\/big\.log/, 'big.log');
      assertMatch(text, /最新的一个是/, '最新推荐');
    });

    await check('stat 给出大小/行数/是否在写/末尾预览', async () => {
      const { text } = await callTool('stat', { path: 'logs/app.log', project: 'projA' });
      assertMatch(text, /type=file/, 'type');
      assertMatch(text, /lines=6/, '行数');
      assertMatch(text, /末尾 \d 行预览/, '预览标题');
      assertMatch(text, /recovered/, '预览内容');
    });

    console.log('\n— 只读边界 —');
    await check('配了 roots 时，白名单外的路径被拒', async () => {
      const { text, isError } = await callTool('cat', { path: outsideFile });
      assert(isError === true, '应当 isError');
      assertMatch(text, /不允许|不在允许的根目录/, '越界提示');
    });

    await check('跨越白名单的绝对路径被拒', async () => {
      const outside = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd';
      const { text, isError } = await callTool('cat', { path: outside });
      assert(isError === true, '应当 isError');
      assertMatch(text, /不允许|不在允许的根目录/, '越界提示');
    });

    await check('项目别名穿越（project + ../../）被拒', async () => {
      const { text, isError } = await callTool('cat', { path: '../../etc/passwd', project: 'projA' });
      assert(isError === true, '应当 isError');
      assertMatch(text, /不允许|\.\./, '穿越提示');
    });

    await check('目录当文件读 → 明确报错并建议 ls', async () => {
      const { text, isError } = await callTool('cat', { path: 'logs', project: 'projA' });
      assert(isError === true, '应当 isError');
      assertMatch(text, /是目录/, '目录提示');
    });

    await check('不存在的工具名 → 明确报错（SDK 返回 -32602 并点名工具）', async () => {
      let msg = null;
      try {
        await callTool('rm_rf', { path: '/' });
      } catch (err) {
        msg = err.message;
      }
      assertMatch(String(msg), /rm_rf/, '错误里应点名工具');
      assertMatch(String(msg), /-32602/, '错误码');
    });

    await check('参数类型不对被拦下（不给 AI 静默错值）', async () => {
      const { text, isError } = await callTool('tail', { path: 'logs/app.log', lines: '不是数字' });
      assert(isError === true, '应当 isError');
      assertMatch(text, /lines/, '错误里应点名参数');
      assertMatch(text, /expected number|Invalid/i, '参数校验错误');
    });

    console.log('\n— 审计与 SSE —');
    await check('审计日志按 NDJSON 记录了每次调用', async () => {
      await new Promise((r) => setTimeout(r, 300));
      const records = (await fsp.readFile(auditFile, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      assert(records.length >= 10, `审计行数太少：${records.length}`);
      const ok = records.filter((r) => r.ok);
      assert(ok.length >= 8, `成功记录太少：${ok.length}`);
      assert(
        records.some((r) => r.tool === 'grep'),
        '没记录到 grep',
      );
      for (const r of ok) {
        assert(r.ts, '缺少 ts');
        assert(typeof r.ms === 'number', `缺少 ms：${JSON.stringify(r)}`);
        assert(typeof r.args === 'object', '缺少 args');
      }
    });

    await check('客户端按规范同时接受 json 与 sse 时拿到合法响应', async () => {
      const res = await rpc('tools/call', { name: 'list_roots', arguments: {} }, { accept: 'application/json, text/event-stream' });
      assert(res.status === 200, `状态码 ${res.status}`);
      assert(res.result?.content?.[0]?.text, '没有文本结果');
      assertMatch(res.result.content[0].text, /projA/, '结果内容');
    });

    await check('超长行（>1MB）不丢行、行号不错位（回归：曾经整行被静默丢弃）', async () => {
      const big2 = path.join(fixtures.logsA, 'longline.log');
      const h = await fsp.open(big2, 'w');
      const junk = 'x'.repeat(Math.floor(LONG / 2));
      await h.write('head1\n');
      await h.write(junk);
      await h.write(junk);
      await h.write('\ntail3\n');
      await h.close();

      const { text } = await callTool('cat', { path: 'logs/longline.log', project: 'projA', limit: 10 });
      assertMatch(text, /1\| head1/, '第一行');
      assertMatch(text, /2\|/, '超长行必须出现（不能被丢掉）');
      assertMatch(text, /3\| tail3/, '超长行后面那行的行号必须是 3（差 1 就是错位）');
      assertMatch(text, /超过|已截断/, '必须提示超长行被截断');
    });

    await check('超长行之后分片续读能推进（不会死循环）', async () => {
      const big3 = path.join(fixtures.logsA, 'longline2.log');
      const h = await fsp.open(big3, 'w');
      await h.write('a1\n');
      await h.write('y'.repeat(LONG + 100));
      await h.write('\nafter-long\nlast-line\n');
      await h.close();

      const first = await callTool('cat', { path: 'logs/longline2.log', project: 'projA', limit: 1 });
      const m = /offset=(\d+)/.exec(first.text);
      assert(m, '第一片要给 nextOffset：' + first.text.slice(0, 200));
      const next = Number(m[1]);
      assert(next > 0, 'nextOffset 必须前进');
      const second = await callTool('cat', { path: 'logs/longline2.log', project: 'projA', offset: next, limit: 2 });
      assertMatch(second.text, /2\|/, '续读要从第 2 行（超长行）开始');
      const m2 = /offset=(\d+)/.exec(second.text);
      if (m2) assert(Number(m2[1]) > next, '第二片的 nextOffset 必须比第一片大，否则会死循环');
    });

    await check('服务端进程全程没有改过业务目录', async () => {
      const entries = (await fsp.readdir(fixtures.logsA)).sort();
      const expected = ['app.log', 'big.log', 'binary.bin', 'error.log', 'longline.log', 'longline2.log'];
      assert(JSON.stringify(entries) === JSON.stringify(expected), `目录内容被改了：${JSON.stringify(entries)}`);
    });

    // 另起一个「不配 MCP_ROOTS」的实例：默认范围应当是「当前盘」（POSIX 上是 /）
    console.log('\n— 不配 MCP_ROOTS（默认当前盘可读） —');
    await check('未配 roots 时，当前盘内任意绝对路径都可读', async () => {
      const port2 = PORT + 7;
      const env2 = { ...process.env, MCP_PORT: String(port2), MCP_HOST: '127.0.0.1', MCP_TOKEN: TOKEN };
      // 关键：删掉继承来的 MCP_ROOTS，才能验证「不配 roots」的默认行为
      delete env2.MCP_ROOTS;
      const child2 = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.js')], {
        env: env2,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const call2 = undefined;
      void call2;
      try {
        // 等它起来（注意带 port2，别打到第一个实例上）
        let up = false;
        for (let i = 0; i < 60; i += 1) {
          try {
            const r = await request('GET', '/healthz', { port: port2 });
            if (r.status === 200) {
              up = true;
              break;
            }
          } catch {
            /* wait */
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        assert(up, '第二个实例没起来');

        const health = JSON.parse((await request('GET', '/healthz', { port: port2 })).text);
        assert(health.roots.length === 1, `根目录数不对：${JSON.stringify(health.roots)}`);
        assert(
          health.roots[0].dirs[0] === '/' || /^[A-Za-z]:\/$/.test(health.roots[0].dirs[0]),
          `默认根目录应是文件系统根，实际 ${health.roots[0].dirs[0]}`,
        );

        // 用 raw http 打到第二个端口：读「项目所在盘根目录」下的哨兵
        const callRaw = (filePath) =>
          new Promise((resolve, reject) => {
            const payload = JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'cat', arguments: { path: filePath } },
            });
            const req = http.request(
              {
                host: '127.0.0.1',
                port: port2,
                path: '/mcp',
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  accept: 'application/json, text/event-stream',
                  authorization: `Bearer ${TOKEN}`,
                  'content-length': Buffer.byteLength(payload),
                },
              },
              (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (c) => (text += c));
                res.on('end', () => resolve(text));
              },
            );
            req.on('error', reject);
            req.end(payload);
          });

        const raw = await callRaw(volumeSentinel);
        const json = JSON.parse((/^data: (.*)$/m.exec(raw) || [null, raw])[1]);
        assert(!json.result?.isError, `不该报错：${JSON.stringify(json.result).slice(0, 300)}`);
        assertMatch(json.result.content[0].text, /volume-marker-line/, '当前盘根目录下哨兵文件的内容');

        // 反向确认：另一个盘（POSIX 上不存在这一档）仍被拒，证明「全盘」没有放大成「整机」
        if (process.platform === 'win32') {
          const otherDrive = `${projectVolumeRoot[0].toLowerCase() === 'c' ? 'D' : 'C'}:/`;
          const otherFile = path.join(otherDrive, `fsmcp-other-volume-${Date.now()}.log`);
          try {
            await fsp.writeFile(otherFile, 'other-volume-line\n', 'utf8');
            const raw2 = await callRaw(otherFile);
            const json2 = JSON.parse((/^data: (.*)$/m.exec(raw2) || [null, raw2])[1]);
            assert(json2.result?.isError === true, `另一个盘的路径应当被拒，实际：${raw2.slice(0, 200)}`);
            assertMatch(json2.result.content[0].text, /E_OUTSIDE/, '越界错误');
          } catch (err) {
            if (err?.code !== 'EPERM' && err?.code !== 'EACCES') throw err;
            console.log('      （另一个盘不可写，跳过反向确认）');
          } finally {
            await fsp.rm(otherFile, { force: true }).catch(() => {});
          }
        }
      } finally {
        child2.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        if (child2.exitCode === null) child2.kill('SIGKILL');
      }
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
