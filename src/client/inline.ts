/**
 * 把检索结果作为引用插入会话输入框。
 *
 * `inputActions` 由 ui-conversation 通过 `uiSession.provide` 作为会话级标准
 * prop 下发。`insertQuote` 会在输入框里把引用收成胶囊（用 summary 代替正文
 * 展示），发送后仍是普通 Markdown blockquote，历史消息同样收成引用胶囊。
 *
 * 旧宿主只有 `insertText`，此时退回纯文本插入，避免调用缺失方法。
 */

import type { QuoteSummary } from '@deepseek-ai/dsh-client-ui-primitives'

export interface InsertionSpan {
  start: number
  end: number
  draftRev: number
}

export interface InputActions {
  insertQuote?(text: string, summary?: QuoteSummary): boolean
  captureInsertion?(): InsertionSpan
  insertText?(text: string, span: InsertionSpan): boolean
}

/** 插入结果：失败原因用于提示用户。 */
export type InsertOutcome = 'inserted' | 'no-editor' | 'draft-changed'

/**
 * 把文本作为引用插入草稿；有摘要时输入框显示胶囊，否则由宿主折叠为引用。
 *
 * @param actions 面板从 props 拿到的 `inputActions`（缺失表示不在会话上下文）
 * @param text 发送后进入消息的正文
 * @param summary 输入框里的胶囊展示
 */
export function insertQuote(
  actions: InputActions | undefined,
  text: string,
  summary?: QuoteSummary,
): InsertOutcome {
  if (!actions) return 'no-editor'
  if (actions.insertQuote !== undefined) {
    return actions.insertQuote(text, summary) ? 'inserted' : 'draft-changed'
  }
  if (actions.captureInsertion === undefined || actions.insertText === undefined) {
    return 'no-editor'
  }
  const span = actions.captureInsertion()
  return actions.insertText(text, span) ? 'inserted' : 'draft-changed'
}
