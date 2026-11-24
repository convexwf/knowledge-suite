# SQLite 存储布局与分片

## 文档信息

| 项目 | 内容 |
| --- | --- |
| **文档标题** | SQLite 存储布局与分片 |
| **文档版本** | v1.0 |
| **创建日期** | 2026-11-24 |
| **更新日期** | 2026-11-24 |
| **文档作者** | knowledge-suite contributors |
| **文档类型** | 架构说明 |
| **参考资料** | `docs/capture-pipeline.zh-CN.md`、`docs/semantic-search.zh-CN.md` |

## 目录

- [目标与范围](#目标与范围)
- [文件布局](#文件布局)
- [主库与检索库的职责](#主库与检索库的职责)
- [路由映射](#路由映射)
- [读写流程](#读写流程)
- [初始化与已有数据库](#初始化与已有数据库)
- [一致性与修复](#一致性与修复)

## 目标与范围

每个 `category` 使用一个主库保存 Reader 所需的小型权威数据，并使用多个检索库保存随文档正文增长的 chunks、FTS 和向量。检索库以 `itemId` 为路由键；同一条目的 chunks 和 embeddings 始终位于同一分片。

当前每个 category 初始化 10 个检索分片。分片数和文件编号不参与哈希运算；哈希范围与文件的映射由同目录的 `search-shards.json` 管理。

## 文件布局

数据库文件直接放在 category 目录中，不再使用 `index/categories/` 或额外的 search 子目录：

```text
<storeRoot>/index/
├── default/
│   ├── default.main.sqlite3
│   ├── default.search.000100.sqlite3
│   ├── default.search.000200.sqlite3
│   ├── ...
│   ├── default.search.001000.sqlite3
│   └── search-shards.json
└── bot/
    ├── bot.main.sqlite3
    ├── bot.search.000100.sqlite3
    ├── ...
    ├── bot.search.001000.sqlite3
    └── search-shards.json
```

原始抓取、Document JSON、Markdown、outline、批注文件和资源仍放在共享的内容目录中，例如 `rawdocs/`、`documents/`、`markdown/`、`outlines/`、`annotations/` 和 `assets/`。

## 主库与检索库的职责

`<category>.main.sqlite3` 保存条目与文档元数据、URL aliases、阅读进度、批注、合集和导入任务等 Reader 与写入流程需要的权威数据。这些表不按 item 水平分片。

每个 `<category>.search.<id>.sqlite3` 保存 `chunks`、`chunks_fts` 和 `chunk_embeddings`。这些表按 itemId 放在同一个文件中，避免 FTS 与向量查询跨数据库关联。`chunks` 还保存搜索结果所需的 `normalized_url`、`source_type` 和 `category`，搜索结果不需要逐条回查主库。

## 路由映射

服务对 `itemId` 计算 SHA-256，并取摘要前 64 位作为无符号哈希值。初始把完整的 64 位空间均分为 10 个连续、无重叠的闭区间，分别映射到分片 ID `000100` 至 `001000`。文件名采用 `<category>.search.<id>.sqlite3`，两个端点以固定宽度十六进制字符串写入 `search-shards.json`。

映射文件包含格式版本、哈希算法，以及每个分片的 `id`、`hashStart`、`hashEnd`。服务初始化某个 category 时读取并校验映射一次，然后缓存在内存中。文件 ID 是物理文件标识；路由只看哈希范围，既不查询主库，也不使用 `hash % 分片数`。

后续扩分时，切分某个过大的哈希范围，给新分片分配一个未使用的六位 ID，并更新该 category 的映射。itemId 的哈希值不变；只迁移被切分范围内的记录。编号 `000100`、`000200` 等是初始命名间隔，不限制哈希空间或分片总数。当前实现会初始化并读取这份范围映射，但还没有自动重分片工具；真正扩容前需要停写、迁移目标范围的数据、校验后再切换映射。

## 读写流程

Reader 列表、详情、批注和阅读进度访问 category 主库及内容文件。全文检索按 category 查询该类别的 10 个检索分片；指定 itemId 的写入、替换或删除只访问映射指向的那一片。

未指定 itemId 的搜索会扇出查询该 category 的检索分片，再合并结果。每个 FTS 数据库的 BM25 分数使用本地语料统计，因此跨片合并使用排名融合；Hybrid 模式再融合向量召回结果。

文档写入先提交主库事务，再更新对应检索分片；embedding 写入继续按模型和 part 保存。映射缓存与查询不会造成主库的额外读写。主库仍会处理 Reader 自身需要的访问，以及新增或更新条目时的正常权威数据写入。

## 初始化与已有数据库

新建 category 时，主库和检索库使用当前 schema 初始化；已有主库必须是 schema version 20。服务不会自动转换旧 schema，也不会把 `index/categories/<category>.sqlite3` 搬到新目录。旧路径文件会留在磁盘上，但当前版本不扫描、不打开、不删除它们。

检索分片映射缺失时，只有在目录里还没有该 category 的检索分片文件时，服务才会初始化新的空映射；若分片文件已经存在却没有映射，服务会报错，避免静默生成不完整的索引。已有 item 的 chunks、FTS 和向量应通过 `POST /api/search/reindex` 从当前 Document 重建；主库不承担该索引数据的兼容迁移。

## 一致性与修复

检索库是由 Document 和主库元数据派生的索引。主库事务与检索分片写入分属不同 SQLite 文件，不能作为一个 SQLite 事务提交；检索写入失败时，主库权威数据仍在，可用 `POST /api/search/reindex` 从 Document 重建 chunks、FTS 和待补向量。

运维统计把主库与该 category 的检索分片文件大小合并报告。分片缺失或映射范围无效时服务显式报错，不会静默创建空库并继续提供不完整搜索。
