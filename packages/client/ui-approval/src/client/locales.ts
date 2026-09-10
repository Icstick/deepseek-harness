/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  reject: '拒绝',
  allowOnce: '允许一次',
  remember: '记住此类并允许',
  remembering: '正在记住…',
  rememberHint: '本会话内对 {target} 不再询问',
  rememberError: '记住失败：规则未创建',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allowOnce: 'Allow once',
  remember: 'Remember this kind and allow',
  remembering: 'Remembering…',
  rememberHint: 'This session will not ask again for: {target}',
  rememberError: 'Failed to create the rule',
} satisfies Record<ApprovalKey, string>
