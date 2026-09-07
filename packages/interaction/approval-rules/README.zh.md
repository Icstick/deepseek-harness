---
description: "面向部署 dsh 的维护者的会话级审批规则：在 GUI 应答者介入前匹配结构化提权请求的用户授权自动放行条目。"
kind: "package-reference"
---

# @deepseek-ai/dsh-approval-rules

[English](README.md) | 中文

## 概述

`dsh-approval-rules` 让用户为当前会话的剩余时间授权可重复的审批。一条规则授予与交互式审批相同的一次性提权，上限为 `trusted-roots`——规则永远不会自动授予 `danger-full-access`。规则以仅日志的 `approval/rules` 事件追加到会话日志，恢复的会话从自身日志重放；它们从不进入模型 transcript。只有用户能创建规则（`/permission-rule` 命令）；模型无法自行授权，且 `never` 审批策略仍会在此层运行前拒绝每个请求。

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

将插件与 `@deepseek-ai/dsh-user-approval` 一起挂载；它会在 `ctx.approvalRules` 上注册规则服务、应答者之前的匹配器以及 `/permission-rule` 命令。随附的 base bundle 将其接线在 user-approval 之后。

### 何时选择

当部署希望用户一次性批准重复操作——例如"本会话内始终允许在此目录下写入"——而不是每次回答相同的提权请求时，选择本包。它是审批 seam 之上的产品层便利：任何规则未匹配的请求仍会走应答者。

### 最小配置

插件不接收任何配置。挂载了 user-approval 的组合可以无 `config:` 块地加入规则层：

```yaml
- name: '@deepseek-ai/dsh-user-approval'
- name: '@deepseek-ai/dsh-approval-rules'
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

每个提权请求都会在 GUI 应答者介入之前与会话当前规则匹配。没有结构化上下文的请求永不匹配——自由文本理由不是规则材料。所有侧面必须一致：工具族（`path-root` 为 `write`/`edit`，`command-prefix` 为 `bash`/`pwsh`/`git`）、模式上限（`context.mode` 必须等于规则的授予值，因此规则不会静默升级更窄的请求）以及目标包含关系（位于规则目录之下、按平台键且容忍 cwd 的路径）或命令前缀。匹配的请求会追加仅日志的 `approval/rule-hit` 事件并以 `'allowed-once'` 完成。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 规则服务、匹配器、`/permission-rule` 命令、路径包含 |
| [`src/invariant.ts`](src/invariant.ts) | 包自有会话事件不变量伴生插件 |
| [`tests/approval-rules.spec.ts`](tests/approval-rules.spec.ts) | 服务、匹配器、命令与不变量行为 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [interaction 包地图](../README.zh.md) —— 人机协作平面。
- [approval 子系统](../../../docs/subsystems/approval.zh.md) —— 请求生命周期、waterfall 与审计事件。
- [sandbox 子系统](../../../docs/subsystems/sandbox.zh.md) —— 模式、提权上下文与 `trusted-roots`。

-----

<a id="model-experience"></a>
## 模型体验

### 提权结果

#### 模型看到什么

规则匹配的提权会以已批准的工具调用（`'allowed-once'`）完成，无需交互提问，并追加一条永不进入模型 transcript 的仅日志 `approval/rule-hit` 审计事件。规则内容保持不可见：`approval/rules` 事件仅日志且位于 transcript 之外；运行时上下文快照的审批策略贡献不受本包影响。`/permission-rule` 命令是用户作用域的；模型即使调用也毫无所得。

#### Token 影响

本包不注册任何提示词、工具 schema 或结果渲染器：规则事件从不向模型请求增加 token。

#### KV Cache 影响

可复用请求前缀不受影响，因为本包不注册任何模型可见的提示词、schema 或工具；匹配的调用走普通已批准调用路径渲染。

### 未匹配的提权

#### 模型看到什么

规则未匹配的请求与包存在之前完全一致：组合好的审批 waterfall 会询问其应答者，模型看到的是调用方派生的工具结果与运行时上下文快照。

#### Token 影响

只有普通的审批提问流程会增加 token。

#### KV Cache 影响

无额外前缀贡献；waterfall 现有的提问文本仍追加在可复用前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- v1 授予固定为 `trusted-roots`。规则永远不会自动授予 `danger-full-access`；该模式始终是显式的逐操作人工决定。
- `command-prefix` 规则按字面前缀约束整个 shell 调用，无法约束单个文件目标；文件系统 fence 只查阅 `path-root` 规则（`matchesPath`）。
- 规则是会话级的，并从会话日志重放；新会话以空规则集开始。
- `path-root` 包含关系基于规范化平台键的前缀比较——共享文本前缀的兄弟目录（如 `a/b` 与 `a/bc`）不会被混淆，但父目录的规则会按设计覆盖其整个子树。

<a id="dev-note"></a>
### 开发备注

本包携带两个 Cordis 插件：服务插件（`name: 'approval-rules'`）与不变量伴生插件（`name: 'approval-rules-invariant'`，注入 `invariants`），后者将重放的 `approval/rules` 事件作为不可信数据校验——其 source 检查刻意越过静态联合。修改规则事件的 source 或形状时，需同步改动 fold（`rulesOf`）、写入路径（`appendRules`）与不变量，并保持 `approval/rule-hit` 审计事件只追加。
