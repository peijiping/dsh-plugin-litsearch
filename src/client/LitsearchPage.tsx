/**
 * 右侧栏「文献检索」主页：新建检索 + 历史任务 + 待打开任务。
 *
 * 面板发起的检索会作为 `origin=panel` 任务落盘，并立即打开任务 tab；
 * 模型发起的任务由 {@link startAutoOpen} 自动打开，超出 tab 上限时进待打开队列。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'

import { DEFAULT_PAGE_SIZE } from '../search/config'
import type { SourceId, TaskSummary } from '../search/types'
import { SOURCE_IDS } from '../search/types'
import { createTask, deleteTask, listTasks, updateTask } from './api'
import {
  rememberTaskTitle,
  removePendingTask,
  usePendingTasks,
} from './autoOpen'
import { useHealth } from './health'
import { tpl, type Translate } from './locales'
import {
  ERROR,
  formStyle,
  linkButtonStyle,
  metaStyle,
  panelStyle,
  sourceLabelStyle,
  sourceRowStyle,
  statusStyle,
  titleStyle,
} from './styles'

interface Props {
  t: Translate
  onOpenTask(id: string, title: string): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function LitsearchPage({ t, onOpenTask }: Props): ReactElement {
  const health = useHealth()
  const pending = usePendingTasks()

  const [queryInputs, setQueryInputs] = useState<string[]>([''])
  const [selected, setSelected] = useState<SourceId[]>([...SOURCE_IDS])
  const [creating, setCreating] = useState(false)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const initialized = useRef(false)

  // 默认源来自 /health；用户手动改过之后不再覆盖。
  useEffect(() => {
    if (health === null || initialized.current) return
    initialized.current = true
    setSelected(health.settings.defaultSources)
  }, [health])

  const loadHistory = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const next = await listTasks(signal)
      setTasks(next)
      setError(null)
    } catch (err) {
      if (signal?.aborted === true) return
      setError(errorMessage(err))
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadHistory(controller.signal)
    return () => controller.abort()
  }, [loadHistory])

  const toggleSource = (id: SourceId): void => {
    initialized.current = true
    setSelected((previous) => {
      if (previous.includes(id)) {
        return previous.length === 1 ? previous : previous.filter((source) => source !== id)
      }
      return SOURCE_IDS.filter((source) => source === id || previous.includes(source))
    })
  }

  const texts = queryInputs.map((text) => text.trim()).filter((text) => text !== '')

  const run = async (): Promise<void> => {
    if (texts.length === 0 || creating) return
    setCreating(true)
    setError(null)
    try {
      const detail = await createTask({
        ...(texts.length === 1
          ? { query: texts[0] }
          : {
              queries: texts.map((text, index) => ({
                text,
                name: `检索式 ${index + 1}`,
              })),
            }),
        sources: selected.length === 0 ? undefined : selected,
      })
      rememberTaskTitle(detail.id, detail.title)
      onOpenTask(detail.id, detail.title)
      setQueryInputs([''])
      await loadHistory()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  const setQueryAt = (index: number, text: string): void => {
    setQueryInputs((previous) => previous.map((value, i) => (i === index ? text : value)))
  }

  const addQuery = (): void => {
    setQueryInputs((previous) => [...previous, ''])
  }

  const removeQuery = (index: number): void => {
    setQueryInputs((previous) => previous.filter((_, i) => i !== index))
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await deleteTask(id)
      await loadHistory()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const togglePin = async (task: TaskSummary): Promise<void> => {
    try {
      await updateTask(task.id, { pinned: !task.pinned })
      await loadHistory()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const openPending = (): void => {
    for (const task of pending) {
      rememberTaskTitle(task.id, task.title)
      onOpenTask(task.id, task.title)
      removePendingTask(task.id)
    }
  }

  const pageSize = health?.settings.defaultPageSize ?? DEFAULT_PAGE_SIZE

  return (
    <div style={panelStyle}>
      <form
        style={formStyle}
        onSubmit={(event) => {
          event.preventDefault()
          void run()
        }}
      >
        <div style={queryListStyle}>
          {queryInputs.map((value, index) => (
            <div key={index} style={queryRowStyle}>
              <Input
                value={value}
                placeholder={
                  index === 0
                    ? t('search.placeholder')
                    : tpl(t('search.queryPlaceholder'), { n: index + 1 })
                }
                aria-label={
                  index === 0
                    ? t('search.placeholder')
                    : tpl(t('search.queryPlaceholder'), { n: index + 1 })
                }
                onChange={(event) => setQueryAt(index, event.target.value)}
              />
              {queryInputs.length > 1 && (
                <button
                  type="button"
                  style={linkButtonStyle}
                  title={t('search.removeQuery')}
                  onClick={() => removeQuery(index)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, fontSize: 12 }}>
            <button type="button" style={linkButtonStyle} onClick={addQuery}>
              {t('search.addQuery')}
            </button>
          </div>
        </div>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={creating || texts.length === 0}
        >
          {creating ? t('search.searching') : t('search.button')}
        </Button>
      </form>

      <div style={sourceRowStyle}>
        <span style={sourceLabelStyle}>{t('search.sources')}</span>
        {SOURCE_IDS.map((id) => (
          <Pill
            key={id}
            type="button"
            active={selected.includes(id)}
            aria-pressed={selected.includes(id)}
            onClick={() => toggleSource(id)}
          >
            {t(`source.${id}`)}
          </Pill>
        ))}
      </div>

      <div style={statusStyle}>{tpl(t('search.hint'), { n: pageSize })}</div>

      {error !== null && <div style={{ ...statusStyle, color: ERROR }}>{error}</div>}

      {pending.length > 0 && (
        <div style={bannerStyle}>
          <span>{tpl(t('pending.title'), { n: pending.length })}</span>
          <Button variant="outline" size="sm" type="button" onClick={openPending}>
            {t('pending.open')}
          </Button>
        </div>
      )}

      <section>
        <h4 style={sectionTitleStyle}>{t('history.title')}</h4>
        {loadingHistory ? (
          <div style={statusStyle}>{t('history.loading')}</div>
        ) : tasks.length === 0 ? (
          <div style={statusStyle}>{t('history.empty')}</div>
        ) : (
          <ul style={historyListStyle}>
            {tasks.map((task) => (
              <li key={task.id} style={historyRowStyle}>
                <button
                  type="button"
                  style={historyTitleStyle}
                  title={task.title}
                  onClick={() => {
                    rememberTaskTitle(task.id, task.title)
                    onOpenTask(task.id, task.title)
                  }}
                >
                  {task.title}
                </button>
                <div style={historyMetaStyle}>
                  <span style={{ color: task.status === 'error' ? ERROR : 'inherit' }}>
                    {t(`task.status.${task.status}`)}
                  </span>
                  <span>{formatDate(task.createdAt)}</span>
                  <span>{tpl(t('history.count'), { n: task.stats.deduped })}</span>
                </div>
                <div style={{ ...metaStyle, display: 'flex', gap: 10 }}>
                  <button
                    type="button"
                    style={linkButtonStyle}
                    title={task.pinned ? t('task.unpin') : t('task.pin')}
                    onClick={() => {
                      void togglePin(task)
                    }}
                  >
                    {task.pinned ? t('task.unpin') : t('task.pin')}
                  </button>
                  <button
                    type="button"
                    style={linkButtonStyle}
                    onClick={() => {
                      void remove(task.id)
                    }}
                  >
                    {t('history.delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

const queryListStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  flex: 1,
  minWidth: 0,
} as const

const queryRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
} as const

const sectionTitleStyle = {
  fontSize: 12,
  fontWeight: 600,
  opacity: 0.72,
  margin: '6px 0 4px',
} as const

const historyListStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
} as const

const historyRowStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  padding: '8px 0',
  borderTop: '1px solid rgba(127,127,127,0.18)',
} as const

const historyTitleStyle = {
  ...titleStyle,
  fontSize: 12.5,
  textAlign: 'left',
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const historyMetaStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  fontSize: 11,
  opacity: 0.66,
} as const

const bannerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '6px 8px',
  border: '1px solid rgba(80,140,255,0.4)',
  borderRadius: 6,
  fontSize: 12,
} as const
