/**
 * Session-scoped approval rules: user-authorized auto-allow entries matched
 * against the STRUCTURED escalation context (target path or command text,
 * see dsh-sandbox EscalationContext) BEFORE any GUI answerer is asked.
 * A rule grants the same one-shot mode an interactive approval would have
 * (ceiling: trusted-roots — rules never auto-grant danger-full-access),
 * for the rest of the session that created it. Rules are appended to the
 * session log as log-only 'approval/rules' events, so a resumed session
 * replays them from its own log; they never enter the model transcript.
 * Only the user can create rules (the /permission-rule command); the model
 * cannot self-authorize. The 'never' approval policy still rejects every
 * ask before this layer runs, so rules are inert under never.
 *
 * @module dsh-approval-rules
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
// Side-effect type import: merges the approval Events map and agent typing
// so ctx.on('approval/request') and session event folds type-check.
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'

/**
 * The closed tool vocabulary a rule may gate. Fs tools match by target
 * path; shell tools match by command prefix.
 */
export const RULE_TOOLS = ['write', 'edit', 'bash', 'pwsh', 'git'] as const

export type RuleTool = typeof RULE_TOOLS[number]

export type RuleKind = 'path-root' | 'command-prefix'

/**
 * One session-scoped approval rule. Immutable after creation: mutating a
 * rule is a remove followed by an add.
 */
export interface ApprovalRule {
  /** Stable id minted at creation (uuid). */
  readonly id: string
  /** The tool family the rule gates. */
  readonly tool: RuleTool
  /** Match semantics: 'path-root' contains the fs target; 'command-prefix' prefixes the shell text. */
  readonly kind: RuleKind
  /** Absolute directory for path-root, or the literal command prefix for command-prefix. */
  readonly match: string
  /**
   * The granted mode ceiling. Fixed to trusted-roots in v1: a rule never
   * auto-grants danger-full-access — that mode stays an explicit
   * per-operation human decision.
   */
  readonly mode: 'trusted-roots'
  readonly createdAt: number
}

/** The structured request face the matcher needs (subset of the approval request). */
interface RuleRequestFace {
  toolName: string
  context?: { path?: string; command?: string; mode?: string }
}

/** Platform-aware prefix containment: canonical spelling on Windows is case-insensitive. */
function pathKey(path: string): string {
  const key = path
  return process.platform === 'win32' ? key.toLowerCase() : key
}

/**
 * Path containment for a path-root rule: whether `target` sits under the
 * rule's directory (platform-keyed, absolute-against-cwd tolerant). Shared
 * by the escalation matcher and the fence-level write check.
 */
export function pathRootContains(rule: ApprovalRule, target: string): boolean {
  if (rule.kind !== 'path-root') return false
  const root = pathKey(isAbsolute(rule.match) ? rule.match : resolve(rule.match))
  const path = pathKey(resolve(target))
  return path === root || path.startsWith(root + sep) || path.startsWith(root + '/')
}

/**
 * Whether one escalation request matches one rule. All facets must align:
 * the tool family, the mode ceiling (context.mode must equal the rule's
 * grant — no rule silently upgrades a narrower ask), and the target
 * containment (fs) or command prefix (shell). Requests without structured
 * context never match — free-form reasons are not rule material.
 */
export function matchesRule(rule: ApprovalRule, request: RuleRequestFace): boolean {
  const context = request.context
  if (context === undefined || context.mode !== rule.mode) return false
  if (rule.kind === 'path-root') {
    if (rule.tool !== 'write' && rule.tool !== 'edit') return false
    if (request.toolName !== rule.tool) return false
    const target = context.path
    if (target === undefined) return false
    return pathRootContains(rule, target)
  }
  if (rule.tool !== 'bash' && rule.tool !== 'pwsh' && rule.tool !== 'git') return false
  if (request.toolName !== rule.tool) return false
  const command = context.command
  return command !== undefined && command.startsWith(rule.match)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    approvalRules: ApprovalRuleService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's current approval-rule set (full replacement, log-only,
     * never in the model transcript). The LAST event is authoritative; the
     * fold reads backwards from the log tail. `source: 'delegation'` marks a
     * snapshot copied onto a child at delegation, mirroring the approval
     * policy and sandbox mode seeds.
     */
    'approval/rules': {
      rules: readonly ApprovalRule[]
      source?: 'user' | 'delegation'
    }
    /**
     * One auto-allow decision made by a rule (log-only audit trail linking
     * the paired approval/asked + approval/decided events to the rule).
     */
    'approval/rule-hit': {
      ruleId: string
      callId?: string
    }
  }
}

/**
 * The rule service (ctx.approvalRules). Owns the per-session rule fold, the
 * write path, and the prepended approval answerer that auto-allows matches.
 */
export class ApprovalRuleService extends Service {
  static inject = ['sessions']

