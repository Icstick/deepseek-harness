---
description: "面向维护者的 Windows 模型侧 git 工具说明，用于配置或排查通过 Harness 沙箱直接执行 Git。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-git

[English](README.md) | 中文

## 概述

`dsh-tool-git` 让 agent 无需经由 PowerShell 即可运行 Git。它按照生效的沙箱策略直接约束 `git.exe`，避开 Windows 受限令牌阻止 PowerShell 启动原生子进程的问题。该工具只能与 sandbox provider 和 sandbox policy 一起使用；插件会等待两项服务就绪后再注册 `git` 工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将该工具与 `ctx.tools`、一个 `ctx.sandbox` provider 以及 `ctx.sandboxPolicy` 一起挂载；Cordis 会延迟激活，直到三项服务全部可用。

### 何时选择

当受限 Windows 组合中的 PowerShell 桥接无法启动原生子进程时，选择该工具执行 Git 操作。当命令需要 shell 语法，或要把 Git 与其他 shell 操作组合时，使用普通的 `bash` 或 `pwsh` 工具。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-tools'
- name: '@deepseek-ai/dsh-sandbox-local'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-sandbox-policy'
- name: '@deepseek-ai/dsh-tool-git'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `gitPath` | PATH 查找 | Git 可执行文件的绝对路径 |
| `gitConfigGlobal` | 未设置 | 作为 `GIT_CONFIG_GLOBAL` 提供的绝对文件路径 |
| `cwd` | 进程 cwd | 调用及其 session 均未提供工作目录时使用的目录 |

上表列出了全部可接受的配置字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Loader 会保留插件命名空间及其 `tools`、`sandbox` 和 `sandboxPolicy` 注入。每次调用都会解析生效的 session 策略，在提供升权参数时请求标准单次升权，为受限模式包装 Git argv，并直接 spawn Git。`danger-full-access` 使用相同 argv，但不经过沙箱包装。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件激活、Git 探测、策略解析、进程执行与结果渲染 |
| [`tests/load-path.spec.ts`](tests/load-path.spec.ts) | 真实 Loader 导出与延迟服务激活回归 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Shell 包映射](../README.zh.md)——相邻 shell 执行器与面向模型的工具。
- [Sandbox 子系统](../../../docs/subsystems/sandbox.zh.md)——策略解析与约束 provider。
- [Cordis 插件事后分析](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)——为什么命名空间插件不能同时导出默认 apply 函数。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型会看到生成的 [`git` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-git)。它接受普通参数数组、可选工作目录与超时，并在受限组合中接受标准升权参数对。

#### Token 影响

工具可见的每个请求都会产生固定 schema 开销。

#### KV Cache 影响

只要工具定义和可见性不变，前缀就保持稳定；配置或 scope 可见性变化可能从首个变化的 token 起使复用失效。

### 前台结果

#### 模型看到什么

结果包含设界的 stdout、随后设界的 stderr，以及一个终止标记：`[exit code: <code>]`、`[timed out]` 或 `[spawn failed]`。

#### Token 影响

调用前不存在结果 token；每次调用会保留每条输出流最多 64 KiB 的内容及其标记，直到压缩。

#### KV Cache 影响

结果追加在可复用请求前缀之后，不会使现有条目失效。

### 工具错误

#### 模型看到什么

直接调用且缺少必需服务时，激活会以 `tool-git: requires ctx.sandbox and ctx.sandboxPolicy (no confining composition)` 失败。空参数数组、不可用的 Git 可执行文件、无效升权参数对、审批失败、中止和 spawn 失败都会产生明确诊断。

#### Token 影响

只有失败的激活或调用会增加诊断 token。

#### KV Cache 影响

调用诊断追加在可复用请求前缀之后；激活失败会阻止该工具进入模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些约束决定何时应选择其他执行工具。

- **仅前台执行**——长时间 Git 命令无法通过本工具成为受管后台任务。
- **不支持 shell 组合**——参数直接传给 Git，因此管道、重定向、环境变量赋值和复合 shell 命令需要 `bash` 或 `pwsh`。
- **必须受限组合**——缺少任一 sandbox 服务时插件都会拒绝激活，即使所有预期调用都会请求 `danger-full-access`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
