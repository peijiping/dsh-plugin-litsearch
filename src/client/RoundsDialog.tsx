/**
 * 任务内「检索轮次」时间轴弹窗。
 *
 * 只展示每轮的元数据（时间、条件、发起方、命中数、状态），不回吐文献列表；
 * 每轮都可把当时的条件回填并原地重跑，产生新的一轮而不是新任务。
 */

import { useEffect, useState, type ReactElement } from 'react'

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type { SearchRound, TaskConditions, TaskDetail } from '../search/types'
import {
  fetchRounds,
  fetchTask,
  runTask,
  updateTask,
  type TaskConditionsPatch,
} from './api'
import { tpl, type Translate } from './locales'
import {
  ACCENT,
  ERROR,
  linkButtonStyle,
  metaStyle,
  statusStyle,
} from './styles'
import { notifyTaskListChanged } from './taskListStore'

interface Props {
  t: Translate
  open: boolean
  onClose: () => void
  taskId: string
  detail: TaskDetail
  /** 当前任务正在跑，禁止回填重跑。 */
  busy: boolean
  /** 重跑已触发，让任务页刷新状态并提示。 */
  onRerun: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/** 轮次条件的深拷贝快照 → PATCH 可接受的条件体。 */
function conditionsToPatch(conditions: TaskConditions): TaskConditionsPatch {
  return {
    queries: conditions.queries.map((query) => ({
      name: query.name,
      text: query.text,
      enabled: query.enabled,
      ...(query.perSource === undefined ? {} : { perSource: { ...query.perSource } }),
    })),
    sources: [...conditions.sources],
    pageSize: conditions.pageSize,
    yearFrom: conditions.yearFrom ?? null,
    yearTo: conditions.yearTo ?? null,
    openAccessOnly: conditions.openAccessOnly,
    language: conditions.language,
    types: conditions.types === undefined ? [] : [...conditions.types],
    sort: conditions.sort,
  }
}

export function RoundsDialog({
  t,
  open,
  onClose,
  taskId,
  detail,
  busy,
  onRerun,
}: Props): ReactElement | null {
  const [rounds, setRounds] = useState<SearchRound[]>(detail.rounds ?? [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)

  // 弹窗打开时独立刷新一次；任务状态 / 轮数变化（轮询到）时再刷。
  useEffect(() => {
    if (!open) return undefined
    const controller = new AbortController()
    setLoading(true)
    void fetchRounds(taskId, controller.signal)
      .then((next) => {
        setRounds(next)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [open, taskId, detail.roundCount, detail.status])

  const restore = async (round: SearchRound): Promise<void> => {
    if (busy || restoring !== null) return
    setRestoring(round.id)
    setError(null)
    try {
      // 先取最新 rev，避免轮询期间 rev 前进导致乐观锁冲突。
      const latest = await fetchTask(taskId)
      await updateTask(taskId, {
        conditions: conditionsToPatch(round.conditions),
        rev: latest.rev,
      })
      await runTask(taskId)
      notifyTaskListChanged()
      onRerun()
      onClose()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setRestoring(null)
    }
  }

  const ordered = [...rounds].reverse()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('rounds.title')}
      description={tpl(t('rounds.desc'), { n: rounds.length })}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={statusStyle}>{t('rounds.footnote')}</span>
          <Button variant="outline" size="sm" type="button" onClick={onClose}>
            {t('rounds.close')}
          </Button>
        </div>
      }
    >
      <div style={{ maxHeight: '58vh', overflowY: 'auto', paddingRight: 4 }}>
        {loading && rounds.length === 0 ? (
          <div style={statusStyle}>{t('rounds.loading')}</div>
        ) : ordered.length === 0 ? (
          <div style={statusStyle}>{t('rounds.empty')}</div>
        ) : (
          <div style={timelineStyle}>
            {ordered.map((round) => {
              const queries = round.conditions.queries.filter((query) => query.enabled)
              const shown = queries.slice(0, 3).map((query) => query.text).join('；')
              const status =
                round.status === undefined ? t('rounds.running') : t(`task.status.${round.status}`)
              return (
                <div key={round.id} style={roundRowStyle}>
                  <span style={dotStyle} />
                  <div style={roundCardStyle}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong style={{ fontSize: 12.5 }}>
                        {tpl(t('rounds.item'), { n: round.index })}
                      </strong>
                      <span style={{ ...metaStyle, marginTop: 0, whiteSpace: 'nowrap' }}>
                        {formatDate(round.createdAt)}
                      </span>
                    </div>
                    <div style={metaStyle}>
                      {t(round.origin === 'model' ? 'rounds.originModel' : 'rounds.originPanel')} ·{' '}
                      {status} ·{' '}
                      {tpl(t('rounds.stats'), {
                        raw: round.stats?.rawHits ?? 0,
                        dedup: round.stats?.deduped ?? 0,
                        loaded: round.stats?.loaded ?? 0,
                      })}
                    </div>
                    <div style={{ ...metaStyle, wordBreak: 'break-word' }}>
                      {shown}
                      {queries.length > 3 &&
                        ` ${tpl(t('rounds.moreQueries'), { n: queries.length - 3 })}`}
                    </div>
                    <div style={metaStyle}>
                      {tpl(t('rounds.conditionMeta'), {
                        n: round.conditions.pageSize,
                        sources: round.conditions.sources.join('/'),
                      })}
                    </div>
                    {round.error !== undefined && (
                      <div style={{ ...statusStyle, color: ERROR }}>{round.error}</div>
                    )}
                    <div style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        style={linkButtonStyle}
                        disabled={busy || restoring !== null}
                        title={busy ? t('task.running') : t('rounds.restoreHint')}
                        onClick={() => {
                          void restore(round)
                        }}
                      >
                        {restoring === round.id ? t('rounds.restoring') : t('rounds.restore')}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {error !== null && <div style={{ ...statusStyle, color: ERROR }}>{error}</div>}
      </div>
    </Modal>
  )
}

const timelineStyle = {
  position: 'relative',
  marginLeft: 8,
  paddingLeft: 20,
  borderLeft: '2px solid rgba(127,127,127,0.28)',
} as const

const roundRowStyle = {
  position: 'relative',
  marginBottom: 12,
} as const

const dotStyle = {
  position: 'absolute',
  left: -27,
  top: 4,
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: ACCENT,
  border: '2px solid transparent',
  boxSizing: 'content-box',
} as const

const roundCardStyle = {
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,0.24)',
  background: 'rgba(127,127,127,0.06)',
} as const
