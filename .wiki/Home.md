# Comote 技术解析文档

> 基于当前本地仓库在 2026-05 的代码分析生成。所有结论都来自已读源码、配置、脚本、测试或 README，并用相对路径行号标注。

## Comote 是什么

Comote 是一个本地优先的 Codex 手机遥控器：它把微信 / 飞书消息接入本机 Node daemon，再把命令转给 Codex Desktop 或 Codex CLI。产品约束是“不暴露电脑公网、不自建中转服务、由本机确认身份后才能控制 Codex”，这几个约束在 README 的定位、功能列表和拓扑说明中都有直接描述：[`README.md:5`](../README.md#L5)、[`README.md:42`](../README.md#L42)、[`README.md:88`](../README.md#L88)。

技术上，仓库是一个 Node.js ESM daemon + Tauri 2/Rust 桌面壳 + 静态 Web 设置界面。Node 进程负责本地 HTTP API、授权、命令路由、通道运行时和 Codex 连接器；Tauri 壳负责启动 sidecar、托盘驻留和 WebView 展示；`public/` 下的页面通过 `/api/*` 驱动配置和审批界面。

**关键属性**：

- **本机边界清晰**：daemon 默认只监听 `127.0.0.1:16208`，入口在 [`src/server/index.js:4`](../src/server/index.js#L4)。
- **授权先于命令**：身份以 `channel:stableId` 为键，未确认身份不能执行命令，逻辑在 [`src/core/authorization.js:47`](../src/core/authorization.js#L47) 和 [`src/core/commands.js:118`](../src/core/commands.js#L118)。
- **Codex Desktop 为主、CLI 为备**：Desktop connector 走 `codex app-server` JSON-RPC，CLI connector 只在新会话 fallback 时执行 `codex exec`，见 [`src/connectors/codex-desktop/json-rpc.js:123`](../src/connectors/codex-desktop/json-rpc.js#L123) 和 [`src/connectors/codex-cli/index.js:16`](../src/connectors/codex-cli/index.js#L16)。
- **通道可扩展**：微信、飞书都被抽象成 adapter + runtime + driver，并复用同一个 `CommandRouter`，组合根在 [`src/server/state.js:71`](../src/server/state.js#L71)。

## 文档结构

| 章节 | 内容 |
|---|---|
| [01 架构总览](./01-架构总览.md) | 进程拓扑、目录职责、组合根和关键设计取舍 |
| [02 核心模块](./02-核心模块.md) | Authorization、Project、Session、CommandRouter、队列和持久化 |
| [03 频道与集成层](./03-频道与集成层.md) | 微信 iLink、飞书 OpenAPI/WebSocket、adapter/runtime/driver 分层 |
| [04 Codex连接器与模型后端](./04-Codex连接器与模型后端.md) | Codex Desktop app-server JSON-RPC、通知翻译、审批和 CLI fallback |
| [05 Tauri壳与本地安全边界](./05-Tauri壳与本地安全边界.md) | 桌面壳、sidecar 生命周期、本地 HTTP API、token 与静态资源边界 |
| [06 端到端数据流](./06-端到端数据流.md) | 命令、会话、审批、流式回包、配置绑定的典型时序 |
| [07 打包与发布](./07-打包与发布.md) | npm scripts、Tauri bundle、Node runtime sidecar、CI release |
| [08 扩展指南](./08-扩展指南.md) | 新增频道、连接器、命令、API 与发布约束的实际改法 |

## 阅读建议

- **产品 / 架构入门**：先读 [01 架构总览](./01-架构总览.md)，再读 [06 端到端数据流](./06-端到端数据流.md)。
- **准备改核心命令**：读 [02 核心模块](./02-核心模块.md) 和 [04 Codex连接器与模型后端](./04-Codex连接器与模型后端.md)。
- **准备新增 IM 频道**：读 [03 频道与集成层](./03-频道与集成层.md)，再读 [08 扩展指南](./08-扩展指南.md)。
- **准备发版**：读 [07 打包与发布](./07-打包与发布.md)，同时核对 README 中的产物路径描述。

## 仓库基础信息

| 维度 | 当前结论 |
|---|---|
| License | MIT，见 [`LICENSE`](../LICENSE) 和 README 协议说明 [`README.md:231`](../README.md#L231) |
| 主语言 / 栈 | Node.js ESM、Tauri 2/Rust、静态 HTML/CSS/JS，见 [`package.json:5`](../package.json#L5)、[`src-tauri/Cargo.toml:13`](../src-tauri/Cargo.toml#L13) |
| 运行时要求 | Node `>=20`，Tauri 依赖 Rust，见 [`package.json:20`](../package.json#L20)、[`README.md:172`](../README.md#L172) |
| 入口命令 | `npm run dev` 启动 daemon，`npm run desktop:dev` 启动桌面开发模式，见 [`package.json:10`](../package.json#L10)、[`package.json:16`](../package.json#L16) |
| 测试 | `npm test` 实际执行 `node --test`，见 [`package.json:18`](../package.json#L18) |
| 发布 | macOS arm64 DMG + Windows x64 NSIS，见 [`package.json:11`](../package.json#L11)、[`package.json:12`](../package.json#L12) |

## 读代码时的注意点

README 的“项目结构”提到了 `src/channels`、`src/connectors`、`src/core`、`src/server`、`src-tauri`、`public`、`scripts` 和 `test`，与实际目录一致，[`README.md:205`](../README.md#L205)。但 README 的命令速查比代码里的真实命令集少：代码中还有 `/use`、`/switch`、`/tail`、`/cancel`，定义在 [`src/core/commands.js:240`](../src/core/commands.js#L240)。

打包产物路径也有一个文档漂移：README 写 macOS 到 `release/mac/`、Windows 到 `release/win/`，但脚本和 CI 实际使用仓库根 `release/Comote-*.dmg` 与 `release/Comote-Setup-*.exe`，见 [`README.md:195`](../README.md#L195)、[`scripts/create-mac-dmg.mjs:20`](../scripts/create-mac-dmg.mjs#L20)、[`scripts/collect-tauri-artifacts.mjs:14`](../scripts/collect-tauri-artifacts.mjs#L14)。

## 文档生成范围

本 wiki 只覆盖本地代码库当前实现，不声明远端仓库最新状态，也不推送 GitHub Wiki。未运行真实微信 / 飞书 / Codex Desktop 集成，只基于源码、测试和配置推导运行行为；涉及第三方接口的结论都标注了本地 driver 的封装位置。
