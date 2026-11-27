# Agent、风控与金融系统阅读清单

## 文档信息

| 项目 | 内容 |
| --- | --- |
| **文档标题** | Agent、风控与金融系统阅读清单 |
| **创建日期** | 2026-11-20 |
| **文档类型** | 阅读清单与 Knowledge 抓取评估 |
| **来源** | 用户提供的“大模型 Agent 博客推荐”页面文本 |
| **链接数** | 86 个去重后的正文链接 |

## 目录

- [整理口径](#整理口径)
- [大模型与 Agent](#大模型与-agent)
  - [机构、官方博客与教程](#机构官方博客与教程)
  - [国内个人作者](#国内个人作者)
  - [国外个人作者](#国外个人作者)
- [信贷风控与反欺诈](#信贷风控与反欺诈)
- [量化研究与交易](#量化研究与交易)
- [支付、账务与金融系统](#支付账务与金融系统)
- [Knowledge 与 adapter 评估](#knowledge-与-adapter-评估)

## 整理口径

附件中的对话从 Agent 和大模型阅读建议，延伸到信贷风控、量化交易和金融系统工程。下面保留各主题下的站点入口与推荐文章，按主题和作者类型重新编排；网址已去掉 `utm_source` 跟踪参数，并移除了 favicon 和原始 ChatGPT 会话链接。条目说明沿用附件中的推荐内容，尚未通过浏览器重新核验网页现状。

## 大模型与 Agent

### 机构、官方博客与教程

#### 国际

- [OpenAI Research](https://openai.com/research/)：模型研究与进展。
- [OpenAI Cookbook：Agents](https://developers.openai.com/cookbook/topic/agents)：Agent 架构和动手开发案例。
- [Anthropic Research](https://www.anthropic.com/research)：Agent 设计、上下文工程、评估与可靠性。
- [Google DeepMind Research](https://deepmind.google/research/)：模型与智能体研究。
- [Google Research Blog](https://research.google/blog/)：研究论文、实验结论与多智能体等主题。
- [Hugging Face Blog](https://huggingface.co/blog)：开源模型、训练推理工具、Agent 教程和社区项目。
- [LangChain Blog](https://www.langchain.com/blog)：Agent 工作流、上下文管理、评估和生产实践。

#### 国内

- [Qwen Blog](https://qwenlm.github.io/)：通义千问模型发布、训练方法和技术报告。
- [DeepSeek 技术更新与 API 文档](https://api-docs.deepseek.com/updates/)：模型/API 更新和开发方式。
- [Kimi Research Blog](https://www.kimi.com/en/blog/)：模型、Agent、强化学习和推理基础设施。
- [字节 Seed 技术博客](https://seed.bytedance.com/en/blog_list/foundation)：Seed 模型、Agent 与多模态技术发布。
- [智谱 / Z.ai Research](https://www.zhipuai.cn/zh/research)：GLM、Agentic LLM、长任务和推理基础设施。
- [美团技术团队](https://tech.meituan.com/)：工程实践、Agent 评测、AI Coding 和大模型落地。
- [Datawhale Hello-Agents](https://datawhalechina.github.io/hello-agents/)：开源 Agent 学习教程，覆盖基础、记忆、上下文工程、评估和实战。

### 国内个人作者

- [袁朝发：chaofa 用代码打点酱油](https://yuanchaofa.com/)：模型原理与 Agent 工程。
- [Agent Prompt Caching 系列](https://yuanchaofa.com/post/prompt-cache-design-for-llm-agents)：工具定义、上下文布局和缓存命中。
- [苏剑林：科学空间](https://kexue.fm/)：模型架构、训练方法和数学推导，适合补 RoPE、Attention、优化器等基础。
- [宝玉的分享·个人原创](https://baoyu.ai/blog)：AI 编程、Agent 使用和开发流程复盘。
- [Guangzheng Li 个人博客](https://guangzhengli.com/)：独立开发、MCP、GPT 应用和模型缓存实践。
- [Mark：滿紙方糖言](https://blog.mygraphql.com/zh/)：个人技术博客。
- [亲自开发 AI Agent 与 AI Coding 项目的半年复盘](https://blog.mygraphql.com/zh/posts/ai/aiagent-design/everlingo-dev-story/)：Agent 项目的实际工程取舍。
- [Justin3go 个人博客](https://justin3go.com/blog)：Agent 记忆、上下文压缩和 Harness。

### 国外个人作者

- [Simon Willison’s Weblog](https://simonwillison.net/)：LLM、Coding Agent、安全和工具实践。
- [Coding Agents 专题](https://simonwillison.net/tags/coding-agents/)：Coding Agent 相关实践文章。
- [Agentic Engineering Patterns](https://simonwillison.net/guides/agentic-engineering-patterns/)：Agentic Engineering 实践指南。
- [Mario Zechner 个人博客](https://mariozechner.at/posts/)：Pi 作者关于 Coding Agent 的构建经验。
- [MCP vs CLI 实测](https://mariozechner.at/posts/2025-08-15-mcp-vs-cli/)：MCP 与 CLI 的实践比较。
- [Hamel Husain 个人博客](https://hamel.dev/)：Agent 评估、错误分析和产品调试。
- [AI Evals 指南](https://hamel.dev/blog/posts/evals-faq/)：线上 Agent 评估与调试。
- [Jason Liu：Writing](https://jxnl.co/writing/)：上下文工程、Agentic RAG 和工具返回内容设计。
- [上下文工程系列](https://jxnl.co/writing/2025/08/28/context-engineering-index/)：上下文工程专题文章索引。
- [Eugene Yan：Writing](https://eugeneyan.com/writing/)：生产环境 LLM 应用、数据与评估。
- [Lilian Weng：Lil’Log](https://lilianweng.github.io/)：LLM 与 Agent 经典技术综述。
- [Lil’Log 文章列表](https://lilianweng.github.io/posts/)：按文章浏览综述与技术主题。
- [Sebastian Raschka：Blog and Notes](https://sebastianraschka.com/blog/)：模型架构、训练与推理。
- [拆解 Coding Agent 组成](https://magazine.sebastianraschka.com/p/components-of-a-coding-agent/)：Coding Agent 组件介绍。
- [Armin Ronacher 个人博客](https://lucumr.pocoo.org/)：开发工具、Coding Agent 和软件设计。

## 信贷风控与反欺诈

### 国内

- [雷帅：风控策略模型](https://www.woshipm.com/pd/5701921.html)：准入、名单、多头规则、执行顺序和阈值监控。
- [「算法进阶」风控建模全流程](https://github.com/aialgorithm/Blog/issues/44)：A 卡、样本、表现期和特征等基础概念。
- [「算法进阶」信贷反欺诈全流程](https://github.com/aialgorithm/Blog/issues/9)：信贷反欺诈流程与业务术语。
- [美团 Zeus 风控规则引擎](https://tech.meituan.com/2020/05/14/Meituan-Security-Zeus.html)：欺诈识别、信用评估、额度与定价。
- [字节跳动技术团队](https://developer.volcengine.com/)：行为特征与反作弊技术文章。
- [字节跳动：行为序列模型在抖音风控中的应用](https://developer.volcengine.com/articles/7599493538259566630)：内容与账号风险中的行为特征建模。

### 国外

- [Francisco Javier Arceo 个人博客](https://franciscojavierarceo.dev/)：银行信贷和欺诈建模。
- [How to Build a Credit Risk Model](https://franciscojavierarceo.dev/post/how-to-build-a-credit-risk-model)：违约标签、数据时间点、模型评估和数据泄漏。
- [ListenData](https://www.listendata.com/)：信用评分、WOE/IV、Vintage 和 Roll Rate 等主题。
- [信用风险建模总览](https://www.listendata.com/2019/08/credit-risk-modelling.html)：信用风险建模入门。
- [Frank on Fraud](https://frankonfraud.com/)：银行、贷款和支付欺诈案例。
- [Max Halford 个人博客](https://maxhalford.github.io/blog/)：在线机器学习与实时模型实践。
- [延迟标签下如何评估在线模型](https://maxhalford.github.io/blog/online-learning-evaluation/)：在线模型评估，对交易反欺诈有参考价值。
- [Grab Tech](https://engineering.grab.com/)：风控决策平台、特征、规则回测和数据可观测性。
- [Griffin 反欺诈规则引擎](https://engineering.grab.com/griffin)：反欺诈规则平台实践。
- [Automatic Rule Backtesting](https://engineering.grab.com/automatic-rule-backtesting)：规则回测实践。
- [Monzo Blog](https://monzo.com/blog/)：银行支付反欺诈。
- [Building a Reactive Fraud Prevention Platform](https://monzo.com/blog/build-a-reactive-fraud-prevention-platform)：实时与批量特征组合的反欺诈平台。
- [Stripe Radar 的实现](https://stripe.dev/blog/how-we-built-it-stripe-radar)：支付风控系统实践。

## 量化研究与交易

### 个人作者

- [Rob Carver：This Blog is Systematic](https://qoppac.blogspot.com/p/systematic-trading-start-here.html)：系统化交易、组合、仓位和交易成本。
- [Ernie Chan：Quantitative Trading](https://epchan.blogspot.com/)：量化策略研究、机器学习与过拟合问题。
- [Mark Best：Quantitative Trading](https://markrbest.github.io/)：行情吞吐、OMS、持仓状态和交易前风控。
- [Positions and Orders](https://markrbest.github.io/positions-and-orders/)：成交与持仓更新乱序可能造成的问题。
- [宋伟力：量化研究与实盘记录](https://weilisong.com/)：A 股研究、数据、因子、组合和交易链路。

### 机构与平台

- [BigQuant 知识库](https://bigquant.com/wiki/)：量化平台教程。
- [量化回测指南](https://bigquant.com/wiki/doc/Z0tjAS5sWx)：回测、交易成本和未来数据泄漏。
- [米筐 Ricequant 文档](https://www.ricequant.com/doc/)：回测引擎、因子工具和历史价格处理。
- [Ricequant 回测文档](https://www.ricequant.com/doc/quant/backtest.html)：动态复权与避免未来数据。
- [Jane Street Archive](https://blog.janestreet.com/archive/)：交易系统工程、实时特征与性能。
- [Flex Model：事件驱动特征系统](https://blog.janestreet.com/flex-model-an-event-driven-feature-engineering-system/)：事件驱动特征工程。
- [Two Sigma Insights](https://www.twosigma.com/insights/)：量化研究与数据工程。
- [用机器学习划分市场状态](https://www.twosigma.com/articles/a-machine-learning-approach-to-regime-modeling/)：市场状态建模。
- [Treating Data as Code](https://www.twosigma.com/articles/treating-data-as-code-at-two-sigma/)：数据工程与代码化管理。
- [AQR Research](https://www.aqr.com/Insights/Research/)：因子投资与组合构建研究。
- [Portfolio Construction Matters](https://www.aqr.com/Insights/Research/Working-Paper/Portfolio-Construction-Matters-A-Simple-Example-Using-Value-and-Momentum-Themes)：价值与动量主题的组合构建。

## 支付、账务与金融系统

- [Patrick McKenzie：Bits about Money](https://www.bitsaboutmoney.com/)：支付网络、银行、欺诈和对账机制。
- [支付欺诈的供应链](https://www.bitsaboutmoney.com/archive/the-fraud-supply-chain/)：从业务机制看支付欺诈。
- [Brandur Leach](https://brandur.org/)：后端系统与可靠性实践。
- [用 Postgres 实现支付式幂等键](https://brandur.org/idempotency-keys)：超时、重试、外部副作用和事务边界。
- [郭宁：支付清结算系列](https://ningg.top/fin-tech-01-clearing-and-settlement-sys/)：渠道对账、差错处理和结算流程。
- [Patterns for Accounting](https://martinfowler.com/eaaDev/AccountingNarrative.html)：账务分录与会计模型。
- [LMAX Architecture](https://martinfowler.com/articles/lmax.html)：单线程核心、事件日志和重放。
- [京东科技技术博客](https://www.cnblogs.com/jingdongkeji/)：清分、清算、结算平台实践。
- [交易履约之结算平台实践](https://www.cnblogs.com/jingdongkeji/p/17754088.html)：结算平台与分片任务。
- [美团对账体系建设](https://tech.meituan.com/2018/03/21/balance-accounts.html)：资金对账实践。
- [Stripe Blog](https://stripe.dev/blog/)：支付风控、资金流转和账本。
- [Stripe Ledger 系统](https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement)：资金流转追踪与校验。
- [Block / Square Blog](https://developer.squareup.com/blog/)：双分录、不可变流水和账户余额建模。
- [Books：账务数据库](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/)：不可变双分录账务数据库。

## Knowledge 与 adapter 评估

### 当前检查结果

| 检查项 | 结果 |
| --- | --- |
| 浏览器页面读取 | CDP Bridge 已通过 MCP Gateway 接入；Gateway 报告 browser upstream `connected=True, tools=13`。新增 `browser_new_tab(url)` 创建后台标签，不导航或激活已有标签；当前对话的工具目录仍是旧的 12 项，已用 `browser_batch` 的 CDP `Target.createTarget(background:true)` 继续抽查。 |
| 本地 Knowledge Markdown | `knowledge-store/markdown` 有 49 份 Markdown；按附件中的正文网址检查，没有找到与这 86 个页面直接对应的来源 URL。 |
| 相近内容 | 有一份 [Hello-Agents 整合版 Markdown](../knowledge-store/markdown/2391864d-b110-4aef-ba34-3ec63a0f6434.md)，但它的来源是 `github.com/convexwf/reference` 的锁定版本，不是 Datawhale 页面抓取结果；文件开头还重复出现了同一个 H1。 |
| Relay 注册状态 | Relay 扩展自动连接 Knowledge Ingest Server 的 `/agent` WebSocket，握手后周期 ping 并自动重连；本轮 `/api/capture/status` 返回 `agentConnected: true`。Relay 是 Knowledge 的浏览器采集端，不是 MCP Gateway 上游。 |
| Relay 覆盖范围 | Capture Relay 白名单只有 `xiaoheihe.cn`、`reddit.com` 的相关 hostname，不包括本清单中的博客、研究站和金融站点。现有白名单不能直接抓取这批页面。 |
| 只读预览 | 本轮 6 个页面均经 CDP 读取并调用 Knowledge `/api/ingest/preview`，返回 `status.state=empty`，没有写入 Knowledge Store。各页结果见下表。 |
| Adapter 匹配 | Yuanchaofa URL 的 `matchedAdapters` 出现 `juejin`，原因是路径 `/post/` 命中；该站点不在 Juejin host 列表中。这说明 path pattern 可绕过 host 匹配，属于 matcher 误报。 |
| 当前运行状态 | `BotMcpGateway` Windows 服务已启动；Relay 和 browser upstream 均已连接。后台抽查标签保持非前台，原活动标签未被导航。 |

### 样本预览

| 站点 / 页面 | Knowledge 结果 | 观察 |
| --- | --- | --- |
| Yuanchaofa / Prompt Caching | Defuddle；5,794 字正文，84 个段落/结构块，27 个标题，12 个链接，4 个表格；Markdown 6,718 字 | 正文主体可用，但重复输出“前置知识”段落和一条引文；同时误匹配 Juejin adapter。 |
| Simon Willison / Agentic Engineering Patterns 指南页 | Defuddle；6,692 字，49 个链接；Markdown 6,959 字 | 这是指南目录页，链接密度高；标题取成站点名。 |
| Simon Willison / 对应博客文章 | Defuddle；4,061 字，16 个结构块，10 个链接；Markdown 4,332 字 | `pageTitle` 和 `og:title` 是文章标题，但 Markdown H1/title 取到 `og:site_name` 的 “Simon Willison’s Weblog”。 |
| Grab / Griffin | Defuddle；16,376 字，105 个结构块，13 个标题，18 个链接，10 张图，5 段代码；无警告；Markdown 17,811 字 | 正文和代码结构保留良好。 |
| Datawhale / Hello-Agents | Defuddle；11,964 字，60 个结构块，19 个标题，65 个链接，9 张图，2 个表格，1 段代码；无警告；Markdown 13,560 字 | 正文结构较完整；首页徽章及图片 alt 文本也进入了 Markdown。 |
| Mark Best / Hidden Dangers of Writing an OMS | Defuddle；6,500 字，24 个结构块，7 个标题，3 个链接，3 段代码；无警告；Markdown 7,086 字 | 正文与代码块完整，标题正确，无需专用 adapter。 |
| 美团 / Zeus（前一轮已检查） | 现有 `meituan_tech` adapter 按 host 命中；约 10,031 字，94 个结构块，17 个标题；无警告 | 现有 adapter 工作正常。 |

### Adapter 决定

**建议新增一个轻量 Simon Willison adapter；Yuanchaofa 先修 matcher 再复查。** Simon 两个页面都把 `og:site_name` 作为 Markdown 主标题，正文文章页明明有正确的 `og:title`。adapter 可用 `og:title` 生成文章标题，并保留 Defuddle 的正文结果。

Yuanchaofa 的当前正文由通用 Defuddle 选中，主体可用，但重复输出“前置知识”和一条引文；同时 `/post/` 触发了 Juejin adapter 误匹配。先修复“host 命中后才评估该站点 path pattern”，再复查；如果重复仍在，再给 `yuanchaofa.com` 增加精确正文选择器。Grab、Datawhale、Mark Best 没有显示需要专用 adapter 的结构问题；美团已有 adapter 正常。其他站点仍需抽样后再判断。

其余站点按“后台标签读取 → Knowledge 只读预览 → 与页面正文对照”抽样；对同站点重复出现的结构性缺失再新增 adapter。当前会话刷新工具目录后可直接使用 `browser_new_tab`，旧工具目录仍可用已验证的 CDP 后台 target 方式。

### 文章页抓取方式比对

2026-11-27 对清单中的 36 个文章页做了三方比对：用 CDP 驱动的 Chromium 读取渲染后的原文，用 Capture Relay 扩展采集后解析，用服务端 `server_fetch` 抓取后解析。比对在临时 Knowledge Store 上以只读预览完成，Relay 使用放宽了 hostname 白名单的临时副本，仓库中的白名单没有改动。"段落覆盖"指原文主体区域内的段落、列表项和小标题中，能在解析结果里找到的比例。

| 结果 | 页面数 | 说明 |
| --- | --- | --- |
| Relay 与 `server_fetch` 的正文一致 | 33 | 字数相差不到 5%，段落覆盖相同，标题与页面标题一致 |
| 只有 Relay 拿到完整正文 | 1 | `bigquant.com/wiki/doc/Z0tjAS5sWx`：正文由浏览器渲染，Relay 24,927 字，`server_fetch` 11,243 字 |
| 只有 `server_fetch` 成功 | 1 | `woshipm.com/pd/5701921.html`：Relay 在等待时间内只拿到空页面并报 `empty-page`，`server_fetch` 6,969 字、覆盖 98% |
| 两种方式都失败 | 1 | `aqr.com` 的工作论文页：测试所在网络无法解析该域名，未能判断页面本身是否可抓 |

段落覆盖低于 90% 的页面逐个核对过，缺失的都不是正文：

| 页面 | 覆盖 | 未进入解析结果的内容 |
| --- | --- | --- |
| `qoppac.blogspot.com` Start here | 43% | 80 条读者评论和侧边栏 |
| `hamel.dev` AI Evals FAQ | 61% | 页首的问题目录；各问题的正文都在 |
| `twosigma.com` Regime Modeling | 76% | 文末的相关文章列表 |
| `stripe.dev` Radar | 83% | 作者简介和文末的推广链接 |

标题方面有三处小问题，与抓取方式无关：`bigquant.com` 取到正文第一个小标题而不是页面标题"量化回测指南"；`ricequant.com` 的标题末尾带一个零宽空格；`tech.meituan.com` 的标题带站点名后缀。

结论：这批文章页绝大多数是静态页面，`server_fetch` 已经足够，不需要为它们扩大 Relay 白名单。需要浏览器渲染的只有 BigQuant 一个站点。[`scripts/automation/reading-list-runner.mjs`](../scripts/automation/reading-list-runner.mjs) 据此实现：Relay 已连接且允许该站点时用 Relay，否则用 `server_fetch`；对 BigQuant 的 `server_fetch` 结果会给出"正文不完整"的警告。50 个站点入口页（博客首页、归档、标签页）没有纳入比对，runner 默认也跳过它们。

### Relay 与 CDP 的区别

Knowledge Capture Relay 与 MCP Gateway 的 CDP Bridge 是两条连接：Relay 扩展以 WebSocket 自动注册到 Knowledge Ingest Server 的 `/agent`，读取受允许的页面并将快照交给服务端；CDP Bridge 由 Gateway 暴露浏览器工具，适合 Agent 在同一 Chrome 中读取网页。本轮样本由 CDP 读取后交给 Knowledge 的只读 preview 接口解析；Relay 保持连接，但其 hostname 白名单不允许直接采集这些站点。CDP 侧新增的 `browser_new_tab` 始终以后台标签打开目标 URL。预览只生成解析结果，本次没有调用保存接口。

