/** Composer takeover for one pending approval waterfall. */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApprovalComposerProps, PendingApproval } from './contract/slots.ts'
import css from './ApprovalPanel.module.css'

/**
 * Render one pending approval and its optional Tool-owned detail.
 * @param props - selector-matched request and standard Slot props.
 * @returns The approval composer takeover.
 */
export function ApprovalPanel(props: ApprovalComposerProps) {
  const approval = props.matched
  const detail = approval.callId === undefined
    ? null
    : props.renderSlot('conversation.approval.detail', { callId: approval.callId })
  return <ApprovalFlow key={approval.key} pending={approval} detail={detail} t={props.t} />
}

function ApprovalFlow({ pending, detail, t }: {
  pending: PendingApproval
  detail: ReactNode
  t: ApprovalComposerProps['t']
}) {
  const [answered, setAnswered] = useState(false)
  const [remembering, setRemembering] = useState(false)
  const [rememberFailed, setRememberFailed] = useState(false)
  const answer = (outcome: 'allowed-once' | 'rejected'): void => {
    setAnswered(true)
    void pending.answer(outcome).catch(() => { setAnswered(false) })
  }
  const rememberable = ruleLineOf(pending)
  const remember = (): void => {
    if (rememberable === undefined || pending.remember === undefined) return
    setRemembering(true)
    setRememberFailed(false)
    void pending.remember(rememberable.line).then((ok) => {
      if (!ok) {
        setRemembering(false)
        setRememberFailed(true)
        return
      }
      // Creating the rule IS the consent: the current ask belongs to the
      // remembered class, so it is allowed together with all future matches.
      answer('allowed-once')
    })
  }
  return (
    <div className={css.root} data-approval-key={pending.key}>
      <div className={css.card}>
        <div className={css.strip}><span className={css.dot} />{t('waiting')}</div>
        <div
          className={css.body}
          data-approval-scroll=""
          tabIndex={0}
          role="group"
          aria-label={t('detail.aria')}
        >
          <div className={css.headline}>{pending.reason ?? t('escalation', { toolName: pending.toolName })}</div>
          {detail !== null && <div className={css.command}>{detail}</div>}
        </div>
        {rememberable !== undefined && pending.remember !== undefined && (
          <div className={css.scopeHint}>{t('rememberHint', { target: rememberable.target })}</div>
        )}
        <div className={css.actionRow}>
          <Button variant="outline" className={css.reject} disabled={answered || remembering} onClick={() => { answer('rejected') }}>
            {t('reject')}
          </Button>
          {rememberable !== undefined && pending.remember !== undefined && (
            <Button variant="outline" disabled={answered || remembering} onClick={remember}>
              {remembering ? t('remembering') : t('remember')}
            </Button>
          )}
          <Button variant="primary" disabled={answered || remembering} onClick={() => { answer('allowed-once') }}>
            {t('allowOnce')}
          </Button>
        </div>
        {rememberFailed && <div className={css.errorText} role="alert">{t('rememberError')}</div>}
      </div>
    </div>
  )
}

/**
 * The /permission-rule line a remember action would submit, plus the
 * user-facing scope label. Undefined when the ask cannot be rule-ized:
 * only trusted-roots escalations with a structured target can become
 * session rules (tool, kind, and ceiling all come from the request).
 */
function ruleLineOf(pending: PendingApproval): { line: string; target: string } | undefined {
  const context = pending.context
  if (context === undefined || context.mode !== 'trusted-roots') return undefined
  if ((pending.toolName === 'write' || pending.toolName === 'edit') && context.path !== undefined) {
    const dir = dirnameOf(context.path)
    return { line: '/permission-rule add ' + pending.toolName + ' ' + dir, target: dir }
  }
  if ((pending.toolName === 'bash' || pending.toolName === 'pwsh') && context.command !== undefined) {
    return { line: '/permission-rule add ' + pending.toolName + ' ' + context.command, target: context.command }
  }
  return undefined
}

/** Cross-platform directory of one path (browser-safe, no node:path). */
function dirnameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (index <= 0) return trimmed.length === 0 ? '/' : '/'.concat(trimmed.replace(/^[\\/]*/, ''))
  return trimmed.slice(0, index)
}
