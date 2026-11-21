# 小黑盒抓取链路

本文描述 `npm run capture` 如何在不经过大模型的情况下，把一个 URL 变成
Markdown 并写入 `knowledge-store`。

## 一句话

脚本把 URL 交给本地 server，server 通过常驻 WebSocket 让浏览器扩展开一个
后台标签，等页面渲染稳定后取回 DOM，再用现有 parser 转成 Markdown（含评论
区）入库。

## 组件

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 客户端 | `scripts/capture-ext.mjs` | 发请求、落盘、输出摘要 |
| 服务端 | `apps/knowledge-ingest-server`（Docker） | 鉴权、任务下发、解析、入库 |
| 扩展 | `apps/knowledge-capture-relay` | 白名单校验、开标签、等渲染、回传 DOM |
| 解析器 | `src/parser` + `xiaoheihe` / `reddit` adapter | 正文/标题/评论区提取 |

## 一次抓取的完整时序

```text
调用者
  | 1. npm run capture -- "<url>" --save
  v
scripts/capture-ext.mjs
  | 2. POST http://127.0.0.1:18765/api/capture  { url, save }
  v
knowledge-ingest-server  (Docker, 127.0.0.1:18765)
  | 3. 生成 taskId，经常驻 WebSocket /agent 推给扩展
  v
Knowledge Capture Relay  (MV3 扩展，运行在你的 Chrome 里)
  | 4. 校验 hostname 属于白名单
  | 5. chrome.tabs.create({ url, active: false }) 开后台标签
  | 6. 等标签 status=complete
  | 7. 每 500ms 读 body.innerText.length，连续 3 次相同视为稳定
  | 8. sendMessage 给 content script，取 outerHTML + innerText + title + canonical
  | 9. 关闭标签
  v
knowledge-ingest-server
  | 10. 复用 /api/ingest/save 的逻辑：
  |     resolveKnowledgeCaptureInput -> parsePage -> adapter -> documentToMarkdown
  | 11. 写入 knowledge-store（rawdoc / html / markdown / outline）
  v
scripts/capture-ext.mjs
  | 12. 写 tmp/captures/<timestamp>/{save|preview}.json + page.md + meta.json
  v
stdout：一行摘要（--quiet）或 JSON summary
```

## 在 Codex 里怎么用

模型只做两件事：

1. 拿到 URL 后执行一条命令。
2. 读一行 stdout 判断成功与否。

模型不接触 428KB 的 DOM，也不参与正文提取。解析规则在 adapter 里，是确定性代码。

```powershell
# 入库
npm run capture -- "https://www.xiaoheihe.cn/app/bbs/link/196383163" --save

# 只看结果，不写库
npm run capture -- "<url>"

# 压缩输出到一行
npm run capture -- "<url>" --save --quiet
```

## Category

每个已注册的 `category` 对应独立 SQLite 文件：`<storeRoot>/index/categories/<category>.sqlite3`。原始抓取、解析文档和资源仍保存在共享的 `rawdocs/`、`documents/`、`outlines/`、`markdown/` 与 `assets/` 目录。category 必须先在服务端 `KNOWLEDGE_CATEGORIES` 配置中注册；默认配置为 `default,bot`，其中 `default` 必须保留。服务启动时会检查注册表和已有数据库。

请求未传 category 时只访问 `default` 数据库。category 在条目创建时确定，后续请求不能把条目移到其他 category；同一条目不能重复存入另一类。传入未注册的值会被 API 拒绝。`GET /api/categories` 返回当前注册表，Clipper Saved Items 页默认显示 `default`，可从列表右上角切换到一个已注册 category。

```dotenv
KNOWLEDGE_CATEGORIES=default,bot,research
```

```powershell
npm run capture -- "<url>" --save --category bot
```

- `POST /api/capture`、`POST /api/ingest/save` 和导入接口可通过已注册的 `category` 指定目标数据库；未指定时写入 `default`。
- `GET /api/items?category=bot&tag=...`、`GET /api/search?category=bot` 和 `GET /api/tags?category=bot` 只读取 `bot` 数据库。
- 不传 category 的列表或搜索只访问 `default`；Clipper Saved Items 页一次只显示一个 category，不提供跨分类合集。
- 旧版 `<storeRoot>/index.sqlite3` 会在首次启动时按条目 category 拆分到独立数据库，原库保留为 `index.sqlite3.pre-category-split`。若旧合集成员横跨多个 category，迁移会停止并报告合集 ID；先在旧库中拆分成员后再启动。

## 列表页 discover（不读正文）

`POST /api/capture` 传 `mode: "links"` 时只回传页面上的链接，不解析正文。

- `/app/bbs/home`：首页本身只有 10 张推荐卡。扩展会依次点开前几个分类按钮
  （Steam、影之刃零……），从 `/app/topic/link/<id>` 各取约 18 条，再 `history.back()`
  回首页，合并去重，直到 32 条帖子链接或试过 4 个分类。
- `/app/user/favour/`：向下滚动，每轮滚 0.9 屏、等 1.1 秒，直到约 35 条帖子链接、
  连续两轮没有新增、或滚满 12 轮；结束后把页面滚回原位。

两类页面都按 URL 累积去重，所以列表虚拟化把旧卡片移出 DOM 也不会丢。

