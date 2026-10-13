// 审计：谁（哪个客户端）在什么时候，用哪个工具，读了什么路径，返回了多少。NDJSON 追加写。
import fs from 'node:fs';
import path from 'node:path';

export function createAudit(config) {
  const target = config.auditLog;
  if (!target) {
    return { enabled: false, write() {}, info: '审计未开启（未配置 MCP_AUDIT_LOG）' };
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    /* 目录建不出来时下面写会失败，交给 catch 处理 */
  }
  const stream = fs.createWriteStream(target, { flags: 'a' });
  stream.on('error', () => {
    /* 审计写失败绝不能影响只读服务本身 */
  });
  return {
    enabled: true,
    info: `审计日志 → ${target}`,
    write(record) {
      try {
        stream.write(`${JSON.stringify(record)}\n`);
      } catch {
        /* ignore */
      }
    },
  };
}
