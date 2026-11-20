# 结构化导入（structured import）

`POST /api/import/structured` 让外部抓取工具把已经整理好的正文、评论、媒体和元数据
直接写进 Knowledge Store。Knowledge Suite 不依赖任何具体抓取器；catbus、Reddit JSON
转换器或自建脚本都只是这个接口的调用方。

## 适用场景

- 平台已经有稳定的结构化 API 或 CLI（例如 catbus 的 X 支持）。
- 抓取端已经处理了登录、评论树和媒体 URL，不想再让 suite 解析 HTML。
- 需要复用 suite 的 Markdown、SQLite/FTS、hybrid 检索和 reader。

不适合：

- 页面需要浏览器登录态或反爬对抗时，优先走 `capture-pipeline.zh-CN.md` 里的扩展通道。
- 只需要保存一个 Markdown 文件时，用 `/api/import/markdown` 更简单。

## 请求

```http
POST /api/import/structured
Authorization: Bearer <KNOWLEDGE_TOKEN>
Content-Type: application/json
```

```json
{
  "provider": "catbus",
  "platform": "x",
  "itemId": "1234567890",
  "url": "https://x.com/i/status/1234567890",
  "canonicalUrl": "https://x.com/alice/status/1234567890",
  "title": "Agent memory notes",
  "authors": ["Alice"],
  "publishedAt": "2026-11-08T12:00:00+08:00",
  "language": "en",
  "tags": ["AI"],
  "owner": "xiaojing",
  "markdown": "Long-term memory should be explicit.",
  "comments": [
    {
      "id": "c1",
      "author": "Bob",
      "text": "Start with a simple notes file.",
      "createdAt": "2026-11-08T12:30:00+08:00",
      "likes": 12,
      "replies": [
        { "author": "Carol", "text": "And review it weekly.", "likes": 2 }
      ]
    }
  ],
  "media": [
    { "type": "image", "url": "https://example.com/diagram.jpg", "alt": "diagram" }
  ],
  "metadata": { "stats": { "views": 1000, "likes": 50 } },
  "commentsMode": "append",
  "overwrite": true
}
```

### 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `provider` | 是 | 产生内容的工具，例如 `catbus` |
| `platform` | 是 | 平台标识，例如 `x`、`reddit` |
| `itemId` | 是 | 平台内 ID，只写入 metadata，不参与身份计算 |
| `url` | 是 | 原始链接 |
| `canonicalUrl` | 否 | 规范链接；缺省时使用 `url`，身份和别名都基于它 |
| `title` | 是 | 标题；Markdown 里重复的 H1 会被去掉 |
| `markdown` | 是 | 正文，不要带 frontmatter；标题由 `title` 提供 |
| `authors` | 否 | 作者列表 |
| `publishedAt` | 否 | 发布时间，原样保存 |
| `language` | 否 | 语言标签 |
| `tags` | 否 | 额外标签；自动追加 `platform:<platform>` |
| `owner` | 否 | 归属人；缺省沿用已存在条目或 `master` |
| `comments` | 否 | 评论数组，最多 100 条；每条最多 10 条回复 |
| `media` | 否 | 媒体数组，只保存远程 URL，不下载 |
| `metadata` | 否 | 任意附加数据；`stats` 会提升到 `rawdoc.metadata.stats` |
| `commentsMode` | 否 | `append`（默认）或 `none` |
| `overwrite` | 否 | 默认 `true`；`false` 且条目已存在时返回 409 |

## 行为

### 身份与去重

- `itemId = "url:sha256:" + sha256(normalize(canonicalUrl))`，与网页抓取保持一致。
- 同时建立 `normalized_url`、`canonical_url` 和 `original_url` 别名。
- 同一 canonical URL 重复导入时更新同一条 item，并清理旧的 document/rawdoc 版本。
- `overwrite: false` 时，已存在条目直接返回：

```json
{ "error": "item_exists", "itemId": "url:sha256:..." }
```

### Markdown 渲染

正文之后按顺序追加：

1. `## 媒体`：图片用 `![alt](url)`，其他类型用链接列表。
2. `## 评论`（`commentsMode=append`）：

```markdown
## 评论

### Bob · 2026-11-08 · 12 赞

Start with a simple notes file.

> **Carol · 2026-11-08 · 2 赞**
>
> And review it weekly.
```

- 日期只保留 `YYYY-MM-DD`。
- 评论正文里行首的 `#` 和 `>` 会被转义，避免破坏文档结构。

### 存储映射

| 位置 | 值 |
| --- | --- |
| `rawdoc.source_type` | `markdown` |
| `rawdoc.source_uri` | `canonicalUrl` |
| `rawdoc.metadata.provider/platform/platformItemId` | 请求值 |
| `rawdoc.metadata.importMode` | `structured` |
| `rawdocs.input_mode` | `structured_import` |
| `documents.source_url` | `canonicalUrl` |
| `documents.published_at` | `publishedAt` |

## 响应

与 `/api/import/markdown` 相同：

```json
{
  "knowledgeItem": {},
  "rawdoc": {},
  "document": {},
  "markdown": "---\ntitle: ...\n---\n\n# ...",
  "saved": true,
  "paths": {
    "rawContentPath": "rawdocs/<id>.md",
    "rawdocPath": "...",
    "documentPath": "...",
    "markdownPath": "..."
  },
  "warnings": []
}
```

## 调用方约定

- 抓取器自己负责登录、限流和重试；suite 不代管平台凭证。
- 抓取器不要把 Markdown 当数据库：只传正文和结构化评论，frontmatter 由 suite 生成。
- 写操作（点赞、收藏、发布、关注）不属于导入链路，抓取器即使支持也不要调用。
- catbus 0.3.0 没有 Reddit 平台；Reddit 走扩展通道或 Reddit JSON 转换器，不要伪装成
  `catbus reddit`。

## 最小调用示例

```powershell
$payload = @{
  provider = "catbus"
  platform = "x"
  itemId   = "1234567890"
  url      = "https://x.com/alice/status/1234567890"
  title    = "Agent memory notes"
  markdown = "Long-term memory should be explicit."
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Uri "http://127.0.0.1:18765/api/import/structured" -Method Post `
  -Headers @{ Authorization = "Bearer $env:KNOWLEDGE_TOKEN" } `
  -ContentType "application/json; charset=utf-8" `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
```
