/**
 * Tests for the session approval-rule service: rule matching against the
 * structured escalation context, the log fold and replay, the prepended
 * auto-allow answerer, the /permission-rule command surface, and the
 * invariant companion.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import ApprovalRuleService,
{ matchesRule, RULE_TOOLS, type ApprovalRule } from '@deepseek-ai/dsh-approval-rules'

/** Minimal agent stand-in mirroring the approval suite's fake. */
function fakeAgent(seed: Array<{ type: string }> = [{ type: 'turn/start' }, { type: 'user/message' }]): { agent: Agent; appended: Array<{ type: string; data: Record<string, unknown> }> } {
  const appended: Array<{ type: string; data: Record<string, unknown> }> = []
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [...seed]
  const agent = {
    session: {
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      append: (type: string, data: Record<string, unknown>) => {
        const event = { type, data }
        events.push(event)
        appended.push(event)
        return event as unknown as SessionEvent
      },
    },
  } as unknown as Agent
  return { agent, appended }
}

async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(ApprovalRuleService, {})
  return ctx
}

function ruleOf(overrides: Partial<ApprovalRule> = {}): ApprovalRule {
  return {
    id: 'rule-1',
    tool: 'write',
    kind: 'path-root',
    match: mkdtempSync(join(tmpdir(), 'dsh-rules-')),
    mode: 'trusted-roots',
    createdAt: 1,
    ...overrides,
  }
}

describe('matchesRule', () => {
  it('matches an fs escalation whose target sits under the rule root', () => {
    const rule = ruleOf({ tool: 'edit' })
    const under = join(rule.match, 'nested', 'file.txt')
    expect(matchesRule(rule, { toolName: 'edit', context: { path: under, mode: 'trusted-roots' } })).toBe(true)
  })

  it('rejects a target outside the rule root', () => {
    const rule = ruleOf()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-rules-out-'))
    expect(matchesRule(rule, { toolName: 'write', context: { path: join(outside, 'f.txt'), mode: 'trusted-roots' } })).toBe(false)
  })

  it('rejects a sibling path sharing the root prefix (folder vs folderish)', () => {
    const rule = ruleOf()
    const sibling = rule.match + '-ish'
    expect(matchesRule(rule, { toolName: 'write', context: { path: join(sibling, 'f.txt'), mode: 'trusted-roots' } })).toBe(false)
  })

  it('rejects a mismatched tool, a missing context, and a narrower or wider requested mode', () => {
    const rule = ruleOf()
    const under = join(rule.match, 'f.txt')
    expect(matchesRule(rule, { toolName: 'bash', context: { path: under, mode: 'trusted-roots' } })).toBe(false)
    expect(matchesRule(rule, { toolName: 'write' })).toBe(false)
    expect(matchesRule(rule, { toolName: 'write', context: { path: under } })).toBe(false)
    expect(matchesRule(rule, { toolName: 'write', context: { path: under, mode: 'workspace-write' } })).toBe(false)
    expect(matchesRule(rule, { toolName: 'write', context: { path: under, mode: 'danger-full-access' } })).toBe(false)
  })

  it('matches a shell escalation whose command starts with the rule prefix', () => {
    const rule = ruleOf({ tool: 'pwsh', kind: 'command-prefix', match: 'pnpm build' })
    expect(matchesRule(rule, { toolName: 'pwsh', context: { command: 'pnpm build --filter x', mode: 'trusted-roots' } })).toBe(true)
    expect(matchesRule(rule, { toolName: 'bash', context: { command: 'pnpm build', mode: 'trusted-roots' } })).toBe(false)
    expect(matchesRule(rule, { toolName: 'pwsh', context: { command: 'npm run build', mode: 'trusted-roots' } })).toBe(false)
  })
})

describe('the rule fold and write path', () => {
  it('folds the last approval/rules event from the log tail and survives replay', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent([])
    const first = ruleOf({ id: 'a' })
    const second = ruleOf({ id: 'b' })
    ctx.approvalRules.appendRules(agent.session, [first], 'user')
    ctx.approvalRules.appendRules(agent.session, [first, second], 'user')
    expect(ctx.approvalRules.rulesOf(agent.session).map(rule => rule.id)).toEqual(['a', 'b'])
  })

  it('returns no rules without any approval/rules event', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent([])
    expect(ctx.approvalRules.rulesOf(agent.session)).toEqual([])
  })
})

describe('the auto-allow answerer', () => {
  it('grants allowed-once for a matching escalation and audits the rule hit', async () => {
    const ctx = await mounted()
    const { agent, appended } = fakeAgent()
    const rule = ruleOf()
    ctx.approvalRules.appendRules(agent.session, [rule], 'user')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'write',
      reason: 'escalate sandbox to trusted-roots: staging build files',
      context: { path: join(rule.match, 'out.txt'), mode: 'trusted-roots' },
    })
    expect(outcome).toBe('allowed-once')
    expect(appended.map(event => event.type)).toEqual(['approval/rules', 'approval/asked', 'approval/rule-hit', 'approval/decided'])
    expect(appended[2]?.data).toMatchObject({ ruleId: 'rule-1' })
  })

  it('falls through (unavailable) when no rule matches — the GUI still gets the ask', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    const rule = ruleOf()
    ctx.approvalRules.appendRules(agent.session, [rule], 'user')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'write',
      reason: 'escalate sandbox to trusted-roots: elsewhere',
      context: { path: join(mkdtempSync(join(tmpdir(), 'dsh-rules-miss-')), 'out.txt'), mode: 'trusted-roots' },
    })
    expect(outcome).toBe('unavailable')
  })

  it('stays silent for asks without structured context (hooks etc.)', async () => {
    const ctx = await mounted()
    const { agent } = fakeAgent()
    ctx.approvalRules.appendRules(agent.session, [ruleOf()], 'user')
    const outcome = await ctx.approval.request({ agent, toolName: 'hook', reason: 'please confirm' })
    expect(outcome).toBe('unavailable')
  })
})

describe('tool vocabulary', () => {
  it('exposes the closed tool list', () => {
    expect(RULE_TOOLS).toEqual(['write', 'edit', 'bash', 'pwsh'])
  })
})
