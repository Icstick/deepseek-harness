/**
 * Package-owned session-event invariants for approval rules. @module dsh-approval-rules/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { RULE_TOOLS, type ApprovalRule } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-approval-rules'

/** Cordis companion plugin name. */
export const name = 'approval-rules-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function validRule(rule: unknown): rule is ApprovalRule {
  if (typeof rule !== 'object' || rule === null) return false
  const r = rule as Partial<ApprovalRule>
  return typeof r.id === 'string' && r.id.length > 0
    && typeof r.tool === 'string' && (RULE_TOOLS as readonly string[]).includes(r.tool)
    && (r.kind === 'path-root' || r.kind === 'command-prefix')
    && typeof r.match === 'string' && r.match.length > 0
    && r.mode === 'trusted-roots'
    && typeof r.createdAt === 'number'
}

/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'approval/rules') {
    if (!Array.isArray(event.data.rules) || !event.data.rules.every(validRule)) {
      fail('approval/rules carries a malformed rule set')
    }
    // Replayed events are untrusted data: widen past the static union so a
    // future or corrupt source value is caught at runtime, not type-erased.
    const source: unknown = event.data.source
    if (source !== undefined && source !== 'user' && source !== 'delegation') {
      fail(`approval/rules carries an unknown source ${JSON.stringify(source)}`)
    }
  }
  if (event.type === 'approval/rule-hit'
    && (typeof event.data.ruleId !== 'string' || event.data.ruleId.length === 0)) {
    fail('approval/rule-hit carries a missing rule id')
  }
}

/** Install validation for loaded and newly appended approval-rule events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.snapshotEvents()) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registered installation's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
