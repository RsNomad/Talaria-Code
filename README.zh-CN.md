<div align="center">

# Talaria Code

**面向 VS Code 的私有 AI 编码代理 —— 在你自己的本地模型上进行智能编辑、行内补全与对话。**
本地优先（Local-first）。你的模型，你的机器。

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.125-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Local-first](https://img.shields.io/badge/Local--first-no%20cloud-2ea44f)](#隐私与安全)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%C2%B7%20Fedora-51A2DA?logo=linux&logoColor=white)](#环境要求)

[English](./README.md) · [Русский](./README.ru.md) · **中文**

</div>

---

## Talaria Code 是什么？

Talaria Code 在 VS Code 的原生侧边面板中提供一个 **智能体式（agentic）AI 编码助手**
—— 对话、需经你批准的多步编辑、工具调用，以及基于你代码库的回答 —— 全部运行在
**你** 用 **Ollama**、**vLLM** 或 **llama.cpp** 自行托管的模型上。它是 [Hermes](https://github.com/nousresearch/hermes-agent)
代理的客户端，以本地优先为设计原则：你的代码与提示词发送到 *你* 掌控的模型端点，
而不是别人的云。

如果你想要现代 AI 编码助手的体验，又不愿把源代码交给第三方服务，那么它适合你。

## 功能特性

- 💬 **智能体式对话** —— 位于 VS Code 原生面板中的编码代理，支持多标签页与会话历史。
- ✍️ **需批准的编辑** —— 每一处文件改动都会被*提议*，并需要你明确的「是/否」。绝不静默写入。
- ⚡ **行内补全 + Next Edit** —— 由你的本地模型驱动的中间填充（FIM）补全与下一步编辑建议。
- 🔎 **理解你的代码库** —— 本地 RAG 索引（LanceDB + tree-sitter），让回答扎根于*你自己*的真实代码。
- 🧩 **工具与 MCP** —— 接入 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，并将编辑器自身的语言智能（诊断、定义、引用）开放给代理。
- 🕘 **检查点（Checkpoints）** —— 围绕代理的每个回合对工作区状态进行快照与恢复。
- 🔒 **隐私优先的设计** —— 外发内容在离开前先扫描敏感信息；批准采用「fail-closed（失败即拒绝）」；代理被限制在工作区内。

## 隐私与安全

这正是 Talaria Code 的核心，而非事后补丁：

- **外发扫描。** 发往模型的内容会先被扫描；密钥以及形似凭据的文件会在外发前被剥离或拦截。
- **fail-closed 的授权。** 权限提示带有截止时间 —— 在时限内未作答将被视为**拒绝**，
  而绝不会当作默许同意。
- **工作区隔离。** 文件访问与编辑被限制在你的工作区内；越界尝试（`..`、绝对系统路径）会被拒绝。
- **机器级的模型设置。** 你与哪个后端、哪个模型通信是机器级设置 —— 你打开的某个工作区
  无法悄悄把代理指向另一个端点。

> **如实说明：** Talaria Code 是*本地优先*的 —— 每个模型、嵌入和 MCP 端点都由你配置并托管。
> 这**并不是**「绝不外发任何字节」的硬性保证（你可以将其指向你自己拥有的远程节点，或接入
> 远程 MCP 服务器）。设计目标是：**你**掌控每一个目标地址，且无论如何密钥都会从数据流中被扫除。

## 环境要求

| 要求 | 说明 |
|---|---|
| **VS Code** | `^1.125` |
| **操作系统** | 主要目标为 **Linux（Fedora）**。mock 界面可在任意系统运行，但实时后端面向 Linux；其他平台目前未经测试。 |
| **Hermes 代理** | Talaria Code 所驱动的后端（`hermes acp` + `python -m tui_gateway.entry`）。本扩展是 Hermes 的*客户端*。 |
| **本地模型运行时** | **Ollama**、**vLLM** 或 **llama.cpp**，需提供：对话/代理模型（经由 Hermes）、FIM 补全模型（默认 `qwen2.5-coder:1.5b-base`），以及用于 RAG 的嵌入模型（默认 `qwen3-embedding:0.6b`）。 |

## 安装

Talaria Code 尚未上架 Marketplace。请从源码构建并安装：

```bash
npm install        # host + webview（npm workspaces）
npm run build      # 构建两个 bundle
npm run package    # 通过 vsce 生成 .vsix

code --install-extension talaria-code-*.vsix
```

## 快速开始

1. 安装并运行 **Hermes** 代理与一个 **模型运行时**（例如带上述模型的 Ollama）。
2. 从活动栏打开 **Talaria** 面板。
3. 将扩展指向你的 Hermes 安装，然后把 `hermes.backend` 从 `mock` 切换为 `acp`（见「配置」）。

首次运行时，扩展会使用脚本化的 **mock** 后端，让你在不启动 Hermes 进程的情况下浏览界面
—— 它可在任意系统运行。切换为 `acp` 即可对接你的真实代理进入实时模式。

## 配置

设置位于 **`hermes.*`** 命名空间下（Talaria Code 是 Hermes 客户端）。你通常会用到的：

| 设置项 | 默认值 | 作用 |
|---|---|---|
| `hermes.backend` | `mock` | 与哪个代理后端通信。设为 `acp` 以使用真实的 Hermes 后端。 |
| `hermes.hermesPath` | `""` | `hermes` 可执行文件的绝对路径。 |
| `hermes.pythonPath` | `""` | 用于启动真实 Hermes 后端的 Python 解释器。 |
| `hermes.cwd` | `""` | 代理的工作目录（默认取第一个工作区文件夹）。 |
| `hermes.autocomplete.enabled` | `true` | 启用行内（FIM）补全。 |
| `hermes.autocomplete.backend` | `ollama` | 提供补全服务的后端。 |
| `hermes.autocomplete.model` | `qwen2.5-coder:1.5b-base` | 用于补全的模型。 |
| `hermes.autocomplete.endpoint` | `""` | 补全后端的基础 URL（可以是你自己托管的节点）。 |
| `hermes.rag.enabled` | `true` | 启用代码库 RAG 索引与搜索。 |
| `hermes.rag.embedEndpoint` | `http://127.0.0.1:11434` | 嵌入后端的基础 URL。 |
| `hermes.rag.embedModel` | `qwen3-embedding:0.6b` | 用于嵌入代码片段的模型。 |

完整设置见设置界面（搜索 `hermes`）。

## 工作原理

```
VS Code  ──►  Talaria Code（本扩展）
                   │  Agent Client Protocol (ACP)
                   ▼
              Hermes 代理  ──►  你的本地模型运行时
                                 (Ollama / vLLM / llama.cpp)
```

一个仓库，两个 bundle：TypeScript **host**（esbuild → `dist/extension.js`）与
React 18 的 **webview** 面板（Vite → `dist/webview/`）。二者通过单一的类型化
`postMessage` 协议通信 —— webview 从不直接接触 Node 或 VS Code API。host 通过 ACP
驱动 Hermes 代理完成对话、编辑、工具与 MCP；而行内补全与代码嵌入则**直接**访问你所
配置的模型端点。

## 参与开发

要求：Node ≥ 18（推荐 Node 24），VS Code ≥ 1.125。

```bash
npm install
```

在 VS Code 中按 **F5** 即可构建两个 bundle 并打开带 mock 数据的 Extension
Development Host —— 不会启动 Hermes 进程，因此可在任意系统运行。

| 脚本 | 作用 |
|---|---|
| `npm run build` | 一次性构建两个 bundle |
| `npm run watch` | 变更时重新构建两个 bundle |
| `npm run check-types` | 对 `src/**` 进行 `tsc --noEmit` 类型检查 |
| `npm run package` | 通过 `vsce` 生成 `.vsix` |
## 许可证

Talaria Code 采用 **GPL-3.0-or-later** 许可证。
Copyright © 2026 **Syntinal**。

你可以自由使用、研究、分享和修改本软件；若你分发修改后的版本，它必须继续以 GPL 许可。
完整文本见 [`LICENSE`](./LICENSE)，随附的第三方组件及其许可证见
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
