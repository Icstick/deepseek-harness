# Agent Note: 保留 tool-git Loader 注入

Status: implemented

[English](2026-09-07-tool-git-loader-injections.md) | 中文

## 问题

`dsh-tool-git` 激活前需要 `ctx.tools`、`ctx.sandbox` 和 `ctx.sandboxPolicy`。默认 `apply` 导出使 Loader 把包解包成裸函数，且包没有声明注入，因此 profile 启动可能在约束服务存在前执行它，并以 `tool-git: requires ctx.sandbox and ctx.sandboxPolicy (no confining composition)` 失败。

## 决策

该包是命名空间函数插件，只导出具名的 `name`、`inject`、`Config` 与 `apply`，不提供默认导出。其注入列表包含 `tools`、`sandbox` 和 `sandboxPolicy`，因此 Cordis 会延迟工具注册，直到完整约束组合可用。

直接运行时检查仍然保留。它让绕过 Cordis 激活的手动调用方获得明确失败，而不是注册一个不受约束的 Git 执行器。

## 考虑过的替代方案

**保留默认导出并把属性附加到函数。** 不予采纳，因为这会创建包专属的 Loader 表示，并绕过仓库的命名空间插件约定。

**激活后重试服务查找。** 不予采纳，因为延迟查找会让不完整插件看似已经加载，并把确定性的组合失败推迟到首次模型调用。

**在 danger-full-access 模式下把 sandbox 服务设为可选。** 不予采纳，因为激活无法预测每个 session 的生效策略，且该包的目的就是提供始终一致受限的 Git 路径。

## 后果

Profile 行顺序不决定 tool-git 激活。无论插件在配置中位于 provider 前后，它只在全部必需服务存在后注册。

真实 Loader 解包回归测试会拒绝未来的默认导出，固定注入列表，在 provider 之前挂载 tool-git，并观察成功延迟注册。原始 `pnpm dsh web` 启动路径验证组装后的 profile。
