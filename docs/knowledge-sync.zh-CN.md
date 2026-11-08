# Knowledge Store 单向同步

本文描述 suite server 内建的云端到本地同步。它把远端的 `knowledge-store`
内容拉到本地，不依赖单独的同步进程，也不要求浏览器或 reader 客户端参与。

## 目标与边界

- 方向：远端（例如 vps-main）→ 本地，单向拉取。
- 调度：每天本地时间 `19:00` 运行一次；如果上一轮仍在运行，本轮跳过。
- 错过不补：服务在 19:00 未运行或已经错过时，不会在启动后补跑，只安排下一次。
- 删除不传播：远端删除 item 后，本地保留已有 item、文件和标注，不做删除记账。
- 云端不启用：vps 上不配置 `KNOWLEDGE_SYNC_*`，只作为只读源站。
- 不改现有包接口：`/api/sync/catalog` 和 `/api/items/:itemId/package` 的契约保持不变。
- 不新增数据库表，不改 `user_version`。增量判断复用现有 item 指纹。

## 同步内容

| 数据 | 处理方式 |
| --- | --- |
| item 行 | 同步 owner、标题、来源、tags、语言、状态、创建/更新/解析时间 |
| `document.json` | 从离线包导入 |
| `markdown.md` | 从离线包导入 |
| `outline.json` | 保留源站字节，保证内容指纹一致 |
| `assets/**` | 从离线包复制到本地 store |
| rawdoc 原文件 | 通过 rawdoc 接口下载，保留扩展名、content-type 和长度 |
| rawdoc JSON | 保留远端元数据，供 reparse 使用 |
| 标注 | 按 `annotation_id` 合并；同 id 时本地更新时间更晚则保留本地 |
| 阅读进度 | 新者胜：比较 `updatedAt`，相同时间再比较 `revision` |
| 合集 | 同步合集标题、root URL 和成员快照 |
| 合集成员 | 保留顺序、层级、父成员、inclusion mode/reason/source rule |
| chunks / FTS / embeddings | 不传输，由本地导入后按自己的搜索配置重建 |

合集成员按快照替换：本轮远端返回什么，就写什么。指向尚不存在 item 的成员会跳过，
并在本轮错误列表中记录数量；下次补齐 item 后会重新同步。

## 增量判断

`items.content_hash` 保存的是核心包哈希（`document.json` + `markdown.md` +
`assets/**`）。本地再和 `outline.json` 计算一次
`readerPackageContentHash(coreHash, outlineBytes)`，得到与
`/api/sync/catalog` 中 `contentHash` 完全相同的值。

- 值相同：不下载离线包。
- 值不同或本地不存在：下载完整离线包。
- 元数据每轮都会校准，因此只改 tags、owner、标注或阅读进度时不需要重新下载包。

导入后会再次计算本地指纹。若与远端 catalog 不一致，该 item 记为本轮失败，不会静默
写入一个错误版本。

## 新增接口

以下接口都使用现有 Bearer token 鉴权。

### 源站只读接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/sync/catalog` | 现有目录快照，返回 item 指纹 |
| `GET` | `/api/items/:itemId/package` | 现有离线包下载 |
| `GET` | `/api/sync/items/:itemId/meta` | item 行、documentId、rawdoc JSON、标注、阅读进度、合集 id |
| `GET` | `/api/sync/items/:itemId/rawdoc` | rawdoc 原始字节；返回 `x-content-ext` 和 `x-content-type` |
| `GET` | `/api/sync/collections` | 全部合集摘要和完整成员快照 |

### 本地控制面

仅在本地配置了源站 URL 和令牌时注册：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/sync/run` | 立即跑一轮并返回摘要；已有任务时返回 `409 sync_in_progress` |
| `GET` | `/api/sync/status` | 当前是否运行，以及上一轮摘要 |

摘要包含 `packagesUpdated`、`packagesUnchanged`、`annotations`、
`readingProgress`、`collections`、`collectionMembers`、`failedItems` 和
`errors`。错误按 item 隔离，单条失败不会中断整轮。

## 配置

只在本地接收端设置：

```dotenv
KNOWLEDGE_SYNC_SOURCE_URL=http://<source-host>:18765
KNOWLEDGE_SYNC_SOURCE_TOKEN=<source-bearer-token>
KNOWLEDGE_SYNC_AT=19:00
KNOWLEDGE_SYNC_TIMEOUT_MS=300000
TZ=Asia/Shanghai
```

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KNOWLEDGE_SYNC_SOURCE_URL` | 未设置 | 源站基础 URL；不设置则关闭同步 |
| `KNOWLEDGE_SYNC_SOURCE_TOKEN` | 未设置 | 源站 Bearer token；与 URL 必须同时存在 |
| `KNOWLEDGE_SYNC_AT` | `19:00` | 每天运行时间，使用容器本地时区 |
| `KNOWLEDGE_SYNC_TIMEOUT_MS` | `300000` | 单个同步请求（含包下载）的超时；跨境链路建议不小于 5 分钟 |
| `TZ` | `Asia/Shanghai` | Docker Compose 默认时区；`KNOWLEDGE_SYNC_AT` 按它解释 |

云端源站不要配置这些变量。源站的 `KNOWLEDGE_SEARCH` 可以保持 `fts` 或 `off`，
本地可以独立使用 `hybrid`；embeddings 会在本地重新生成。

## 运维

手动跑一轮（不打印 token）：

```powershell
$headers = @{ Authorization = "Bearer $env:KNOWLEDGE_TOKEN" }
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:18765/api/sync/run" -Headers $headers
Invoke-RestMethod -Method Get  -Uri "http://127.0.0.1:18765/api/sync/status" -Headers $headers
```

首次同步会下载全部已解析 item。建议先在本地空 store 或备份后的 store 上跑一轮，
核对 `catalogItems`、`packagesUpdated`、`failedItems`，再让每日调度接管。

排查顺序：

1. `/api/health` 确认本地服务正常。
2. `/api/sync/status` 查看上一轮错误。
3. 错误集中在 `catalog`：检查网络、URL、token 和源站防火墙。
4. 错误集中在 `package`：检查源站包接口和 rawdoc 接口是否可用。
5. 搜索异常：在本地执行 `npm run search:reindex` 重建派生索引。

## 安全

- 源站接口与现有 API 使用同一个 Bearer token；不要写入仓库、日志或文档。
- 尽量只允许本地/VPN 地址访问源站，不要为了同步把 18765 全公网开放。
- 同步不会传播远端删除，也不会同步 reader 的本地删除操作。
- 阅读进度冲突只影响进度字段，不修改 item 的 `updated_at`。

## 验证

仓库内回归覆盖：

- `src/unzip.test.ts`：ZIP 读写与截断保护。
- `src/sync/store.test.ts`：阅读进度新者胜，且不改 item 时间戳。
- `src/sync/runner.test.ts`：源站到本地完整同步、owner/tags、rawdoc、标注、进度、合集和二次增量跳过。

交付前按 `AGENTS.md` 执行 `make check`、`make test` 和 `make rebuild`。
