# Docsify Crawler

从 Docsify 文档站点批量下载 Markdown 源文件，按侧边栏层级保存。

## 用法

```bash
npx tsx scripts/docsify/crawl.ts <docsify-base-url>

# 示例
npx tsx scripts/docsify/crawl.ts https://hello-agents.datawhale.cc
```

## 原理

1. 请求 `{baseUrl}/_sidebar.md`，解析嵌套列表结构得到完整目录树
2. 对每个叶子节点请求其 `.md` 文件
3. 按侧边栏层级保存到本地，生成 `_index_.md`

## 输出

```
wiki-export/docsify/{hostname}/
├── _index_.md
├── README.md
├── 前言.md
├── chapter1/
│   ├── _index_.md
│   └── 第一章 初识智能体.md
└── chapter2/
    └── ...
```

## 与飞书脚本的关系

| | 飞书 | Docsify |
|---|---|---|
| 入口 | `scripts/feishu/crawl.ts` | `scripts/docsify/crawl.ts` |
| 获取方式 | Playwright + block tree | HTTP fetch |
| 输出格式 | 相同（sections → markdown，树形目录，`_index_.md`） | 相同 |
| 依赖 | playwright | 无（Node 内置 fetch） |

## 依赖

零外部依赖。仅使用 Node.js 内置的 `fetch`、`fs`、`path`。
