---
description: "The Windows model-facing git tool for maintainers configuring or debugging first-class Git execution through the Harness sandbox."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-git

English | [中文](README.zh.md)

## Summary

`dsh-tool-git` lets an agent run Git without routing the command through PowerShell. It confines `git.exe` directly under the active sandbox policy, which avoids the Windows restricted-token failure that prevents PowerShell from starting native child processes. Use it only with a sandbox provider and sandbox policy; the plugin waits for both services before registering the `git` tool.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the tool beside `ctx.tools`, a `ctx.sandbox` provider, and `ctx.sandboxPolicy`; Cordis delays activation until all three services are available.

### When to choose it

Choose this tool for Git operations in a confined Windows composition where a PowerShell bridge cannot start native child processes. Use the ordinary `bash` or `pwsh` tool when the command needs shell syntax or combines Git with other shell operations.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-tools'
- name: '@deepseek-ai/dsh-sandbox-local'
- name: '@deepseek-ai/dsh-session-projection'
- name: '@deepseek-ai/dsh-sandbox-policy'
- name: '@deepseek-ai/dsh-tool-git'
```

| Field | Default | Meaning |
|---|---|---|
| `gitPath` | PATH lookup | Absolute Git executable path |
| `gitConfigGlobal` | unset | Absolute file supplied as `GIT_CONFIG_GLOBAL` |
| `cwd` | process cwd | Working directory used when a call and its session do not provide one |

The table above lists every accepted configuration field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Loader retains the plugin namespace, including its `tools`, `sandbox`, and `sandboxPolicy` injections. Each call resolves the active session policy, requests a standard one-shot escalation when supplied, wraps the Git argv for confined modes, and spawns Git directly. `danger-full-access` runs the same argv without a sandbox wrapper.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin activation, Git discovery, policy resolution, process execution, and result rendering |
| [`tests/load-path.spec.ts`](tests/load-path.spec.ts) | Real Loader export and delayed-service activation regression |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Shell package map](../README.md) — adjacent shell executors and model-facing tools.
- [Sandbox subsystem](../../../docs/subsystems/sandbox.md) — policy resolution and confinement providers.
- [Cordis plugin postmortem](../../../docs/postmortem/0001-acp-default-export-drops-inject.md) — why namespace plugins cannot also export a default apply function.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`git` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-git). It accepts a plain argument array, optional working directory and timeout, and the standard escalation pair in a confining composition.

#### Token effect

The schema has a fixed cost on every request where the tool is visible.

#### KV Cache effect

The prefix remains stable while the tool definition and visibility are unchanged; changing configuration or scoped visibility can invalidate reuse from the first changed token.

### Foreground result

#### What the model sees

The result contains bounded stdout followed by bounded stderr and one terminal marker: `[exit code: <code>]`, `[timed out]`, or `[spawn failed]`.

#### Token effect

No result tokens exist before a call; each call retains at most 64 KiB from each output stream plus its marker until compaction.

#### KV Cache effect

Results append after the reusable request prefix and do not invalidate existing entries.

### Tool errors

#### What the model sees

Activation fails with `tool-git: requires ctx.sandbox and ctx.sandboxPolicy (no confining composition)` when called directly without its required services. Calls reject empty argument arrays, unavailable Git executables, invalid escalation pairs, approval failures, aborts, and spawn failures with explicit diagnostics.

#### Token effect

Only the failed activation or call adds diagnostic tokens.

#### KV Cache effect

Call diagnostics append after the reusable request prefix; activation failures prevent the tool from entering a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints determine when another execution tool is a better fit.

- **Foreground execution only** — long Git commands cannot become managed background jobs through this tool.
- **No shell composition** — arguments are passed directly to Git, so pipes, redirection, environment assignment, and compound shell commands require `bash` or `pwsh`.
- **Confining composition required** — the plugin refuses to activate without both sandbox services, even when every intended call would request `danger-full-access`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
