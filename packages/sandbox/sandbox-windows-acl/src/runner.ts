/**
 * The windows-acl confinement runner: the argv-prefix wrapper the sandbox
 * seam spawns in place of the caller's command. It creates the
 * WRITE_RESTRICTED token with the workspace write-SID allowlist, spawns the
 * wrapped argv under it with the CALLER'S stdio inherited (bytes flow
 * straight through), mirrors the child's exit code, and revokes its temp
 * grant on exit (workspace ACEs stay standing as the reuse cache).
 *
 * Stable argv contract (the seam builds it; a native-exe replacement would
 * keep the same contract):
 *   [node, runner.js, '--workspace', <dir>, '--temp', <dir>,
 *    '--mode', <read-only|workspace-write|trusted-roots>,
 *    ['--write-sid', <S-1-4-…>,
 *     '--temp-write-sid', <S-1-4-…>,
 *     '--trusted-sid', <S-1-4-…-2>, '--trusted-dir', <dir>, …],
 *    '--', <argv...>]
 *
 * Modes:
 *  - workspace-write: the workspace and temp directories carry distinct
 *    capability-SID Write grants; other ACL-addressable writes are denied
 *    except for the documented Everyone and hard-link boundaries.
 *  - trusted-roots: workspace-write's grants PLUS the fixed trusted-roots
 *    capability SID standing on every --trusted-dir extra root.
 *  - read-only: no capability-SID grants; the restricting list carries no
 *    capability SID, so a standing grant ACE from an earlier
 *    workspace-write/trusted-roots period stays inert. ALL confined modes
 *    drop Authenticated Users (CIM unavailable — documented in README) and
 *    INTERACTIVE/LOCAL (the Public tree writes are denied); the lists share
 *    the keep-alive group (logon SID, EVERYONE) and differ only by the
 *    capabilities.
 *
 * `--write-sid` + `--temp-write-sid`: the seam's grant contract — the
 * CALLER has already materialized distinct workspace and private-temp ACEs
 * and owns their revocation, so the runner neither grants nor revokes
 * (`manageDacls: false`). Both values are checked against their owning paths.
 * Without the pair (standalone/agentless use), workspace-write treats
 * `--temp` as a ROOT, creates a random private child directory, derives its
 * own temp SID, and removes that directory after the child exits. In both
 * flows the runner rewrites TMP/TEMP in its OWN environment to the private
 * directory before spawning; the child inherits that block (`lpEnvironment`
 * NULL; an explicit block through koffi trips ERROR_INVALID_PARAMETER in
 * CreateProcessAsUserW, verified empirically). Read-only leaves the ambient
 * temp entries untouched (writes there are denied anyway).
 *
 * Failure contract: every runner-side failure (bad args, missing
 * directories, token/grant/spawn errors) prints `windows-acl-run: <detail>`
 * to stderr and exits 127 — the seam's RUNNER_FAILURE_RULES matches that
 * signature. The child is NEVER spawned unrestricted.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/runner
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { win32 } from './ffi.ts'
import { AclSandbox, assertTempRootOutsideWorkspace } from './index.ts'
import { tempWriteSid, trustedRootsWriteSid, workspaceWriteSid } from './workspace-sid.ts'

const RUNNER_SIGNATURE = 'windows-acl-run'
const RUNNER_FAILURE_EXIT = 127

class RunnerFailure extends Error {}

/** Print the runner-failure signature line and unwind. */
function fail(detail: string): never {
  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`)
  throw new RunnerFailure(detail)
}

interface ParsedArgs {
  workspace: string
  temp: string
  mode: 'read-only' | 'workspace-write' | 'trusted-roots'
  writeSid: string | undefined
  tempWriteSid: string | undefined
  trustedSid: string | undefined
  trustedDirs: string[]
  command: string
  args: string[]
}

function parseArgs(raw: string[]): ParsedArgs {
  let workspace: string | undefined
  let temp: string | undefined
  let mode: string | undefined
  let writeSid: string | undefined
  let parsedTempWriteSid: string | undefined
  let trustedSid: string | undefined
  const trustedDirs: string[] = []
  let index = 0
  for (; index < raw.length; index++) {
    const token = raw[index]
    if (token === '--') {
      index++
      break
    }
    index++
    const value = raw[index]
    if (value === undefined) fail(`missing value after ${token}`)
    switch (token) {
      case '--workspace': workspace = value; break
      case '--temp': temp = value; break
      case '--mode': mode = value; break
      case '--write-sid': writeSid = value; break
      case '--temp-write-sid': parsedTempWriteSid = value; break
      case '--trusted-sid': trustedSid = value; break
      case '--trusted-dir': trustedDirs.push(value); break
      default: fail(`unknown argument: ${token}`)
    }
  }
  if (workspace === undefined) fail('missing --workspace')
  if (temp === undefined) fail('missing --temp')
  if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'trusted-roots') fail(`unknown mode: ${String(mode)}`)
  const argv = raw.slice(index)
  const command = argv[0]
  if (command === undefined) fail('missing command after --')
  return { workspace, temp, mode, writeSid, tempWriteSid: parsedTempWriteSid, trustedSid, trustedDirs, command, args: argv.slice(1) }
}

function requireDirectory(label: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} is not an existing directory: ${path}`)
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  // Both directories are validated in both modes: a provider bug that passes
  // a bogus root must fail loudly at the runner boundary, never mid-child.
  requireDirectory('--workspace', parsed.workspace)
  requireDirectory('--temp', parsed.temp)

  const seamManaged = parsed.writeSid !== undefined || parsed.tempWriteSid !== undefined || parsed.trustedSid !== undefined
  if (parsed.mode === 'read-only' && seamManaged) {
    fail('read-only does not accept --write-sid, --temp-write-sid or --trusted-sid')
  }
  const confinedWrite = parsed.mode === 'workspace-write' || parsed.mode === 'trusted-roots'
  if (confinedWrite && (parsed.writeSid === undefined) !== (parsed.tempWriteSid === undefined)) {
    fail(`${parsed.mode} requires --write-sid and --temp-write-sid together`)
  }
  // trusted-roots without extra roots is legitimate: it degenerates to
  // workspace-write (nothing extra to grant). Only a half-pair (SID without
  // dirs, or dirs without SID) is a seam bug and fails closed.
  if (parsed.mode === 'trusted-roots' && (parsed.trustedSid === undefined) !== (parsed.trustedDirs.length === 0)) {
    fail('trusted-roots requires --trusted-sid together with at least one --trusted-dir')
  }
  if (parsed.mode !== 'trusted-roots' && (parsed.trustedSid !== undefined || parsed.trustedDirs.length > 0)) {
    fail(`${parsed.mode} does not accept --trusted-sid or --trusted-dir`)
  }
  if (parsed.trustedSid !== undefined && parsed.trustedSid !== trustedRootsWriteSid()) {
    fail('--trusted-sid does not match the fixed trusted-roots SID')
  }
  if (confinedWrite) {
    assertTempRootOutsideWorkspace(parsed.workspace, parsed.temp)
  }
  for (const dir of parsed.trustedDirs) requireDirectory('--trusted-dir', dir)

  const api = await win32()
  // Ignore this process's own CTRL+C: the confined child (same console) keeps
  // handling its own; the runner must survive to revoke grants and mirror the
  // child's exit code.
  if (api.setConsoleCtrlHandler(null, 1) === 0) {
    fail(`SetConsoleCtrlHandler failed (Win32 ${api.getLastError()})`)
  }

  let ownedTempDir: string | undefined
  let sandbox: AclSandbox | undefined
  let initialized = false
  try {
    let privateTempDir: string | null = null
    let writeSid: string | undefined
    let privateTempSid: string | undefined
    let trustedSid: string | undefined
    const confinedWrite = parsed.mode === 'workspace-write' || parsed.mode === 'trusted-roots'
    if (confinedWrite) {
      writeSid = workspaceWriteSid(parsed.workspace)
      if (seamManaged) {
        if (parsed.writeSid !== writeSid) fail('--write-sid does not match --workspace')
        privateTempDir = parsed.temp
        privateTempSid = tempWriteSid(privateTempDir)
        if (parsed.tempWriteSid !== privateTempSid) fail('--temp-write-sid does not match --temp')
      } else {
        ownedTempDir = mkdtempSync(join(parsed.temp, 'dsh-'))
        privateTempDir = ownedTempDir
        privateTempSid = tempWriteSid(privateTempDir)
      }
    }
    if (parsed.mode === 'trusted-roots') {
      // The fixed SID is identical whether the seam pre-granted the
      // extra-root ACEs (manageDacls: false) or this runner grants them
      // itself, so the standalone path derives it instead of requiring it.
      trustedSid = parsed.trustedSid ?? trustedRootsWriteSid()
    }
    sandbox = new AclSandbox({
      writableDirs: confinedWrite ? [parsed.workspace] : [],
      trustedDirs: parsed.mode === 'trusted-roots' ? parsed.trustedDirs : [],
      tempDir: privateTempDir,
      mode: parsed.mode,
      ...writeSid === undefined ? {} : { writeSid },
      ...privateTempSid === undefined ? {} : { tempWriteSid: privateTempSid },
      ...trustedSid === undefined ? {} : { trustedWriteSid: trustedSid },
      manageDacls: !seamManaged,
    })
    await sandbox.init()
    initialized = true

    if (privateTempDir !== null) {
      if (api.setEnvironmentVariableW('TMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TMP failed (Win32 ${api.getLastError()})`)
      }
      if (api.setEnvironmentVariableW('TEMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TEMP failed (Win32 ${api.getLastError()})`)
      }
    }

    const child = sandbox.spawn({
      command: parsed.command,
      args: parsed.args,
      stdio: 'inherit',
    })
    const result = await child.wait()
    return result.exitCode
  } finally {
    // Cleanup failures must not mask the child's exit code: report and keep going.
    if (initialized) {
      try {
        sandbox?.dispose()
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    if (ownedTempDir !== undefined) {
      try {
        rmSync(ownedTempDir, { recursive: true, force: true })
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }
}

main().then(
  (exitCode) => {
    // Exit-code mirroring is full-width on Windows, verified empirically on
    // this machine (Windows 11 build 26200, Node 24): a child that exits
    // with the NTSTATUS 0xC0000005 (STATUS_ACCESS_VIOLATION) is read back
    // by GetExitCodeProcess as the uint32 3221225477, and after
    // process.exitCode = 3221225477 the parent observes exactly
    // 3221225477 (spawnSync status). PowerShell's $LASTEXITCODE and cmd
    // print the signed view (-1073741819), but no truncation or masking
    // happens anywhere in the chain — the mirror contract holds for the
    // full 32-bit range, so no re-mapping is needed.
    process.exitCode = exitCode
  },
  (error: unknown) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(`${RUNNER_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = RUNNER_FAILURE_EXIT
  },
)
