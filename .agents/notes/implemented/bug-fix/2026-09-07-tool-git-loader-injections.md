# Agent Note: Preserving tool-git Loader injections

Status: implemented

English | [中文](2026-09-07-tool-git-loader-injections.zh.md)

## Problem

`dsh-tool-git` needs `ctx.tools`, `ctx.sandbox`, and `ctx.sandboxPolicy` before activation. A default `apply` export made the Loader unwrap the package to a bare function, and the package declared no injections, so profile startup could execute it before its confining services existed and fail with `tool-git: requires ctx.sandbox and ctx.sandboxPolicy (no confining composition)`.

## Decision

The package is a namespace function plugin with named `name`, `inject`, `Config`, and `apply` exports and no default export. Its injection list contains `tools`, `sandbox`, and `sandboxPolicy`, so Cordis delays tool registration until the complete confining composition is available.

The direct runtime check remains. It gives manual callers that bypass Cordis activation a specific failure instead of registering an unconfined Git executor.

## Alternatives considered

**Keep the default export and attach properties to the function.** Rejected because it creates a package-specific Loader representation and bypasses the repository's namespace-plugin convention.

**Retry service lookup after activation.** Rejected because delayed lookup would let an incomplete plugin appear loaded and move a deterministic composition failure into the first model call.

**Treat sandbox services as optional in danger-full-access mode.** Rejected because activation cannot predict every session's effective policy, and the package exists to provide a consistently confined Git path.

## Consequences

Profile row order does not determine tool-git activation. The plugin loads before or after its providers in configuration and registers only after all required services exist.

A real Loader-unwrapping regression test rejects any future default export, pins the injection list, mounts tool-git before its providers, and observes successful delayed registration. The original `pnpm dsh web` startup path verifies the assembled profile.
