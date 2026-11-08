# 语义检索与混合检索

本文描述 knowledge-suite 的向量检索实现、开关、成本和云上取舍。

## 模式

`KNOWLEDGE_SEARCH` 控制检索索引：

| 模式 | chunks | FTS5 | 向量 | 适用 |
| --- | --- | --- | --- | --- |
| `off` | 不写 | 不写 | 不写 | 云端纯存储 |
| `fts` | 写 | 写 | 不写 | 默认；本地/云端都可 |
| `hybrid` | 写 | 写 | 写 | 需要 Ollama，本地优先 |

`hybrid` 但没配 `KNOWLEDGE_EMBEDDINGS=ollama` 时，服务端记一条警告并自动退回 `fts`。

## 向量契约

与 dsh 记忆层保持一致：

- 模型 `bge-m3`，1024 维，L2 归一化后存 float32 BLOB。
- 每个 chunk 按 420 字切成多个 part；每个 part 都带 `Title:` / `Source:` / `Section:` 前缀。
- 一行一个 part：`chunk_embeddings(chunk_id, model, part, dim, normalized, chunk_hash, vector, ...)`。
- 换模型不删旧向量，按 `model` 并存；`chunk_hash` 用于判断是否需要重算。
- 直连 Ollama `POST /api/embed`，批量发送，不经过 suite 中转。

## 写入链路

```text
save / import / reparse
  -> 事务内写 chunks + chunks_fts
  -> COMMIT
  -> 异步等待 embedAndStore()
  -> Ollama /api/embed（batch=16 chunks，内部再按 part 展开）
  -> chunk_embeddings
```

Ollama 不可用时只跳过向量，chunks/FTS 已落库，归档不被阻塞；待下次启动或重索引补。

## 查询链路

```text
query
  -> FTS top-N（N = max(limit*4, 40)，上限 200）
  -> 向量全表召回 top-N（cosine >= 0.2）
  -> RRF(k=60) 合并排名
  -> top-limit
```

- 只用排名，不把 BM25 和 cosine 加权相加。
- 1–2 字中文查询仍走 `LIKE` 回退。
- 向量侧失败（Ollama 掉线、超时）时自动降级为纯 FTS，不返回 500。
- `GET /api/search` 的 `retriever` 会返回 `sqlite_fts` 或 `hybrid`。

## 运维

```powershell
# 重建 chunks + FTS + 待补向量
npm run search:reindex

# HTTP（容器运行中也可执行）
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:18765/api/search/reindex" -Headers @{ Authorization = "Bearer dev-token" }
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:18765/api/embeddings/reindex?force=true" -Headers @{ Authorization = "Bearer dev-token" }

# 查看索引状态
Invoke-RestMethod -Uri "http://127.0.0.1:18765/api/embeddings/stats" -Headers @{ Authorization = "Bearer dev-token" }
```

`/api/health` 会返回当前 `search` 模式与 `embeddings.provider/model/dim`。

## 成本与延时

- 建索引：一次性把全部 chunk/part embed 一遍；本地 4070 Ti Super + bge-m3 通常几十秒，纯 CPU 约 1–3 分钟（按 800 chunks 估）。
- 查询：一次 query embed（本地几十到几百毫秒）+ 内存 cosine；不消耗 LLM token。
- 存储：1024 维 float32 约 4 KB/向量；10 万 chunk × 多 part 约数百 MB，届时考虑 `sqlite-vec` 或 int8。
- 两步检索比“全量语义检索”便宜：FTS 先缩小候选，向量只做召回/重排；本实现仍做全表向量召回以保召回率，数据量大后再切候选内重排。

## 云上建议

- 云上不装 Ollama：`KNOWLEDGE_SEARCH=off` 或 `fts`，`KNOWLEDGE_EMBEDDINGS=none`。
- 只存内容：`off`；owner/tag 过滤仍然可用。
- 若云上也要语义检索，必须外接 embedding 服务；当前实现只支持 Ollama。
