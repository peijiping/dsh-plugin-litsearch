/**
 * 任务「笔记」tab：任务级研究笔记 + 逐篇备注汇总。
 *
 * 逐篇备注通过 /results 取回当前任务前 200 篇的标题做映射；任务笔记直接写回
 * `updateTask({notes})`，与模型工具看到的是同一份数据。
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { PaperState, TaskDetail } from '../search/types'
import { fetchResults, updateTask } from './api'
import type { Translate } from './locales'
import { ERROR, statusStyle } from './styles'

const NOTE_PAGE_LIMIT = 200

interface Props {
  t: Translate
  taskId: string
  detail: TaskDetail
  onSaved(): void
  /** 保存结果走面板底部浮层提醒。 */
  onNotify(text: string): void
}

interface Entry {
  paperId: string
  state: PaperState
}

export function NotesTab({ t, taskId, detail, onSaved, onNotify }: Props): ReactElement {
  const [notes, setNotes] = useState(detail.notes)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [loadingTitles, setLoadingTitles] = useState(true)

  useEffect(() => {
    setNotes(detail.notes)
  }, [detail.rev])

  useEffect(() => {
    const controller = new AbortController()
    setLoadingTitles(true)
    fetchResults(taskId, { limit: NOTE_PAGE_LIMIT }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return
        const map: Record<string, string> = {}
        for (const paper of page.papers) map[paper.paperId] = paper.title
        setTitles(map)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setLoadingTitles(false)
      })
    return () => {
      controller.abort()
    }
  }, [taskId, detail.rev])

  const entries = useMemo<Entry[]>(() => {
    return Object.entries(detail.states)
      .filter(([, state]) => (state.note ?? '') !== '')
      .map(([paperId, state]) => ({ paperId, state }))
  }, [detail.states])

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

      <section>
        <h4 style={HEAD_STYLE}>{t('notes.paperSection')}</h4>
        <div style={statusStyle}>{t('notes.hint')}</div>
        {loadingTitles && entries.length === 0 ? (
          <div style={statusStyle}>{t('notes.loading')}</div>
        ) : entries.length === 0 ? (
          <div style={statusStyle}>{t('notes.empty')}</div>
        ) : (
          <div style={LIST_STYLE}>
            {entries.map((entry) => (
              <div key={entry.paperId} style={ENTRY_STYLE}>
                <div style={ENTRY_TITLE_STYLE}>{titles[entry.paperId] ?? entry.paperId}</div>
                <div style={ENTRY_META_STYLE}>{t(`screening.${entry.state.screening}`)}</div>
                {entry.state.note !== undefined && entry.state.note !== '' && (
                  <div style={ENTRY_NOTE_STYLE}>{entry.state.note}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

const WRAP_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const HEAD_STYLE: CSSProperties = {
  fontSize: 13,
  fontWeight: 650,
  opacity: 0.85,
  margin: '0 0 4px',
}
const TEXTAREA_STYLE: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 12,
  lineHeight: 1.6,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
  resize: 'vertical',
  fontFamily: 'inherit',
}
const ACTION_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 6,
}
const LIST_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column' }
const ENTRY_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px 0',
  borderTop: '1px solid rgba(127,127,127,0.14)',
}
const ENTRY_TITLE_STYLE: CSSProperties = { fontSize: 12.5, fontWeight: 650, lineHeight: 1.45 }
const ENTRY_META_STYLE: CSSProperties = { fontSize: 11, opacity: 0.7 }
const ENTRY_NOTE_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.55, opacity: 0.85 }
