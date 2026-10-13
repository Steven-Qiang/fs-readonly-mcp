// 调试用：把 initialize 的原始响应（状态行、响应头、正文）打出来
import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = 8793;
const child = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env,
    MCP_PORT: String(PORT),
    MCP_HOST: '127.0.0.1',
    MCP_TOKEN: 't0ken',
    MCP_ROOTS: process.cwd(),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`[server:err] ${d}`));

await new Promise((r) => setTimeout(r, 1200));

const body = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
});

const raw = await new Promise((resolve, reject) => {
  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer t0ken', 'content-length': Buffer.byteLength(body) } },
    (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, rawHeaders: res.rawHeaders, headers: res.headers, text }));
    },
  );
  req.on('error', reject);
  req.end(body);
});

console.log('STATUS', raw.status);
console.log('RAW HEADERS', JSON.stringify(raw.rawHeaders, null, 2));
console.log('PARSED', JSON.stringify(raw.headers, null, 2));
console.log('BODY', raw.text);

child.kill('SIGTERM');
process.exit(0);
