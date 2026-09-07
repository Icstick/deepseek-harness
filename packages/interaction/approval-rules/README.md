---
description: "Session-scoped approval rules for maintainers deploying dsh: user-authorized auto-allow entries that match structured escalations before any GUI answerer is asked."
kind: "package-reference"
---

# @deepseek-ai/dsh-approval-rules

English | [中文](README.zh.md)

## Summary

`dsh-approval-rules` lets the user authorize repeatable approvals for the rest of one session. A rule grants the same one-shot escalation an interactive approval would have, with a ceiling of `trusted-roots` — a rule never auto-grants `danger-full-access`. Rules are appended to the session log as log-only `approval/rules` events, so a resumed session replays them from its own log; they never enter the model transcript. Only the user can create rules (the `/permission-rule` command); the model cannot self-authorize, and the `never` approval policy still rejects every ask before this layer runs.

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

Mount the plugin beside `@deepseek-ai/dsh-user-approval`; it registers the rule service on `ctx.approvalRules`, the pre-answerer matcher, and the `/permission-rule` command. The shipped base bundle wires it after user-approval.

### When to choose it

Choose this package when a deployment wants the user to approve a repeated operation once — e.g. "always allow writes under this directory for this session" — instead of answering the same escalation every time. It is a product-layer convenience on top of the approval seam: answerers still run for anything a rule does not match.

### Minimal configuration

The plugin takes no configuration. A composition that mounts user-approval may add the rule layer with no `config:` block:

```yaml
- name: '@deepseek-ai/dsh-user-approval'
- name: '@deepseek-ai/dsh-approval-rules'
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each escalation request is matched against the session's current rules BEFORE any GUI answerer is asked. A request without structured context never matches — free-form reasons are not rule material. All facets must align: the tool family (`write`/`edit` for `path-root`, `bash`/`pwsh`/`git` for `command-prefix`), the mode ceiling (`context.mode` must equal the rule's grant, so a rule never silently upgrades a narrower ask), and the target containment (path under the rule directory, platform-keyed and cwd-tolerant) or command prefix. A matched request appends a log-only `approval/rule-hit` event and resolves `'allowed-once'`.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Rule service, matcher, `/permission-rule` command, path containment |
| [`src/invariant.ts`](src/invariant.ts) | Package-owned session-event invariant companion |
| [`tests/approval-rules.spec.ts`](tests/approval-rules.spec.ts) | Service, matcher, command, and invariant behavior |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [interaction package map](../README.md) — the human-collaboration plane.
- [approval subsystem](../../../docs/subsystems/approval.md) — request lifecycle, waterfall, and audit events.
- [sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, escalation context, and `trusted-roots`.

-----

<a id="model-experience"></a>
## Model Experience

### Escalation outcomes

#### What the model sees

A rule-matched escalation resolves as an approved tool call (`'allowed-once'`) without an interactive question, and appends a log-only `approval/rule-hit` audit event that never enters the model transcript. Rule content stays invisible: `approval/rules` events are log-only and outside the transcript, and the runtime-context snapshot's approval-policy contribution is unchanged by this package. The `/permission-rule` command is user-scoped; a model that invokes it gains nothing.

#### Token effect

No prompt, tool schema, or result renderer is registered: rule events never add tokens to a model request.

#### KV Cache effect

The reusable request prefix is unaffected because the package registers no model-visible prompt, schema, or tool; matched calls render through the ordinary approved-call path.

### Non-matching escalations

#### What the model sees

Requests a rule does not match behave exactly as before the package existed: the composed approval waterfall asks its answerers, and the model sees the caller's derived tool result plus the runtime-context snapshot.

#### Token effect

Only the ordinary approval-question flow adds tokens.

#### KV Cache effect

No additional prefix contribution; the waterfall's existing question text still appends after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- v1 grants are fixed at `trusted-roots`. A rule never auto-grants `danger-full-access`; that mode stays an explicit per-operation human decision.
- `command-prefix` rules gate whole shell calls by literal prefix and cannot gate individual file targets; the filesystem fence consults only `path-root` rules (`matchesPath`).
- Rules are session-scoped and replay from the session log; a new session starts with an empty rule set.
- `path-root` containment is prefix-based on canonical platform keys — sibling directories sharing a textual prefix (e.g. `a/b` and `a/bc`) are not confused, but a rule for a parent directory intentionally covers its whole subtree.

<a id="dev-note"></a>
### Dev Note

The package ships two Cordis plugins: the service plugin (`name: 'approval-rules'`) and the invariant companion (`name: 'approval-rules-invariant'`, injects `invariants`), which validates replayed `approval/rules` events as untrusted data — its source check widens past the static union on purpose. Change the source or shape of rule events in both the fold (`rulesOf`), the write path (`appendRules`), and the invariant, and keep the `approval/rule-hit` audit event append-only.
