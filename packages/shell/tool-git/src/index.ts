/**
 * Model-facing git tool: runs git as a FIRST-CLASS sandboxed process.
 * Shell bridges (PowerShell/bash) cannot start native grandchildren under
 * the Windows ACL restricted token, so a git invocation through pwsh
 * fails regardless of the writable roots; spawning the runner with git
 * directly (no interpreter) works in every confined mode. The tool
 * therefore confines the git executable itself, keeps file effects
 * inside the sandbox policy, and supports the standard escalation
 * ladder (workspace-write to trusted-roots to full access).
 *
 * @module dsh-tool-git
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ESCALATION_TARGETS, approveEscalation, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'

/** Tool plugin config. */
export interface Config {
  /** Absolute path to git.exe; auto-detected from PATH when omitted. */
  gitPath?: string
  /**
   * Absolute path to a git global config file to force via GIT_CONFIG_GLOBAL.
   * Point it INSIDE a writable root (e.g. the dsh home) so confined git can
   * persist safe.directory and credential settings without touching the
   * user profile; the file should include.path the user's own config.
   */
  gitConfigGlobal?: string
  /** Default working directory for git invocations. */
  cwd?: string
}

export const Config: z<Config> = z.object({
  gitPath: z.string(),
  gitConfigGlobal: z.string(),
  cwd: z.string(),
})

/** Stable plugin name used by Cordis diagnostics. */
export const name = 'tool-git'

/** Services that must be available before the git tool registers. */
export const inject = ['tools', 'sandbox', 'sandboxPolicy']

