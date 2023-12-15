# 仓库 Agent 说明

## 构建与交付流程

修改 server 代码、插件代码、插件静态资源或 package 配置后，在交付修改前
必须完成以下验证流程：

1. 执行相关的类型检查和测试。仓库级命令是 `make check` 和 `make test`。
2. 执行 `make rebuild`。该命令会构建 Chrome 插件，并通过 Docker Compose
   重建、重启 `knowledge-ingest-server:local` 镜像。
3. 如果 Docker 不可用或重建失败，必须明确报告，不能把本地 TypeScript
   构建结果当作运行时验证完成。

`make dev` 只会启动已有容器，不会重新构建源码。完成代码修改后，不能用它
替代 `make rebuild`。重建过程会保留仓库的 `knowledge-store` 数据卷。

插件开发的内循环可以使用 `make build-extension`，但交付前仍必须执行
`make rebuild`。插件构建成功后，如果需要手工验证浏览器行为，还要在 Chrome
中重新加载 unpacked extension。

除非用户明确要求删除数据，否则不要执行 `make clean-store` 或其他破坏性
清理命令。

## GitHub Markdown 配置

GitHub private repository 的访问 token 使用宿主机运行时环境变量
`KNOWLEDGE_GITHUB_TOKEN` 注入 Docker 容器；修改 token 后必须重新创建容器，
例如执行 `KNOWLEDGE_GITHUB_TOKEN="..." docker compose up -d --force-recreate`
或 `KNOWLEDGE_GITHUB_TOKEN="..." make rebuild`。不要把 token 写入 Import 请求、
Markdown、Knowledge Store、日志或提交内容。`GITHUB_TOKEN` 仍作为兼容旧配置的
别名保留。
