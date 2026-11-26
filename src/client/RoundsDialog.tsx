/**
 * 任务内「检索轮次」时间轴弹窗。
 *
 * 可切换已保存的轮次，或用该轮条件创建轮次草稿和任务草稿。
 *
 * 每一轮做成左右两栏：左侧是这一轮的完整查询条件（复用 ConditionSummary），
 * 右侧是本轮的结果概括（发起方 / 轮次状态 / 漏斗 / 失败与跳过的数据源），
 * 与任务页头部的两块信息对应。
 */

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type { SearchRound, TaskDetail } from '../search/types'
import { createTask, fetchRounds, selectTaskRound } from './api'
import { RoundEvidence } from './RoundEvidence'
import { ConditionSummary } from './ConditionSummary'
import { AlertIcon, ClockIcon, ResultIcon, RoundIcon } from './icons'
import { tpl, type Translate } from './locales'
import { ACCENT, ERROR, statusStyle } from './styles'
import { notifyTaskListChanged } from './taskListStore'

interface Props {
  t: Translate
  open: boolean
  onClose: () => void
  taskId: string
  detail: TaskDetail
  /** 当前任务正在执行，暂时不能切换轮次。 */
  busy: boolean
  onChange: () => void
  onSwitch: (detail: TaskDetail) => void
  onCreate?: (id: string, title: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function RoundsDialog({
  t,
  open,
  onClose,
  taskId,
  detail,
  busy,
  onChange,
  onSwitch,
  onCreate,
}: Props): ReactElement | null {
  const [rounds, setRounds] = useState<SearchRound[]>(detail.rounds ?? [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ id: string; action: 'switch' | 'draft' | 'task' } | null>(null)

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
  }, [open, taskId, detail.roundCount, detail.status, detail.rev])

  const selectRound = async (round: SearchRound, mode: 'switch' | 'draft'): Promise<void> => {
    if (busy || pending !== null) return
    setPending({ id: round.id, action: mode })
    setError(null)
    try {
      onSwitch(await selectTaskRound(taskId, round.id, mode))
      onClose()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setPending(null)
    }
  }

  const createTaskDraft = async (round: SearchRound): Promise<void> => {
    if (onCreate === undefined || pending !== null) return
    setPending({ id: round.id, action: 'task' })
    setError(null)
    try {
      const sourceTitle = detail.title.length > 80 ? `${detail.title.slice(0, 80)}…` : detail.title
      const title = tpl(t('rounds.draftTitle'), { title: sourceTitle, n: round.index })
      const draft = await createTask({ ...round.conditions, title, runNow: false })
      notifyTaskListChanged()
      onCreate(draft.id, draft.title)
      onClose()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setPending(null)
    }
  }

  const ordered = [...rounds].reverse()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('rounds.title')}
      description={tpl(t('rounds.desc'), { n: rounds.length })}
      className={WIDE_MODAL_CLASS}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={statusStyle}>{t('rounds.footnote')}</span>
          <Button variant="outline" size="sm" type="button" onClick={onClose}>
            {t('rounds.close')}
          </Button>
        </div>
      }
    >
      <style>{WIDE_MODAL_CSS}</style>
      <div style={{ maxHeight: '68vh', overflowY: 'auto', paddingRight: 4 }}>
        {loading && rounds.length === 0 ? (
          <div style={statusStyle}>{t('rounds.loading')}</div>
        ) : ordered.length === 0 ? (
          <div style={statusStyle}>{t('rounds.empty')}</div>
        ) : (
          <div style={timelineStyle}>
            {ordered.map((round) => {
              const status =
                round.status === undefined ? t('rounds.running') : t(`task.status.${round.status}`)
              const stats = round.stats
              // 明细字段是后加的；旧轮次回退到只存了数量的版本。
              const failedList = round.failedSourceList ?? []
              const skippedList = round.skippedSourceList ?? []
              const failedCount = failedList.length || round.failedSources || 0
              const skippedCount = skippedList.length || round.skippedSources || 0
              const isCurrent = round.id === (detail.activeRoundId ?? rounds.at(-1)?.id)
              return (
                <div key={round.id} style={roundRowStyle}>
                  <span style={dotStyle} />
                  <div style={roundCardStyle}>
                    <div style={cardHeadStyle}>
                      <strong style={{ fontSize: 12.5 }}>
                        {tpl(t('rounds.item'), { n: round.index })}
                      </strong>
                      <div style={cardActionsStyle}>
                        {isCurrent ? (
                          <span style={statusStyle}>{t('rounds.current')}</span>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy || pending !== null || !round.hasResults}
                            title={!round.hasResults ? t('rounds.resultsUnavailable') : busy ? t('task.running') : undefined}
                            onClick={() => void selectRound(round, 'switch')}
                          >
                            {pending?.id === round.id && pending.action === 'switch'
                              ? t('rounds.switching') : t('rounds.switch')}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || pending !== null}
                          title={busy ? t('task.running') : t('rounds.createRoundHint')}
                          onClick={() => void selectRound(round, 'draft')}
                        >
                          {pending?.id === round.id && pending.action === 'draft'
                            ? t('rounds.creating') : t('rounds.createRound')}
                        </Button>
                        {onCreate !== undefined && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={pending !== null}
                            title={t('rounds.createTaskHint')}
                            onClick={() => void createTaskDraft(round)}
                          >
                            {pending?.id === round.id && pending.action === 'task'
                              ? t('rounds.creating') : t('rounds.createTask')}
                          </Button>
                        )}
                      </div>
                    </div>
                    <div style={columnsStyle}>
                      {/* 左栏：这一轮的完整查询条件。 */}
                      <section style={paneStyle}>
                        <div style={paneTitleStyle}>{t('rounds.conditionCol')}</div>
                        <ConditionSummary t={t} conditions={round.conditions} />
                      </section>
                      {/* 右栏：本轮结果概括，对齐任务页头部的两块信息。 */}
                      <section style={paneStyle}>
                        <div style={paneTitleStyle}>{t('rounds.resultCol')}</div>
                        <InfoLine icon={<ClockIcon />}>
                          {tpl(t('task.meta'), {
                            origin: t(
                              round.origin === 'model'
                                ? 'rounds.originModel'
                                : 'rounds.originPanel',
                            ),
                            date: formatDate(round.startedAt ?? round.createdAt),
                          })}
                        </InfoLine>
                        <InfoLine icon={<RoundIcon />}>
                          {tpl(t('task.roundLine'), {
                            round: round.index,
                            status,
                            date: formatDate(round.finishedAt ?? round.createdAt),
                          })}
                        </InfoLine>
                        {round.status !== 'draft' && (
                          <InfoLine icon={<ResultIcon />}>
                            {tpl(t('task.stats'), {
                              raw: stats?.rawHits ?? 0,
                              deduped: stats?.deduped ?? 0,
                              loaded: stats?.loaded ?? 0,
                            })}
                          </InfoLine>
                        )}
                        {failedList.map((item, index) => (
                          <InfoLine key={`f-${item.id}-${index}`} icon={<AlertIcon />} tone="error">
                            {tpl(t('error.sourceFailed'), {
                              source: t(`source.${item.id}`),
                              message: item.error,
                            })}
                          </InfoLine>
                        ))}
                        {failedCount > 0 && failedList.length === 0 && (
                          <InfoLine icon={<AlertIcon />} tone="error">
                            {tpl(t('rounds.failedCount'), { n: failedCount })}
                          </InfoLine>
                        )}
                        {skippedList.map((item, index) => (
                          <InfoLine key={`s-${item.id}-${index}`} icon={<AlertIcon />}>
                            {item.note !== ''
                              ? tpl(t('rounds.skippedWithNote'), {
                                  source: t(`source.${item.id}`),
                                  note: item.note,
                                })
                              : tpl(t('rounds.skippedPlain'), { source: t(`source.${item.id}`) })}
                          </InfoLine>
                        ))}
                        {skippedCount > 0 && skippedList.length === 0 && (
                          <InfoLine icon={<AlertIcon />}>
                            {tpl(t('rounds.skippedCount'), { n: skippedCount })}
                          </InfoLine>
                        )}
                        {round.error !== undefined && (
                          <InfoLine icon={<AlertIcon />} tone="error">
                            {round.error}
                          </InfoLine>
                        )}
                      </section>
                    </div>
                    {round.hasEvidence ? (
                      <RoundEvidence taskId={taskId} roundId={round.id} rev={detail.rev} active={busy} t={t} onChange={onChange} />
                    ) : !round.hasResults && !isCurrent && (
                      <div style={statusStyle}>{t('evidence.legacy')}</div>
                    )}
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

function InfoLine({
  icon,
  tone,
  children,
}: {
  icon: ReactElement
  tone?: 'error'
  children: ReactNode
}): ReactElement {
  return (
    <div style={{ ...infoLineStyle, ...(tone === 'error' ? { color: ERROR } : null) }}>
      <span style={infoIconStyle} aria-hidden>
        {icon}
      </span>
      <span style={infoTextStyle}>{children}</span>
    </div>
  )
}

const timelineStyle: CSSProperties = {
  position: 'relative',
  marginLeft: 8,
  paddingLeft: 20,
  borderLeft: '2px solid var(--ls-line-strong)',
}

const roundRowStyle: CSSProperties = {
  position: 'relative',
  marginBottom: 12,
}

const dotStyle: CSSProperties = {
  position: 'absolute',
  left: -27,
  top: 4,
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: ACCENT,
  border: '2px solid transparent',
  boxSizing: 'content-box',
}

const roundCardStyle: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--ls-line)',
  background: 'var(--ls-surface-2)',
}

const cardHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 8,
  paddingBottom: 6,
  borderBottom: '1px solid var(--ls-line)',
}

const cardActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flexWrap: 'wrap',
  gap: 8,
  marginLeft: 'auto',
}

const columnsStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
  paddingTop: 8,
}

const paneStyle: CSSProperties = {
  minWidth: 0,
  padding: '8px 10px',
  borderRadius: 6,
  background: 'var(--ls-surface)',
  border: '1px solid var(--ls-line)',
  maxHeight: 220,
  overflowY: 'auto',
}

const paneTitleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  opacity: 0.7,
  marginBottom: 6,
}

const infoLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  marginBottom: 4,
  fontSize: 11.5,
  lineHeight: 1.5,
}

const infoIconStyle: CSSProperties = {
  display: 'inline-flex',
  flexShrink: 0,
  marginTop: 1,
  opacity: 0.7,
}

const infoTextStyle: CSSProperties = {
  minWidth: 0,
  wordBreak: 'break-word',
}

/** 轮次历史弹窗比默认弹窗宽，便于左右两栏并排（默认约 540px）。 */
const WIDE_MODAL_CLASS = 'litsearch-rounds-modal'
const WIDE_MODAL_CSS = `
.${WIDE_MODAL_CLASS}{width:min(1080px,calc(100vw - 48px))}
`
