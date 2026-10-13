// 裸启动实测：不配 MCP_ROOTS，验证「整个文件系统可读」
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8901;
const TOKEN = 't1';

const env = { ...process.env, MCP_PORT: String(PORT), MCP_HOST: '127.0.0.1', MCP_TOKEN: TOKEN };
delete env.MCP_ROOTS;

const child = spawn(process.execPath, [path.join(PROJECT, 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`[server:err] ${d}`));

const post = (body) =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
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

const get = (p) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      })
      .on('error', reject);
  });

const call = async (name, args) => {
  const raw = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const m = /^data: (.*)$/m.exec(raw);
  const json = JSON.parse(m ? m[1] : raw);
  const text = json.result?.content?.[0]?.text ?? JSON.stringify(json);
  return (json.result?.isError ? '[ERR] ' : '') + text;
};

const show = (title, text, n = 6) => {
  console.log(`\n== ${title} ==`);
  console.log(String(text).split('\n').slice(0, n).join('\n'));
};

try {
  let up = false;
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await get('/healthz');
      if (r.status === 200) {
        up = true;
        break;
      }
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error('服务没起来');

  const health = JSON.parse((await get('/healthz')).text);
  console.log('healthz.roots =', JSON.stringify(health.roots));
  console.log('auth =', health.auth, '| writeable =', health.writeable);

  show('list_roots', await call('list_roots', {}), 4);
  show('ls 一层 /', await call('ls', { path: '/', maxEntries: 10 }), 12);
  show('ls /data （这台机器上没有 /data）', await call('ls', { path: '/data' }), 3);
  show('cat 一个白名单外的绝对路径（证明全盘可读）', await call('cat', { path: process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/hostname' }), 4);
} finally {
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    process.exit(0);
  }, 500);
}
