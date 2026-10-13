// 审计：谁（哪个客户端）在什么时候，用哪个工具，读了什么路径，返回了多少。NDJSON 追加写。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * @typedef {object} AuditRecord
 * @property {string} ts ISO 时间
 * @property {string} [session] 会话号
 * @property {string} [tool] 工具名
 * @property {Record<string, unknown>} [args] 调用参数
 * @property {boolean} ok 是否成功
 * @property {number} [ms] 耗时毫秒
 * @property {number} [chars] 返回给 AI 的字符数
 * @property {boolean} [truncated] 是否被服务端上限截断
 * @property {string} [code] 失败时的错误码
 * @property {string} [message] 失败原因
 */

/**
 * @typedef {object} Audit
 * @property {boolean} enabled 是否真的在写盘
 * @property {string} info 启动日志里显示的一行说明
 * @property {(record: AuditRecord) => void} write 追加一条记录（永不抛错）
 */

/** 审计写盘失败只在 stderr 提示，绝不因为审计挂掉只读服务 */
function warnOnce(/** @type {string} */ message) {
  try {
    process.stderr.write(`[audit] ${message}\n`);
  } catch {
    /* stderr 都写不了就放弃提示 */
  }
}

/**
 * 创建审计写入器。未配置 MCP_AUDIT_LOG 时返回一个空实现。
 * @param {{ auditLog: string }} config
 * @returns {Audit}
 */
export function createAudit(config) {
  const target = config.auditLog;
  if (!target) {
    return { enabled: false, info: '审计未开启（未配置 MCP_AUDIT_LOG）', write() {} };
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    /* 目录建不出来时下面的写会失败，交给 write 的错误回调 */
  }

  const stream = fs.createWriteStream(target, { flags: 'a' });
  let failed = false;
  const onFailure = (/** @type {Error} */ err) => {
    if (failed) return;
    failed = true;
    warnOnce(`写入失败，后续调用不再记录：${err.message}`);
  };
  stream.on('error', onFailure);

  return {
    enabled: true,
    info: `审计日志 → ${target}`,
    write(record) {
      try {
        stream.write(`${JSON.stringify(record)}\n`, (err) => {
          if (err) onFailure(err);
        });
      } catch (err) {
        onFailure(/** @type {Error} */ (err));
      }
    },
  };
}
