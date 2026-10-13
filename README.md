# fs-readonly-mcp · 只读文件系统 MCP 服务

给 AI 一个「只能看、不能改」的文件入口，用来排查散落在各个项目里的日志。

- **传输**：MCP Streamable HTTP，端点是 `POST /mcp`（express + 官方 `@modelcontextprotocol/*` v2）
- **只读**：7 个工具全部声明 `readOnlyHint: true`，进程里不存在任何写文件的代码路径（启动时强制校验，缺一个就拒绝启动）
- **性能**：`tail` 只读文件末尾窗口，与文件大小无关；`grep` 逐行流式扫描；`cat` 对大文件拒绝整读，只给分片和明确提示
- **鉴权**：连接层 Bearer Token，没配 token 时任何人可读（启动会告警）

> 文档里的路径（`/srv/app-a`、`/opt/fs-readonly-mcp` 等）和项目名（`app-a`、`web`）都是**通用示例**，请替换成你自己的目录。
>
> **部署前先想清楚可见范围**：不配 `MCP_ROOTS` 就是**整机可读**。做内网/跳板机用途时这是刻意的取舍，但此时 `MCP_TOKEN` 是唯一的门，务必配上并开启 `MCP_AUDIT_LOG`；只想放开部分目录就直接列出来。详见第 3 节。

---

## 1. 工具清单

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `list_roots` | 看这台机器上能读哪些目录 / 项目别名。**排查第一步** | — |
| `ls` | 列目录，`depth>1` 递归。默认只列一层 | `path` `project` `depth` `pattern` `maxEntries` |
| `glob_files` | 按名字找文件（`*.log`、`*error*`），只回路径和大小 | `pattern` `path` `maxDepth` `limit` |
| `stat` | 大小 / mtime / 权限 / 行数 / 是否正在写 / 末尾预览 | `path` `previewLines` `countLines` |
| `cat` | 读文件内容，带行号。`offset` 是**字节偏移**，可续读 | `path` `offset` `limit` `lineNumbers` |
| `tail` | 看末尾 N 行，与文件大小无关。支持多文件、`.gz`、按字节 | `path` `lines` `mode` `bytes` `number` |
| `grep` | 跨文件 / 跨目录搜内容，流式扫描，带上下文行 | `pattern` `path` `glob` `literal` `limit` `maxFiles` |

所有工具都接受 `project`（项目别名，来自 `list_roots`）或 `path`（绝对路径 / 相对 `project` 的路径）。

### 大文件时 AI 会看到什么

这是本服务的设计重点：**不整读，并且每次都告诉 AI 下一步该用什么参数**。

- `cat` 遇到 >1MB 且没指定 `limit` 的文件 → 拒绝整读，回一段末尾预览 + 四条可照抄的读法
- 任何被截断的结果都带 `[hint]` / `[action]`，写明要继续时 `offset` 该填什么、`limit` 该提到多少
- `grep` 因为命中数 / 文件数 / 时间预算而提前停止时，明确说明停止原因和收窄办法
- 输出超过服务端上限（`MCP_MAX_TEXT_CHARS`，默认 64000 字符）时，写清是「上限截断」并禁止用加大上限来重试

---

## 2. 目录结构

```
src/
  server.js          express + MCP handler + Bearer 鉴权 + /healthz
  config.js          环境变量 / .env 两层配置
  roots.js           根目录白名单：realpath 归一 + 越界拦截 + 项目别名解析
  util.js            纯函数（字节/时间格式化、glob→正则、路径包含判断）
  primitives.js      只读 IO 原语：流式逐行、尾部窗口读、二进制识别、数行
  walk.js            目录遍历：一层用 opendir 流式、递归用有界 BFS + 并发池
  audit.js           审计日志（NDJSON 追加）
  tools/
    index.js         工具注册表 + 只读校验 + 统一异常/耗时/审计
    base.js          defineTool 基座、[meta]/[hint] 输出格式
    roots.js ls.js glob.js stat.js cat.js tail.js grep.js
test/
  test.js            端到端测试（起真实服务 + 造真实日志 + 38 条断言）
  perf.mjs           性能验证（默认造 500MB 日志，可 PERF_MB 调整）
deploy/
  supervisor.conf    supervisor 托管配置（纯 ASCII，可直接放进 conf.d）
  logrotate.conf     审计日志轮转
  nginx.conf.example 反代示例（关键：proxy_buffering off）
```

---

## 3. 配置

