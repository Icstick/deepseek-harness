/**
 * Minimal tool-git surface tests: registration shape, escalation-field
 * advertisement, and argument validation. Real confined execution is
 * covered by integration smoke (the sandbox runner spawns git directly).
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as ToolGit from '@deepseek-ai/dsh-tool-git'

/** The compiled registration surface the assertions read. */
interface CompiledTool {
  name: string
  parameters: {
    type: string
    required: string[]
    properties: {
      args: { items: { type: string } }
      sandbox_permissions?: { enum: string[] }
    }
  }
  execute: (args: { args: string[] }, exec: unknown) => Promise<unknown>
}

function policyCtx(): { ctx: Context; tool: CompiledTool | undefined } {
  let tool: CompiledTool | undefined
  const sandbox = { confine: (_argv: readonly string[], _policy: unknown) => ({ argv: ['runner'], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }) }
  const sandboxPolicy = { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'C:/ws' }) }
  const ctx = {
    get: (name: string) => name === 'sandbox' ? sandbox : name === 'sandboxPolicy' ? sandboxPolicy : undefined,
    tools: { register: (registered: CompiledTool) => { tool = registered } },
  } as unknown as Context
  return { ctx, get tool() { return tool } }
}

describe('tool-git registration', () => {
  it('refuses to load without a confining composition', () => {
    const ctx = { get: () => undefined, tools: { register: () => {} } } as unknown as Context
    expect(() => {
      ToolGit.apply(ctx, {})
    }).toThrow(/requires ctx.sandbox and ctx.sandboxPolicy/)
  })

  it('registers the git tool and advertises the escalation ladder', () => {
    const host = policyCtx()
    ToolGit.apply(host.ctx, {})
    const tool = host.tool
    expect(tool).toBeDefined()
    if (tool === undefined) throw new Error('tool was not registered')
    // defineTool compiles the parameter DSL into a JSON Schema root.
    expect(tool.parameters.type).toBe('object')
    expect(tool.parameters.required).toContain('args')
    expect(tool.parameters.properties.args.items).toMatchObject({ type: 'string' })
    expect(tool.parameters.properties.sandbox_permissions?.enum)
      .toEqual(['workspace-write', 'trusted-roots', 'danger-full-access'])
    expect(tool.execute).toBeTypeOf('function')
  })

  it('rejects empty args', async () => {
    const host = policyCtx()
    ToolGit.apply(host.ctx, {})
    expect(host.tool).toBeDefined()
    const exec = { agent: undefined, callId: 'c', signal: new AbortController().signal }
    await expect(host.tool!.execute({ args: [] }, exec)).rejects.toThrow(/at least one git argument/)
  })
})
