# 飞书/Lark Wiki 内容提取指南

## 概述

飞书/Lark 是重度 SPA 应用，页面内容在内存中以块树（block tree）形式存在，只有第一屏通过 SSR 渲染到 HTML。要提取完整文档内容，必须访问 `window.PageMain.blockManager.rootBlockModel`。

本文档记录了从零到完整提取的全部踩坑经验。

## 核心原理

### 块树结构

飞书文档在内存中是一个递归的块树：

```
window.PageMain.blockManager.rootBlockModel (PageBlock: "page")
  ├── zoneState.content.ops: [{ insert: "标题文本" }]  ← 页面标题
  └── children: [
      ├── HeadingBlock ("heading1") { zoneState.content.ops, children: [TextBlock] }
      ├── TextBlock ("text") { zoneState.content.ops }
      ├── CodeBlock ("code") { zoneState.allText, language }
      ├── BulletBlock ("bullet") { zoneState.content.ops, children: [子块] }
      ├── OrderedBlock ("ordered") { zoneState.content.ops, snapshot.seq }
      ├── ImageBlock ("image") { snapshot.image.token, snapshot.image.name, imageManager.fetch }
      ├── TableBlock ("table") { snapshot.rows_id, snapshot.columns_id, snapshot.column_set, snapshot.cell_set, children: [TableCellBlock] }
      ├── QuoteContainerBlock ("quote_container") { children: [TextBlock...] }
      ├── Grid ("grid") { children: [GridColumn { children: [ImageBlock, TextBlock...] }] }
      ├── DividerBlock ("divider")
      └── ...
    ]
```

关键属性：
- **zoneState.content.ops**：类 Quill Delta 格式的文本操作列表，每个 op 包含 `insert`（文本）和 `attributes`（加粗/斜体/链接/颜色等格式信息）
- **zoneState.allText**：纯文本（用于 code block）
- **snapshot.type**：block 的实际类型，值为 `"pending"` 表示内容尚未加载
- **imageManager.fetch()**：图片 block 上的方法，返回带认证签名的可访问下载 URL

### 懒加载机制

飞书通过滚动 `#mainBox .bear-web-x-container` 触发内容的异步加载。页面刚打开时，大部分 block 的 `snapshot.type === "pending"`，需要滚动到可见区域后，飞书才会从服务器拉取内容并将 block 状态更新为实际类型。

## 已踩的坑

### 1. Content Script 世界隔离

**问题**：Chrome extension 的 content script 默认在 ISOLATED world 运行，无法访问页面 JS 在主世界设置的 `window.PageMain`。

**尝试的方案**：
- 直接在 content.ts 里读 `window.PageMain` → 永远是 `undefined`
- 在 manifest.json 加 `"world": "MAIN"` → 部分 Chrome 版本不生效

**最终方案**：
- 使用 `chrome.scripting.executeScript({ files: [...], world: "MAIN" })` 注入脚本到主世界
- 或者用 Playwright 的 `page.evaluate()`（Playwright 默认在主世界执行）

### 2. CSP 阻止内联 script

**问题**：飞书的 Content Security Policy 不允许 `unsafe-inline`，直接注入 `<script>textContent</script>` 会被拦截。

**错误信息**：`Executing inline script violates the following Content Security Policy directive 'script-src ...'`

**最终方案**：不要内联 JavaScript，使用：
- Chrome extension：`chrome.scripting.executeScript({ files: [...] })`
- Playwright：`page.evaluate(fn)` 或 `page.evaluate(string)`

### 3. esbuild/tsx 编译 template literal

**问题**：使用 `npx tsx` 运行时，esbuild 可能转换模板字符串的内容。将大段 JavaScript 代码放在模板字符串中不可靠。

**症状**：代码在单独测试时有效，但放在 .ts 文件的模板字符串中运行时报 `SyntaxError: Unexpected token 'return'`。

**最终方案**：把提取代码放在独立的 `.js` 文件中，用 `readFileSync()` 读取。esbuild 不会处理独立文件。