两层来源，优先级从高到低：**进程环境变量 → 项目根 `.env`**。完整模板见 [`.env.example`](.env.example)。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MCP_HOST` | `0.0.0.0` | 监听地址 |
| `MCP_PORT` | `7801` | 监听端口 |
| `MCP_TOKEN` | 空 | Bearer Token。**留空 = 不鉴权**，启动会打印告警 |
| `MCP_ROOTS` | 空（= 整个文件系统可读） | 可见根目录，逗号（或分号）分隔；`别名=/路径` 可起项目名 |
| `MCP_MAX_TEXT_CHARS` | `64000` | 单次返回给 AI 的字符上限 |
| `MCP_CALL_TIMEOUT_MS` | `60000` | 单次工具调用的时间预算，超了就停止扫描并提示 |
| `MCP_IGNORE_DIRS` | `node_modules,.git,.svn,.hg,vendor,.cache` | 遍历时跳过的目录名 |
| `MCP_AUDIT_LOG` | 空 | 审计日志路径（NDJSON），留空不写 |

### `MCP_ROOTS` 写法

**不配就是整个文件系统可读**（相当于 `MCP_ROOTS=/`）。每项默认取路径末段当项目名，也可以自己起别名：

```bash
# 不配（或写成 /）：整机可读，AI 可以直接 cat /var/log/nginx/access.log
MCP_ROOTS=

# 只放开部分目录：越界路径会被拦，报 E_OUTSIDE
MCP_ROOTS=/srv/app-a/logs,/srv/web-logs

# 起别名：AI 就能直接 ls project="app-a" path="today.log"
MCP_ROOTS=app-a=/srv/app-a,app-b=/srv/app-b,web=/srv/web-logs
```

别名和纯路径可以混用。别名不能跟别的根目录重名（重名会拒绝启动）。

> **全盘可读时，唯一的口子就是 `MCP_TOKEN`**：`path` 参数接受任意绝对路径，能读这台机器上 node 进程有权限读的**一切**文件（含 `/etc/shadow`、`.env`、私钥）。跳板机 + 内网隔离下这是你们的既定取舍，但请务必把 `MCP_TOKEN` 配上，并建议同时打开 `MCP_AUDIT_LOG`。

### 安全边界（`roots.js`）

1. `path` 是相对路径时，按项目名对应的根目录拼；绝对路径直接使用
2. 路径里出现 `..` 直接拒绝
3. 目标做 `realpath`（Windows 用 `realpath.native`，否则 8.3 短路径会误判）；**配了 `MCP_ROOTS` 时，真实路径必须落在某个根目录内**，符号链接跳出去也会被拦（不配就是全盘，不存在越界）
4. 文件不存在时改用父目录的 realpath 判定归属，报错更准

---

## 4. 跑起来

```bash
pnpm install                              # 或 npm install
cp .env.example .env                      # 至少改 MCP_TOKEN；MCP_ROOTS 留空就是全盘可读
node src/server.js
```

启动后：

- MCP 端点：`http://<host>:7801/mcp`
- 健康检查：`http://<host>:7801/healthz`（返回根目录清单、工具清单、是否可写）

### 自测与压测

```bash
pnpm test                     # 端到端：起真实服务 + 造真实日志 + 38 条断言
PERF_MB=300 pnpm perf         # 性能：造 300MB 日志实测 tail/grep/cat 耗时
```

### 用 supervisor 托管

部署目录按 `/opt/fs-readonly-mcp` 举例。配置文件在 [`deploy/supervisor.conf`](deploy/supervisor.conf)。

```bash
# 1. 放代码 + 装依赖（node_modules 直接 scp 过去也行，无原生模块）
cd /opt/fs-readonly-mcp && pnpm install --prod

# 2. 配置：cp .env.example .env，至少改 MCP_TOKEN
cp .env.example .env

# 3. 日志目录（放审计日志 + supervisor 的应用日志）
mkdir -p /var/log/fs-readonly-mcp
chown www:www /var/log/fs-readonly-mcp

# 4. 装 supervisor 配置
cp deploy/supervisor.conf /etc/supervisor/conf.d/fs-readonly-mcp.conf
# 按实际情况改这 3 行：directory / user / stdout_logfile
vi /etc/supervisor/conf.d/fs-readonly-mcp.conf

# 5. 生效并查看
supervisorctl reread
supervisorctl update
supervisorctl status fs-readonly-mcp
```

常用操作：

```bash
supervisorctl restart fs-readonly-mcp    # 改完 .env 要 restart 才生效
supervisorctl tail -f fs-readonly-mcp    # 跟启动日志和工具报错
curl -s http://127.0.0.1:7801/healthz    # 确认活着（healthz 不需要 token）
```

两个坑先说清：

