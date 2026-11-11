/**
 * 右上角「搜索任务列表」弹窗：列出全部任务，可打开、重命名、删除。
 *
 * 打开任务时用 `activateTask` 告诉 Host「进入该任务」，之后的模型检索默认
 * 落在这里；删除后同时清理本地 tab / 标题 / 待打开缓存。
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'

import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type { TaskSummary } from '../search/types'
import { deleteTask, listTasks, updateTask } from './api'
import { forgetTask, rememberTaskTitle } from './autoOpen'
import { tpl, type Translate } from './locales'
import {
  ACCENT,
  ERROR,
  linkButtonStyle,
  metaStyle,
  statusStyle,
  titleStyle,
} from './styles'
import { notifyTaskListChanged, useTaskListVersion } from './taskListStore'

/** 列表里有运行中任务时的刷新间隔。 */
const RUNNING_POLL_MS = 3000

interface Props {
  t: Translate
  open: boolean
  onClose: () => void
  /** 当前正在看的那个任务，列表里给一个「当前」标记。 */
  currentTaskId?: string | null
  onOpenTask: (id: string, title: string) => void
  /**
   * 删除的正是当前查看的任务时回调：fallback 为列表里紧邻的上一个任务
   * （删的是第一条时取相邻的下一条），没有其它任务时为 null。
   */
  onCurrentRemoved?: (fallback: TaskSummary | null) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function TaskListDialog({
  t,
  open,
  onClose,
  currentTaskId,
  onOpenTask,
  onCurrentRemoved,
}: Props): ReactElement | null {
  const version = useTaskListVersion()
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const next = await listTasks(signal)
      setTasks(next)
      setError(null)
    } catch (err) {
      if (signal?.aborted === true) return
      setError(messageOf(err))
    } finally {
      if (signal?.aborted !== true) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const controller = new AbortController()
    setLoading(true)
    void load(controller.signal)
    return () => controller.abort()
  }, [open, version, load])

  const hasRunning = tasks.some((task) => task.status === 'running' || task.status === 'queued')

  // 弹窗打开且有任务在跑时轻量刷新，跑完即停，避免停留在「检索中」的旧快照。
  useEffect(() => {
    if (!open || !hasRunning) return undefined
    const timer = setInterval(() => {
      void load()
    }, RUNNING_POLL_MS)
    return () => clearInterval(timer)
  }, [open, hasRunning, load])

  const openTask = (task: TaskSummary): void => {
    // activate 由 onOpenTask（index.ts 的 openTask）统一负责。
    onOpenTask(task.id, task.title)
    onClose()
  }

  const saveRename = async (task: TaskSummary): Promise<void> => {
    const title = editTitle.trim()
    if (title === '' || busyId !== null) return
    setBusyId(task.id)
    try {
      const updated = await updateTask(task.id, { title })
      rememberTaskTitle(updated.id, updated.title)
      notifyTaskListChanged()
      setEditingId(null)
      await load()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (task: TaskSummary): Promise<void> => {
    if (busyId !== null) return
    setBusyId(task.id)
    const index = tasks.findIndex((entry) => entry.id === task.id)
    try {
      await deleteTask(task.id)
      forgetTask(task.id)
      notifyTaskListChanged()
      setConfirmDeleteId(null)
      if (task.id === currentTaskId) {
        const remaining = tasks.filter((entry) => entry.id !== task.id)
        // 先取列表里紧邻的上一条；删的是第一条时退到新的第一条。
        const fallback = index < 0 ? null : (remaining[index - 1] ?? remaining[index] ?? null)
        onCurrentRemoved?.(fallback)
      }
      await load()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('taskList.title')}
      description={t('taskList.desc')}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={statusStyle}>{tpl(t('taskList.count'), { n: tasks.length })}</span>
          <Button variant="outline" size="sm" type="button" onClick={onClose}>
            {t('taskList.close')}
          </Button>
        </div>
      }
    >
      <div style={{ maxHeight: '58vh', overflowY: 'auto' }}>
        {loading && tasks.length === 0 ? (
          <div style={statusStyle}>{t('taskList.loading')}</div>
        ) : tasks.length === 0 ? (
          <div style={statusStyle}>{t('taskList.empty')}</div>
        ) : (
          <ul style={listStyle}>
            {tasks.map((task) => (
              <li key={task.id} style={rowStyle}>
                {editingId === task.id ? (
                  <div style={editRowStyle}>
                    <Input
                      value={editTitle}
                      maxLength={120}
                      aria-label={t('taskList.rename')}
                      onChange={(event) => setEditTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void saveRename(task)
                        } else if (event.key === 'Escape') {
                          setEditingId(null)
                        }
                      }}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      type="button"
                      disabled={busyId !== null || editTitle.trim() === ''}
                      onClick={() => {
                        void saveRename(task)
                      }}
                    >
                      {t('taskList.save')}
                    </Button>
                    <button
                      type="button"
                      style={linkButtonStyle}
                      onClick={() => setEditingId(null)}
                    >
                      {t('taskList.cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    style={titleButtonStyle}
                    title={task.title}
                    onClick={() => openTask(task)}
                  >
                    {task.title}
                    {currentTaskId === task.id && (
                      <span style={currentBadgeStyle}>{t('taskList.current')}</span>
                    )}
                  </button>
                )}
                <div style={metaStyle}>
                  <span style={{ color: task.status === 'error' ? ERROR : 'inherit' }}>
                    {t(`task.status.${task.status}`)}
                  </span>
                  <span>{tpl(t('taskList.rounds'), { n: task.roundCount ?? 0 })}</span>
                  <span>{tpl(t('taskList.papers'), { n: task.stats.deduped })}</span>
                  <span>{formatDate(task.updatedAt)}</span>
                </div>
                {editingId !== task.id && (
                  <div style={{ ...metaStyle, display: 'flex', gap: 10 }}>
                    <button
                      type="button"
                      style={linkButtonStyle}
                      disabled={busyId !== null}
                      onClick={() => {
                        setConfirmDeleteId(null)
                        setEditingId(task.id)
                        setEditTitle(task.title)
                      }}
                    >
                      {t('taskList.rename')}
                    </button>
                    <button
                      type="button"
                      style={{ ...linkButtonStyle, color: confirmDeleteId === task.id ? ERROR : ACCENT }}
                      disabled={busyId !== null}
                      onClick={() => {
                        if (confirmDeleteId === task.id) {
                          void remove(task)
                        } else {
                          setConfirmDeleteId(task.id)
                        }
                      }}
                    >
                      {confirmDeleteId === task.id
                        ? t('taskList.confirmDelete')
                        : t('taskList.delete')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {error !== null && <div style={{ ...statusStyle, color: ERROR }}>{error}</div>}
      </div>
    </Modal>
  )
}

const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
} as const

const rowStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  padding: '9px 0',
  borderTop: '1px solid rgba(127,127,127,0.18)',
} as const

const titleButtonStyle = {
  ...titleStyle,
  fontSize: 12.5,
  textAlign: 'left',
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

const currentBadgeStyle = {
  fontSize: 10.5,
  lineHeight: 1.4,
  padding: '0 5px',
  borderRadius: 4,
  border: '1px solid rgba(80,140,255,0.5)',
  color: ACCENT,
  flexShrink: 0,
} as const

const editRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
} as const