示例：
```typescript
const FEISHU_EXTRACT = readFileSync(resolve(__dirname, "feishu-extract.js"), "utf-8");
```

### 4. Content Script 适配器的 extractSections 不处理 div 结构

**问题**：knowledge-suite 服务端的 `extractSections()` 函数使用 `h1,h2,h3,h4,h5,h6,p,pre,blockquote,ul,ol,figure,table,img,div` 作为 section 节点选择器，但遇到 `<div>` 时直接 `continue` 跳过。飞书的文本内容都在 `<div class="block docx-text-block">` 体系中，完全不受支持。

**症状**：适配器选对了 content selector（如 `.page-main .editor-container`），但提取结果只有 title 和 figure，没有正文。

**最终方案**：不走 HTML 解析路径，直接遍历 `window.PageMain.blockManager.rootBlockModel` 块树生成 sections。

### 5. CSS Selector 与 Defuddle Root Hints 的优先级问题

**问题**：适配器的 `content.selectors` 和 `hints.defuddleRootSelectors` 顺序影响内容提取效果。如果把窄的选择器（如 `.page-block-children`，452 字符）放在第一位，defuddle 只能看到这部分内容，丢失标题和元数据。

**经验**：defuddleRootSelectors 应该从宽到窄排列，让 defuddle 看到尽量多的内容。

### 6. 图片下载——六个失败方案

#### 方案 A：fetch() from page.evaluate（失败）

```javascript
const resp = await fetch(imgUrl, { credentials: "include" });
```

失败原因：`internal-api.feishu.cn` 和 `internal-api-drive-stream.feishu.cn` 不返回 CORS 头，`fetch` 跨域被拒绝。

#### 方案 B：page.context().request.get()（失败）

```javascript
const resp = await page.context().request.get(imgUrl);
```

失败原因：APIRequestContext 的 cookie 状态和页面不完全同步，大部分请求被拒绝。

#### 方案 C：Playwright response 拦截（失败）

```javascript
page.on("response", async (resp) => {
  if (resp.url().includes("/cover/")) await resp.body(); // 保存
});
```

失败原因：
- 浏览器缓存：同一张图片在多个页面间不重新请求
- 滚动加载图片时页面已经打开了，需要事先注册拦截器

#### 方案 D：canvas 截图（失败）

```javascript
const canvas = document.createElement("canvas");
ctx.drawImage(img, 0, 0);
canvas.toDataURL();
```

失败原因：canvas 被 cross-origin 图片污染（tainted），`toDataURL()` 抛出 SecurityError。

#### 方案 E：XHR 下载（失败）

```javascript
xhr.open("GET", "https://internal-api.feishu.cn/open-apis/drive/v1/medias/{token}/download");
```

失败原因：该 API 端点需要特定认证，XHR 直接调用返回 403 或空响应。

#### 方案 F：取 DOM img src 再 XHR（失败）

从页面 `<img>` 标签获取 src 后再用 XHR 下载。

失败原因：DOM img src 里的 URL 包含时效性认证参数，过期后无法访问。

### ✅ 正确的图片下载方案

**和 cloud-document-converter 一模一样的做法**：

1. 遍历 `window.PageMain.blockManager.rootBlockModel` 的**活的**块树（不能 JSON 序列化——会丢失方法）
2. 对每个 image block，调用它的 `imageManager.fetch()` 方法获取带认证签名的可访问 URL
3. 用 XHR 下载该 URL 下的 blob

```javascript
// 在 page.evaluate() 里执行——访问 LIVE block tree
block.imageManager.fetch(
  { token: token, isHD: false, fuzzy: false },
  null,
  function(sources) {
    // sources.src = 可访问的图片 URL（带认证参数）
    var xhr = new XMLHttpRequest();
    xhr.open("GET", sources.src, true);
    xhr.responseType = "blob";
    xhr.onload = function() {
      var reader = new FileReader();
      reader.onload = function() {
        var base64 = reader.result.split(",")[1];
        // 返回 base64 给 Node.js 存文件
      };
      reader.readAsDataURL(xhr.response);
    };
    xhr.send();
  }
);
```