1. **配置用环境变量还是 `.env`**：supervisor 的 `environment=` 里写 `MCP_TOKEN` 这类键名是可以的（服务直接读 `process.env`），但 `.env` 更集中。两者都配时**环境变量优先**。
2. **`/etc/supervisor/` 不接受非 ASCII**：`deploy/supervisor.conf` 是纯英文的，别在里面写中文注释，会报解析错误。

### 审计日志轮转

审计日志（每次调用一行 NDJSON）会持续增长，配 logrotate：

```bash
cp deploy/logrotate.conf /etc/logrotate.d/fs-readonly-mcp
# 里面 create ... www www 的属主要跟 supervisor.conf 里的 user 一致
logrotate -d /etc/logrotate.d/fs-readonly-mcp    # -d 只演练不真转
```

用 `copytruncate` 是因为服务持有文件句柄，而本服务无状态，重启也无副作用。

### 走 nginx 反代（可选）

客户端能直连 7801 就不需要这层。要加就用 [`deploy/nginx.conf.example`](deploy/nginx.conf.example)，关键一行是 `proxy_buffering off`——MCP 的 SSE 流式响应被 nginx 缓冲住，客户端会直接卡死：

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:7801;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;          # 关键
    proxy_cache off;
    proxy_read_timeout 300s;      # grep 大文件可能跑很久
}
```

---

## 5. 接入 AI 客户端

客户端配置里填 URL + Bearer Token，例如：

```json
{
  "mcpServers": {
    "fs-readonly": {
      "type": "http",
      "url": "http://<测试服务器>:7801/mcp",
      "headers": { "Authorization": "Bearer <你的 MCP_TOKEN>" }
    }
  }
}
```

注意：按 MCP 规范，客户端对 `POST /mcp` 的 `Accept` 头要同时包含 `application/json` 与 `text/event-stream`（官方 SDK 会校验这一条）。主流客户端默认就是这么发的。

---

## 6. 为什么不用现成的实现

参考过 [danielsuguimoto/readonly-filesystem-mcp](https://github.com/danielsuguimoto/readonly-filesystem-mcp)（官方 filesystem server 的变体），它的**结构**（zod 定义参数、`list_allowed_directories` 作为入口工具）沿用了，但实现有几处对「几个 G 的日志 + 内网 HTTP」不合适：

| 它的做法 | 问题 | 本服务的做法 |
| --- | --- | --- |
| `search_files` 只匹配文件/目录**名** | 完全搜不了日志内容，而排查日志 90% 是搜内容 | `grep` 逐行流式搜内容 |
| `read_file` 用 `fs.readFile` 整读 | 几个 G 的日志直接 OOM | `cat` 有 1MB 整读门槛 + 字节偏移分片 |
| 路径校验是 `startsWith` 前缀比较 | `/srv/logs-evil` 能骗过 `/srv/logs` | 带分隔符的包含判断 + `realpath` |
| 无输出上限、无时间预算 | 一次调用就能把 AI 上下文打爆 / 卡到超时 | 双上限 + 到点即停 + `[hint]` 收窄指引 |
| stdio 传输 | 只能本机进程调用，测试服务器要远程连 | Streamable HTTP + Bearer 鉴权 |

---

## 7. 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动报「MCP_ROOTS 是空的」 | 该行写了 `=` 但没填值；整行删掉即可（= 全盘可读） |
| 启动报「项目名重复」 | 两个根目录末段同名（如 `/srv/app-a/logs` 和 `/opt/app-a/logs`）；用 `别名=/绝对路径` 区分 |
| 启动打印「⚠ 未配置 MCP_TOKEN」 | **全盘可读 + 无鉴权 = 整台机器对任何能访问该端口的人开放**，必须配上 |
| 401 | 客户端没带 `Authorization: Bearer <token>`，或 token 不对 |
| `E_OUTSIDE` | 配了 `MCP_ROOTS`，而路径不在这些目录内（含符号链接跳到目录外） |
| `E_NOT_FOUND` + `[hint] 已尝试：...` | 相对路径在候选目录里没找到；hint 会列出试过哪些绝对路径，照着改 |
| 某个工具报 `E_PARAM` | 参数被 zod 拒绝，工具说明里每个参数都写了取值范围 |
| 结果里出现 `[TRUNCATED]` | 超过 `MCP_MAX_TEXT_CHARS`。改用 `offset`/`limit` 分片或加 `grep` 过滤，**不要**加大上限重试 |
| `grep` 说「已提前停止」 | 命中数 / 文件数 / 时间预算到顶。按 `[action]` 收窄目录、加 `glob`、把 pattern 写具体 |
| 审计日志想查谁读了什么 | 配 `MCP_AUDIT_LOG`，每行一条 NDJSON：`ts / session / tool / args / ok / ms / chars`；全盘可读时强烈建议开 |
