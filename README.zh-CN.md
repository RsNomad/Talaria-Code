<div align="center">

# Talaria Code

**面向 VS Code 的私有 AI 编码代理 —— 在你自己的本地模型上进行智能编辑、行内补全与对话。**
本地优先（Local-first）。你的模型，你的机器。

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.125-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Local-first](https://img.shields.io/badge/Local--first-no%20cloud-2ea44f)](#隐私与安全)
[![Platform](https://img.shields.io/badge/Platform-Linux-51A2DA?logo=linux&logoColor=white)](#环境要求)

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
- 📦 **经过校验的本地模型设置** —— 一块面板即可选择后端（Ollama / llama.cpp / vLLM），从可信发布方下载精选模型并强制校验其校验和，为你接好行内补全与代码库索引，并把代理模型设置好、就绪以指向你的提供方。
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
| **操作系统** | 主要目标为 **Linux**（在 Fedora 上开发）。mock 界面可在任意系统运行，但实时后端面向 Linux；其他平台目前未经测试。 |
| **Python + pipx** | `PATH` 中需有 Python **3.11–3.13** 与 **pipx**。**Backend Setup** 面板会通过 pipx 为你安装 Hermes 代理 —— 本扩展仍是 Hermes 的*客户端*。在 Fedora 上：`sudo dnf install pipx`。 |
| **本地模型运行时** | **Ollama**、**vLLM** 或 **llama.cpp**，需提供：对话/代理模型（经由 Hermes）、FIM 补全模型（默认 `qwen2.5-coder:1.5b-base`），以及用于 RAG 的嵌入模型（默认 `qwen3-embedding:0.6b`）。Setup 面板可检测 Ollama 守护进程，引导你完成 llama.cpp/vLLM 的安装，从精选目录下载并校验模型，为你接好行内补全与代码库索引，并把代理模型设置好、就绪以指向你的提供方。 |

## 安装

Talaria Code 尚未上架 Marketplace。请从源码构建并安装：

```bash
npm install        # host + webview（npm workspaces）
npm run build      # 构建两个 bundle
npm run package    # 通过 vsce 生成 .vsix

code --install-extension talaria-code-*.vsix
```

### 升级

自 **0.1.1** 起，安装更新的 `.vsix` 会**原地升级** —— 无需先卸载。VS Code 以版本号
区分扩展，而现在每次发布都携带更高的版本，因此
`code --install-extension talaria-code-*.vsix`（或 **Extensions: Install from
VSIX…**）会直接替换正在运行的构建。`0.1.0-beta.*` 的安装可干净地升级到任意
`0.1.1+`。

此前的预发布都报告同一个 `0.1.0` 版本，VS Code 因看不到版本变化而保留旧构建，直到你
手动卸载。下文「每次发布一个版本核」的方案（每次发布都获得自己更高的版本）取消了这一步。

## 快速开始

Talaria Code 从**一个面板**完成后端的安装与接线 —— 无需手改 JSON，也无需手动安装
Python。

1. **安装扩展**（`.vsix` —— 见[「安装」](#安装)）。
2. **从活动栏打开 Talaria 面板**。首次运行时，**Backend Setup** 会自动打开。之后随时可
   通过面板标题栏的**火箭图标**或 **`Talaria: Backend Setup`** 命令再次打开。
3. **依次完成五张卡片** —— 每张都显示其状态、一个主操作，以及可展开的详情/日志：
   - **Agent** —— 选择 **Hermes** 并点击 **Install Hermes**。面板会通过 pipx 安装
     `hermes-agent[acp]`、验证安装、写入路径，并提供一键重载窗口以进入实时模式。
     （OpenClaw 与 Talaria AI 显示为 *coming soon*。）你也可以在此**配置本地代理
     模型** —— 从精选集合中选择（默认 **Devstral-24B**），让 Talaria 下载并校验它，
     然后按提示前往提供方设置以完成配置。
   - **Provider** —— 点击 **Configure provider**，在终端中运行 Hermes 自带的设置向导，
     选择代理所用的对话模型/提供方。Talaria 绝不会替你强制指定某个提供方。
   - **Autocomplete (FIM)** —— 选择一个后端（Ollama / llama.cpp / vLLM / Codestral /
     OpenAI 兼容）。对可本地部署的后端，卡片会先问：**「本地安装，还是连接到现有端点？」**
     对 Ollama，它可检测守护进程并拉取默认模型（`qwen2.5-coder:1.5b-base`），带实时进度条。
     选择或下载某个模型即会**选中**它 —— 点击 **Apply** 即可将端点与模型一起保存。
   - **Next Edit** *(可选)* —— 多行下一步编辑建议。**Generic** 复用你刚设好的 FIM 模型
     （无需额外设置）；**Dedicated** 使用你在此单独设置的模型。
   - **Codebase index (RAG)** *(可选)* —— 启用本地代码索引，选择嵌入后端与模型并点击
     **Apply**（在 Ollama 上可拉取默认模型 `qwen3-embedding:0.6b`）。只有当模型确实存在于
     你配置的端点上时，*就绪* 提示才会出现。

在你安装真实后端之前，扩展会使用脚本化的 **mock** 后端，让你在不启动代理进程的情况下浏览
界面 —— 它可在任意系统运行。

### 如实说明

- **Python 与 pipx 是真实的先决条件。** 面板无法替你 `sudo`：在 Fedora 上，请先运行那条
  被提示的命令 `sudo dnf install pipx`。Hermes 需要 Python **3.11–3.13**。
- **安装 Hermes 会从 PyPI 下载约 300–500 MB** 到 `~/.local/share/pipx`。
- **模型有数 GB 之大且受硬件限制。** FIM 模型约 1 GB，嵌入约 0.7 GB，而代理的对话模型可能
  大得多。任何下载前都会显示大小，且不会自动拉取 —— 一键让*点击*变简单，却无法让下载变小或
  凭空变出 GPU。
- **llama.cpp/vLLM 的本地安装是有引导的，而非静默的。** Ollama 是干净的单脚本安装；
  llama.cpp 与 vLLM 需要你自己做构建/硬件决策，卡片对此有说明。「一键」是指：我们打开正确的
  终端命令，并把其后的一切（拉取、配置、探测）都自动化。
- **重载窗口会激活代理**（首次开启时）。

## 设置

Talaria Code 的配置只有**一个事实来源** —— `talaria.*` 的 VS Code 设置（外加用于 API
密钥的 VS Code SecretStorage）。每个界面都只是该来源的一个视图，因此**没有任何重复，每一项
设置都恰好只有一个归属。** 共有两个界面，按*设置的归属者*划分：

### Talaria Config —— 扩展自身的设置

全部 `talaria.*` 键：代理后端与 Hermes 连接、自动补全（FIM）、Next Edit，以及代码库索引
（RAG）。可用两种等价方式编辑 —— 二者写入的是同一批设置，任选其一：

- **Backend Setup 面板**（友好方式）：上面那五张卡片。
- **原生设置页** —— 运行 **`Talaria: Open Settings`** 命令，或搜索
  `@ext:syntinal.talaria-code`。它被组织为五个带标题的分区：**Backend & Agent**、
  **Autocomplete (FIM)**、**Next Edit**、**RAG (Codebase Index)** 与 **Advanced**。

你通常会用到的设置：

| 设置项 | 默认值 | 作用 |
|---|---|---|
| `talaria.backend` | `mock` | 与哪个代理后端通信。设为 `acp` 以使用真实的 Hermes 后端（Setup 面板会替你完成）。 |
| `talaria.hermesPath` | `""` | `hermes` 可执行文件的绝对路径（由安装器写入）。 |
| `talaria.pythonPath` | `""` | 用于启动真实 Hermes 后端的 Python 解释器（由安装器写入）。 |
| `talaria.cwd` | `""` | 代理的工作目录（默认取第一个工作区文件夹）。 |
| `talaria.autocomplete.enabled` | `true` | 启用行内（FIM）补全。 |
| `talaria.autocomplete.backend` | `ollama` | 提供补全服务的后端。 |
| `talaria.autocomplete.model` | `qwen2.5-coder:1.5b-base` | 用于补全的模型。 |
| `talaria.autocomplete.endpoint` | `""` | 补全后端的基础 URL（可以是你自己托管的节点）。 |
| `talaria.rag.enabled` | `true` | 启用代码库 RAG 索引与搜索。 |
| `talaria.rag.embedEndpoint` | `http://127.0.0.1:11434` | 嵌入后端的基础 URL。 |
| `talaria.rag.embedModel` | `qwen3-embedding:0.6b` | 用于嵌入代码片段的模型。 |

会重定向可执行文件或模型端点的设置为 **machine 作用域**，因此你打开的某个工作区无法悄悄改动
它们；API 密钥存于 VS Code SecretStorage，绝不以明文写入设置。完整设置见原生设置页。

### Agent Config —— Hermes 代理的运行时设置

Hermes 自身的运行时配置 —— 批准策略、最大回合数、委派、检查点、安全 —— 位于 Talaria 面板内
的 **「Agent config」** 标签页。这些是*代理*的设置（其 `config.yaml`，经由控制通道编辑），
而非 `talaria.*` 扩展设置 —— 这正是它们各有归属、绝不与 Talaria Config 界面重复的原因。

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

## 手动设置（进阶）

Backend Setup 面板并非必需 —— 它写入的一切都是普通的 `talaria.*` 设置，若你更愿意自己接线，
也可手动完成：

1. **自行安装 Hermes 代理**，例如
   `pipx install "hermes-agent[acp]==0.18.2"`（`[acp]` extra 是必需的，否则 `hermes acp`
   会在导入时失败），或使用 Hermes 自带的安装器。
2. **让扩展指向它**：把 `talaria.hermesPath` 设为 `hermes` 可执行文件，把
   `talaria.pythonPath` 设为对应的解释器。若通过 pipx 安装，二者都位于
   `~/.local/share/pipx/venvs/hermes-agent/bin/`。
3. **进入实时模式**：把 `talaria.backend` 设为 `acp` 并重载窗口。
4. **配置对话模型/提供方**，使用 Hermes 自带的向导：`hermes-acp --setup`。
5. **运行一个模型运行时**（Ollama / vLLM / llama.cpp），并把 `talaria.autocomplete.*`
   与 `talaria.rag.*` 各键设为你的端点与模型（默认：FIM `qwen2.5-coder:1.5b-base`，
   嵌入 `qwen3-embedding:0.6b`）。

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

## 发布

发布通过**推送标签（tag）**触发，由
[`.github/workflows/release.yml`](./.github/workflows/release.yml) 构建：它为每个架构
（`linux-x64` + `linux-arm64`）打包一个 `.vsix`，并将两者附加到 GitHub Release。
规则是**每次发布一个版本核（core）**：

1. **将 `package.json` 中的 `version` 提升到新的 `x.y.z`。** *每一次*发布 —— 预发布
   与稳定版一律如此 —— 都获得一个全新的核；核绝不重用。因此某条 beta 线的 GA 落在
   **下一个**号上：`0.1.x` 的 beta 先发布，其稳定版则是 `0.2.0`（即 VS Code 在
   Marketplace 使用的「奇数 minor = 预发布」约定）。
2. **合并（merge）**，然后打标签并推送：

   ```bash
   git tag v0.1.1-beta.1
   git push origin v0.1.1-beta.1
   ```

   推送标签会在两种架构上运行完整 gate（类型检查 + 测试），把每个 `.vsix`
   **按完整标签命名**（例如 `talaria-code-linux-x64-v0.1.1-beta.1.vsix`），并发布
   一个带自动生成说明的 GitHub Release。带连字符的标签（`-beta.N`、`-rc.N`）会作为
   GitHub **预发布**发布，因此绝不会显示为 *Latest*。

一个 **fail-closed 的 CI 守卫**强制执行该方案：标签的 `x.y.z` 核必须等于
`package.json` 的版本，且该核不得已被任何更早的标签发布过 —— **一个核，一个标签，
永久唯一。** 重跑*同一个*标签是允许的（它被排除在自身的唯一性检查之外），因此若构建因
无关原因失败，你可以**重跑该标签、删除它，或再次提升版本** —— 但失败的标签依然占用其
版本核。

如需在不发布的情况下预演，请手动运行该工作流（**Actions → Release → Run
workflow**）：它会构建并把两个 `.vsix` 作为工作流工件上传，但绝不创建 Release。

## 许可证

Talaria Code 采用 **GPL-3.0-or-later** 许可证。
Copyright © 2026 **Syntinal**。

你可以自由使用、研究、分享和修改本软件；若你分发修改后的版本，它必须继续以 GPL 许可。
完整文本见 [`LICENSE`](./LICENSE)，随附的第三方组件及其许可证见
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
