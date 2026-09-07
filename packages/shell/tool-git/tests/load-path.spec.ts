/**
 * Real-load-path guard for @deepseek-ai/dsh-tool-git. The Loader unwraps a
 * module to its default export when one exists, so function plugins with
 * service injections must expose only their namespace exports.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as toolGit from '@deepseek-ai/dsh-tool-git'

class PassthroughSandbox extends SandboxProvider {
  confine(argv: readonly string[], _policy: SandboxPolicy): ConfinedArgv {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

describe('dsh-tool-git real-load-path guard', () => {
  it('keeps name, inject, Config, and apply through Loader unwrapping', () => {
    expect('default' in toolGit).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolGit) as Record<string, unknown>
    expect(unwrapped).toBe(toolGit)
    expect(unwrapped.name).toBe('tool-git')
    expect(unwrapped.inject).toEqual(['tools', 'sandbox', 'sandboxPolicy'])
    expect(typeof unwrapped.Config).toBe('function')
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('waits for its confining services when loaded before them', async () => {
    const ctx = new Context()
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolGit) as Parameters<Context['plugin']>[0]
    const toolFiber = ctx.plugin(unwrapped, {})

    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(PassthroughSandbox)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: process.cwd() })
    await toolFiber

    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('git')
    await toolFiber.dispose()
    await ctx.fiber.dispose()
  })
})