```powershell
$body = @{
  url   = "https://www.xiaoheihe.cn/app/bbs/home"
  mode  = "links"
  scope = @{ pathPrefix = "/app/bbs/link/"; maxItems = 120 }
} | ConvertTo-Json -Depth 4
Invoke-RestMethod -Uri "http://127.0.0.1:18765/api/capture" -Method Post `
  -Headers @{ Authorization = "Bearer $env:KNOWLEDGE_TOKEN" } `
  -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

注意：`scope.maxItems` 统计的是全部同源链接（含作者主页、导航等），所以上限要设大，
再用 `selectedByDefault` 过滤出 `/app/bbs/link/`，调用方自己取前 30 条。

正文页不滚动；列表页滚动只影响 discover，不影响正文抓取。

## 采集 CDP 已准备好的标签页

调用方可以先用 CDP 在 Relay 所连接的同一个 Chrome 中打开帖子、检查页面并按需展开评论，再将 Chrome 数字标签 ID 传给 `POST /api/capture`。Relay 会直接快照该标签的当前 DOM，交给 Suite 解析；不会再次导航、切换前台或关闭这个标签。CDP 与 Relay 必须连接同一个 Chrome 实例和用户配置，才能共享页面与登录态。

```powershell
$body = @{
  url   = "https://www.xiaoheihe.cn/app/bbs/link/196383163"
  mode  = "document"
  tabId = 123
  waitMs = 500
  save  = $false
} | ConvertTo-Json -Depth 4
Invoke-RestMethod -Uri "http://127.0.0.1:18765/api/capture" -Method Post `
  -Headers @{ Authorization = "Bearer $env:KNOWLEDGE_TOKEN" } `
  -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

`tabId` 是 Chrome `tabs` API 使用的正整数标签 ID，不是 CDP target ID。Relay 会确认标签仍位于白名单 HTTPS 主机，且路径与请求 URL 一致；不匹配时拒绝快照。复用现有标签只支持 `mode: "document"`，因为链接发现会点击分类并改变页面导航。目标页正常情况下使用 `manifest.json` 声明的静态 `content.js`；若扩展重载前已打开的页面没有接收端，Relay 才按需注入一次。该模式不会刷新、导航或关闭标签，`keepOpen` 不改变这一点。登录身份检查和正文/评论加载判断由 CDP 调用方在交接前完成。

## Token 消耗

| 场景 | 估算 |
| --- | --- |
| `--quiet` 一行摘要 | 20–40 tokens |
| 默认 JSON summary | 150–200 tokens |
| 模型额外读一遍 `page.md` | 2–3k tokens |
| 只执行命令、不看输出 | 0 tokens（不进入上下文） |
| 旧 CDP 方案（读 428KB DOM） | 约 110k tokens |

结论：如果目标是"入库"，`--quiet` 足够，单次成本在几十 token 量级。

## 延时

实测（Chrome 已启动、网络正常）：

| 场景 | 典型耗时 |
| --- | --- |
| 单篇正文（含评论） | 3.7–4.4 秒 |
| 收藏页 discover | 7–8 秒（约 27–30 条） |
| 首页 discover | 15–17 秒（10 张推荐卡 + 2–3 个分类页，约 49–50 条） |

| 阶段 | 典型耗时 |
| --- | --- |
| 扩大标签 + 页面加载 | 1.5–2.5s |
| 稳定检测（3 × 500ms） | ≥1.5s |
| DOM 回传 + 解析 + Markdown | 0.5–1s |
| 首页分类页往返（每个） | 约 4–5s |

早期试过 CDP 方案：它要等 `networkidle`（最多 10s）再等 settle（最多 8s），
实测 12–24 秒；而且 Chrome 对每个新的 DevTools 连接都要用户确认，无法无人值守。
该实现已移除。扩展方案不等 `networkidle`，所以快一个数量级。

## 安全性

- 不走 CDP：不需要 9222，也不需要 `DevToolsActivePort`。那层"允许远程调试"可以关掉，攻击面更小。
- 扩展权限只有 `alarms`、`scripting`、`storage`、`tabs`；`host_permissions` 只有两个小黑盒域和 `127.0.0.1`。
- 不读取、不导出、不注入 cookie；页面使用你当前 Chrome 已有的登录态。
- 数据只在本机流转：脚本 -> `127.0.0.1:18765` -> 扩展。没有外部服务。
- 白名单在扩展侧强制：即使直接调用 `/api/capture` 传别的域名，扩展也会拒绝。
- 落盘内容：`tmp/captures/<ts>/` 保存原始 DOM（约 428KB），`knowledge-store` 保存 rawdoc（约 438KB）和 Markdown。
- 验证码/风控页不会被重试；命中时返回 422，脚本退出码 2。

残留风险，按重要性排序：

1. `KNOWLEDGE_TOKEN` 默认是 `dev-token`，且 WebSocket 的 token 在 query string 里，Fastify 访问日志会记录该 URL。仅本机回环可访问，但生产环境应设置强 token。
2. 扩展权限含 `tabs`，理论上能读标签页 URL；当前代码只对白名单域注入脚本。
3. 后台标签会执行小黑盒自己的 JS，行为和正常浏览一致。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 参数、网络或解析错误 |
| 2 | 命中验证码/风控（HTTP 422） |
| 3 | 扩展未连接（HTTP 503），检查 `chrome://extensions` |

## 已知限制

- 评论区只取页面已渲染的部分（约 17–18 条顶级评论、25–26 条回复），正文页没有滚动加载。
- 稳定判定是"文本长度连续 3 次不变"，偶尔会早 0.1–1 秒，可能少 1 条评论。
- 目前支持小黑盒和 Reddit。新增站点需要同时改扩展的 `host_permissions`、`content_scripts.matches` 和 `background.js` 里的 `ALLOWED_HOSTS`。
- 扩展是开发者模式加载的。Chrome 大版本更新后可能被停用，在 `chrome://extensions` 重新启用即可。