**为什么这能成功**：
- `imageManager.fetch()` 是 Feishu 内部方法，返回的 URL 包含完整的认证参数
- XHR 从该 URL 下载时，认证已经在 URL 里，不依赖 cookie 或 CORS
- 和 cloud-document-converter 使用的是完全相同的机制

### 7. 表格单元格内容提取

**问题**：表格 cell 的文本不在直接 `zoneState.content.ops` 里，而在 `cell.children` 的子 text block 里。

**正确做法**：递归遍历 cell.children 提取文本。

### 8. 标题提取

**问题**：页面标题在 root block 的 `zoneState.content.ops` 里，不在 children 中。只遍历 children 会丢失标题。

**正确做法**：先提取 root 的标题作为 h1，再遍历 children。

### 9. 图片表格 vs 文字表格

**问题**：飞书用 1 行表格放并列图片（视觉上是图片网格，DOM 结构是 table）。

**解决**：检测 table 的所有 cell 是否都只包含 image，如果是则拆成多个并列 figure。

### 10. 块树 JSON 序列化的 Proxy/Getter 问题

**问题**：`window.PageMain.blockManager.rootBlockModel` 是 MobX/Vue 响应式对象，属性可能是 Proxy 或 getter。

**不要这样做**：`JSON.parse(JSON.stringify(rootBlockModel))` ——可能丢数据、触发 getter 抛错、遇到循环引用。

**正确做法**：在 `page.evaluate()` 里直接访问活的对象，手动提取需要的字段生成 sections。序列化 sections（纯 JSON）而不是序列化块树。

## 性能经验

| 页面数 | 每页 sections | 图片数 | 耗时估计 |
|---|---|---|---|
| 11 | 4-379 | 0-47 | ~5 分钟 |
| 30 | — | — | ~15 分钟 |

瓶颈：图片 XHR 下载（每张 200ms-2s）和页面滚动等待（每页 ~4s）。

## 最终可工作的方案

### 文件清单

| 文件 | 用途 |
|---|---|
| `scripts/feishu/crawl.ts` | 主脚本：按 wiki 树 BFS 递归爬取，含图片下载、断点续爬 |
| `scripts/feishu/feishu-extract.js` | 核心提取逻辑（独立 JS，esbuild 不碰，readFileSync 加载） |
| `scripts/feishu/README.md` | 使用说明 |

### 用法

```bash
# 先启动 Chrome 调试端口
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-feishu-debug

# 递归爬取（BFS，边爬边发现子节点）
npx tsx scripts/feishu/crawl.ts <url> --connect
```

断点续爬：已存在的 markdown 文件会自动跳过，只重新生成 `_index_.md`。

### 输出结构

```
wiki-export/{url-token}/
├── _index_.md           ← 目录索引，展示完整嵌套结构（含链接）
├── assets/
│   ├── a1b2c3d4.png     ← 文件名 = 16 位小写 hex 哈希
│   └── e5f67890.png
├── 章节目录.md           ← 目录页面自身内容
└── 章节目录/             ← 子页面目录
    ├── _index_.md
    ├── 子页面1.md
    └── 子页面2.md
```

`_index_.md` 示例：

```markdown
# 项目文档 - 学习该目录下的内容

1. [项目源码](./项目源码.md)
2. [第一章｜AI 名词大扫盲](./第一章｜AI 名词大扫盲.md)
    - [什么是大模型？](./第一章｜AI 名词大扫盲/什么是大模型？.md)
    - [什么是Prompt？](./第一章｜AI 名词大扫盲/什么是Prompt？.md)
3. [第二章](./第二章.md)
```

- 直接子节点有链接
- 嵌套子节点缩进显示 + 完整相对路径

## 参考资料

- [cloud-document-converter](https://github.com/whale4113/cloud-document-converter) — 飞书文档转 Markdown 的 Chrome 扩展，本文档的块树遍历和图片下载方案直接参考了其 `packages/lark/src/docx.ts`
- [Feishu Open API - Block Type](https://open.feishu.cn/document/client-docs/docs-add-on/06-data-structure/BlockType) — 飞书官方 block 类型文档
