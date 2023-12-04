# Feishu Wiki Crawler

从飞书知识库（Wiki）批量提取文档内容，保存为 Markdown，并下载所有图片。

## 前置条件

1. Node.js >= 18
2. Chrome 浏览器（已登录飞书）
3. Playwright（脚本会自动用 npx 解决）

```bash
npx playwright install chromium
```

## 启动 Chrome（每次使用前）

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-feishu-debug

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir=C:\tmp\chrome-feishu-debug
```

Chrome 会打开新窗口，**只登录飞书一次**，之后 cookie 保留在 `/tmp/chrome-feishu-debug`，下次直接用。

## 用法

```bash
cd knowledge-suite

# 爬取单个页面（及其子页面）
npx tsx scripts/feishu/crawl.ts <飞书wiki页面URL> --connect

# 例如
npx tsx scripts/feishu/crawl.ts \
  https://my.feishu.cn/wiki/LpLOwZnp7iqFKakLn35ctFZ7nfs \
  --connect
```

### 选项

| 选项 | 说明 |
|------|------|
| `--connect` | 连接到本机 Chrome（必须） |
| `--out <dir>` | 指定输出目录（默认：`knowledge-store/wiki-export/`） |

## 输出结构

```
knowledge-store/wiki-export/{wiki_token}/
├── 章节目录.md              ← 目录页面自己的内容
├── _index_.md                ← 完整目录索引（含嵌套）
├── assets/                   ← 所有图片
│   ├── a1b2c3d4e5f67890.png
│   └── ...
└── 章节目录/                  ← 子页面目录
    ├── _index_.md
    ├── 子页面1.md
    ├── 子页面2.md
    └── ...
```

## 文件说明

| 文件 | 作用 |
|------|------|
| `crawl.ts` | 主脚本：爬取、提取、下载图片、生成 markdown |
| `feishu-extract.js` | 浏览器端提取逻辑：遍历飞书块树 → sections → 下载图片 |

## 工作原理

1. **BFS 爬取**：从给定 URL 开始，边爬页面边从 `tree/get_info` API 发现子节点，推入队列
2. **块树提取**：`page.evaluate` 在浏览器主世界遍历 `window.PageMain.blockManager.rootBlockModel`，将飞书文档块（heading、text、code、table、image 等）转成 sections
3. **图片下载**：通过 block 上的 `imageManager.fetch()` 获取真实可访问的下载 URL，用 XHR 下载 blob，转 base64 写盘。文件名用内容哈希（16 位小写 hex）
4. **断点续爬**：如果 markdown 文件已存在，跳过该页面，只遍历子节点
5. **目录索引**：每个目录生成 `_index_.md`，展示完整的嵌套结构和排序

## 依赖

- `playwright`（浏览器自动化）
- `node:fs`、`node:path`、`node:url`（Node 内置）
- `feishu-extract.js`（被 `crawl.ts` 通过 `fs.readFileSync` 加载）

不依赖 knowledge-suite 的任何其他模块，可独立使用。
