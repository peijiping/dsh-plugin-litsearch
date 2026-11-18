/**
 * 任务「笔记」tab：任务级研究笔记。
 *
 * 任务笔记直接写回 `updateTask({notes})`，与模型工具看到的是同一份数据。
 */

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { TaskDetail } from '../search/types'
import { updateTask } from './api'
import type { Translate } from './locales'
import { ERROR, statusStyle } from './styles'

interface Props {
  t: Translate
  taskId: string
  detail: TaskDetail
  onSaved(): void
  /** 保存结果走面板底部浮层提醒。 */
  onNotify(text: string): void
}

export function NotesTab({ t, taskId, detail, onSaved, onNotify }: Props): ReactElement {
  const [notes, setNotes] = useState(detail.notes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setNotes(detail.notes)
  }, [detail.rev])

  const save = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void updateTask(taskId, { notes })
      .then(() => {
        onNotify(t('notes.saved'))
        onSaved()
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <div style={WRAP_STYLE}>
      <section>
        <h4 style={HEAD_STYLE}>{t('notes.title')}</h4>
        <textarea
          className="ls-input"
          style={TEXTAREA_STYLE}
          rows={6}
          value={notes}
          placeholder={t('notes.taskPlaceholder')}
          onChange={(event) => setNotes(event.target.value)}
        />
        <div style={ACTION_ROW_STYLE}>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={busy || notes === detail.notes}
            onClick={save}
          >
            {t('notes.save')}
          </Button>
        </div>
        {error !== null && <div style={{ ...statusStyle, color: ERROR }}>{error}</div>}
      </section>
    </div>
  )
}

const WRAP_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const HEAD_STYLE: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 500,
  color: 'var(--ls-ink-1)',
  margin: '0 0 6px',
}
const TEXTAREA_STYLE: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 12.5,
  lineHeight: 1.65,
  padding: '8px 10px',
  resize: 'vertical',
  fontFamily: 'inherit',
}
const ACTION_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 6,
}