/** Parse a git executable path from PATH (host side, unconfined). */
function detectGitPath(): string | undefined {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git']
  const pathDirs = (process.env.PATH ?? '').split(';').filter(Boolean)
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** Parsed tool arguments (parallel to the parameter schema). */
interface GitToolArgs {
  args: string[]
  workdir?: string
  timeoutMs?: number
  sandbox_permissions?: string
  justification?: string
}

interface GitForegroundResult {
  kind: 'foreground'
  exitCode: number | null
  timedOut: boolean
  stdout: { text: string; truncated: boolean }
  stderr: { text: string; truncated: boolean }
  sandbox?: { mode: string; denied: boolean; enforcement?: string }
}

const MAX_OUTPUT_BYTES = 64 * 1024

function truncate(buffer: Buffer): { text: string; truncated: boolean } {
  if (buffer.length <= MAX_OUTPUT_BYTES) return { text: buffer.toString('utf8'), truncated: false }
  return {
    text: buffer.subarray(0, MAX_OUTPUT_BYTES).toString('utf8') + '\n[output truncated]',
    truncated: true,
  }
}

function gitBinary(config: Config): string {
  const configured = config.gitPath
  if (configured !== undefined && configured.length > 0) return configured
  const detected = detectGitPath()
  if (detected !== undefined) return detected
  throw new Error('tool-git: git executable not found (set config gitPath)')
}

export function apply(ctx: Context, config: Config = {}): void {
  const sandbox = ctx.get('sandbox')
  const sandboxPolicy: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
  if (sandboxPolicy === undefined || sandbox === undefined) {
    throw new Error('tool-git: requires ctx.sandbox and ctx.sandboxPolicy (no confining composition)')
  }
  const escalationModes: readonly SandboxMode[] = ESCALATION_TARGETS
  const resolvePolicy = (exec: ToolExecution): SandboxExecutionPolicy | undefined =>
    sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  const description = 'Run a git command as a first-class sandboxed process and return its output. Pass the repository-relative subcommand and arguments as a plain array (no shell quoting needed). Git writes stay inside the session sandbox policy: within the workspace and the configured trusted roots (trusted-roots mode) no approval is needed; elsewhere the standard escalation applies. Long output is truncated; check [exit code: N] markers and investigate failures before moving on. ' + (escalationModes.length > 0 ? 'When a command is denied, retry once with sandbox_permissions (the narrowest wider mode that suffices) plus a one-sentence justification.' : '')

  ctx.tools.register(defineTool({
    name: 'git',
    description,
    parameters: {
      args: { type: 'array', required: true, items: { type: 'string' }, description: 'Git arguments, e.g. ["status", "--short"] or ["commit", "-m", "msg"]' },
      workdir: { type: 'string', description: 'Working directory (the repository); defaults to the session workspace.' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 600000).' },
      ...(escalationModes.length > 0 ? {
        sandbox_permissions: { type: 'string', enum: [...escalationModes], description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry after a denial.' },
        justification: { type: 'string', description: 'Required with sandbox_permissions.' },
      } : {}),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'object', required: true, additionalProperties: false, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true } } },
          stderr: { type: 'object', required: true, additionalProperties: false, properties: { text: { type: 'string', required: true }, truncated: { type: 'boolean', required: true } } },
          sandbox: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string' }, denied: { type: 'boolean' }, enforcement: { type: 'string' } } },
        },
      },
      render: (_args: GitToolArgs, value: GitForegroundResult) => {
        const body = [value.stdout.text, value.stderr.text].filter(part => part.length > 0).join('\n')
        const exit = value.exitCode === null
          ? (value.timedOut ? '[timed out]' : '[spawn failed]')
          : `[exit code: ${value.exitCode}]`
        return [{ type: 'text', text: body.length === 0 ? exit : body + '\n' + exit }]
      },
    },
    async execute(args: GitToolArgs, exec: ToolExecution) {
      validateEscalationArgs(args.sandbox_permissions, args.justification)
      if (args.args.length === 0) throw new Error('invalid args: expected at least one git argument')
      const standingPolicy = resolvePolicy(exec)
      if (standingPolicy === undefined) throw new Error('git requires a sandbox policy (no confining sandbox composed)')
      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveEscalation(
          {
            requestedMode: args.sandbox_permissions,
            justification: args.justification,
            effectiveMode: standingPolicy.mode,
            subject: 'command',
            context: { command: 'git ' + args.args.join(' '), mode: args.sandbox_permissions },
          },
          { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'git', signal: exec.signal },
        )
        : undefined
      const policy = approvedMode === undefined
        ? standingPolicy
        : { ...standingPolicy, mode: approvedMode }
      const binary = gitBinary(config)
      const argv: string[] = [binary, ...args.args]
      const timeout = Math.min(args.timeoutMs ?? 600_000, 900_000)
      const workdir = args.workdir ?? config.cwd ?? process.cwd()
      // danger-full-access runs git directly (no confinement to wrap);
      // confined modes wrap it through the sandbox runner as a FIRST-CLASS
      // process — the whole point of this tool on Windows.
      const spawnArgv: string[] = policy.mode === 'danger-full-access'
        ? argv
        : sandbox.confine(argv, policy as never).argv
      const enforcement = policy.mode === 'danger-full-access'
        ? undefined
        : (sandbox.confine(argv, policy as never).enforcement)
      const env: Record<string, string> = { ...process.env } as Record<string, string>
      if (config.gitConfigGlobal !== undefined && config.gitConfigGlobal.length > 0) {
        env.GIT_CONFIG_GLOBAL = config.gitConfigGlobal
      }
      const child = spawn(spawnArgv[0] as string, spawnArgv.slice(1), {
        cwd: workdir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'] as const,
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
      child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
      const settled = new Promise<GitForegroundResult>((resolve) => {
        const timer = setTimeout(() => {
          child.kill()
          resolve({ kind: 'foreground', exitCode: null, timedOut: true, stdout: { text: '', truncated: false }, stderr: { text: `git timed out after ${timeout}ms`, truncated: false }, sandbox: { mode: policy.mode, denied: false } })
        }, timeout)
        child.on('error', (error) => {
          clearTimeout(timer)
          resolve({ kind: 'foreground', exitCode: null, timedOut: false, stdout: { text: '', truncated: false }, stderr: { text: 'failed to start git: ' + error.message, truncated: false }, sandbox: { mode: policy.mode, denied: false } })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({
            kind: 'foreground',
            exitCode: code,
            timedOut: false,
            stdout: truncate(Buffer.concat(stdout)),
            stderr: truncate(Buffer.concat(stderr)),
            sandbox: { mode: policy.mode, denied: false, ...enforcement === undefined ? {} : { enforcement } },
          })
        })
      })
      if (exec.signal.aborted) throw new HarnessError('tool call aborted', TOOL_ABORTED)
      const result = await settled
      if (result.exitCode === null && !result.timedOut) throw new HarnessError('git failed to start', 'GIT_SPAWN_FAILED')
      return result
    },
  }))
}