  constructor(ctx: Context) {
    super(ctx, 'approvalRules')
    // Prepend: the rule answerer must run BEFORE the remote bridge forwards
    // the ask to the GUI — a matched rule means the human never sees a
    // prompt. Unmatched asks fall through via next().
    ctx.on('approval/request', async (request, next) => {
      const hit = ctx.approvalRules.rulesOf(request.agent.session).find(rule => matchesRule(rule, request))
      if (hit === undefined) return next()
      const callId = request.callId
      request.agent.session.append('approval/rule-hit', {
        ruleId: hit.id,
        ...callId === undefined ? {} : { callId },
      })
      return 'allowed-once'
    }, { prepend: true })
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'permission-rule',
        description: 'Manage session-scoped approval rules (auto-allow matching escalations up to trusted-roots)',
        input: { hint: 'add <write|edit|bash|pwsh> <target> | list | remove <id>' },
        handler: ({ agent, rawInput }) => {
          const session = agent.session
          const text = rawInput.trim()
          if (text === '') return describeOf(session, ctx.approvalRules)
          const [verb, ...rest] = text.split(/\s+/)
          if (verb === 'list') return describeOf(session, ctx.approvalRules)
          if (verb === 'remove') {
            const id = rest[0] ?? ''
            if (id === '') return { kind: 'error', text: 'permission-rule remove needs a rule id (see: /permission-rule list)' }
            const next = ctx.approvalRules.rulesOf(session).filter(rule => rule.id !== id)
            if (next.length === ctx.approvalRules.rulesOf(session).length) {
              return { kind: 'error', text: 'no rule with id ' + id }
            }
            ctx.approvalRules.appendRules(session, next, 'user')
            return { kind: 'success', text: 'rule ' + id + ' removed' }
          }
          if (verb !== 'add') {
            return { kind: 'error', text: 'unknown verb ' + String(verb) + ' (available: add, list, remove)' }
          }
          const tool = rest[0]
          const target = rest.slice(1).join(' ')
          if (tool === undefined || !(RULE_TOOLS as readonly string[]).includes(tool)) {
            return { kind: 'error', text: 'rule tool must be one of ' + RULE_TOOLS.join(', ') }
          }
          if (target.length === 0) {
            return { kind: 'error', text: 'add needs a target: a directory for write/edit, a command prefix for bash/pwsh' }
          }
          const rule: ApprovalRule = {
            id: randomUUID(),
            tool: tool as RuleTool,
            kind: tool === 'bash' || tool === 'pwsh' || tool === 'git' ? 'command-prefix' : 'path-root',
            // Resolve relative path roots against the session cwd so the rule
            // is stable for the session.
            match: tool === 'bash' || tool === 'pwsh' || tool === 'git' ? target : resolve(session.header.cwd ?? process.cwd(), target),
            mode: 'trusted-roots',
            createdAt: Date.now(),
          }
          ctx.approvalRules.appendRules(session, [...ctx.approvalRules.rulesOf(session), rule], 'user')
          return { kind: 'success', text: 'rule ' + rule.id.slice(0, 8) + ' added: ' + rule.tool + ' escalations matching ' + rule.match + ' auto-grant trusted-roots for this session' }
        },
      })
    })
  }

  /**
   * The session's current rules: the LAST 'approval/rules' event in its log
   * (folded backwards so a resumed session reconstructs state from its own
   * log, exactly like the sandbox-mode and approval-policy folds).
   */
  rulesOf(session: Session): readonly ApprovalRule[] {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(SessionSeq(seq))
      if (event !== undefined && event.type === 'approval/rules') return event.data.rules
    }
    return []
  }

  /** The sole write path: append the full replacement set as one log event. */
  appendRules(session: Session, rules: readonly ApprovalRule[], source: 'user' | 'delegation'): void {
    session.append('approval/rules', { rules, source })
  }

  /**
   * Whether the session's path-root rules make `path` directly writable.
   * Consulted by the filesystem fence BEFORE any approval: a remembered
   * directory is writable for the session in every confined mode, so no
   * escalation is ever raised for it. Only path-root rules count (shell
   * command-prefix rules cannot gate individual paths).
   */
  matchesPath(sessionId: string, path: string): boolean {
    const session = this.ctx.sessions.list().find(candidate => candidate.id === sessionId)
    if (session === undefined) return false
    return this.rulesOf(session).some(rule =>
      rule.kind === 'path-root'
      && (rule.tool === 'write' || rule.tool === 'edit')
      && pathRootContains(rule, path),
    )
  }
}

/** Render the rule set for the bare command and `list`. */
function describeOf(session: Session, service: ApprovalRuleService): { kind: 'success'; text: string } {
  const rules = service.rulesOf(session)
  if (rules.length === 0) return { kind: 'success', text: 'no session approval rules (add one: /permission-rule add <tool> <target>)' }
  return {
    kind: 'success',
    text: rules.map(rule => rule.id.slice(0, 8) + ' ' + rule.tool + ' ' + rule.kind + ' ' + rule.match).join('\n'),
  }
}

export default ApprovalRuleService
