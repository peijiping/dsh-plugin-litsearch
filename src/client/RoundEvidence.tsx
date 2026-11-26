import { useEffect, useState } from 'react'
import type { RoundReport } from '../search/evidence'
import { cancelTask, changeRound, fetchRoundReport } from './api'
import { tpl, type Translate } from './locales'
import { linkButtonStyle, statusStyle } from './styles'

interface Props {
  taskId: string
  roundId: string
  t: Translate
  rev: number
  active: boolean
  onChange(): void
}

export function RoundEvidence({ taskId, roundId, t, rev, active, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<RoundReport>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [operation, setOperation] = useState<'next' | 'review'>()
  const working = operation !== undefined
  const [confirmSplit, setConfirmSplit] = useState('')
  useEffect(() => {
    if (!open || working) return
    const controller = new AbortController()
    setLoading(true)
    void fetchRoundReport(taskId, roundId, controller.signal)
      .then(
        (value) => {
          if (!controller.signal.aborted) {
            setReport(value)
          }
        },
        (err) => {
          if (!controller.signal.aborted) setError(String(err))
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [open, taskId, roundId, rev, working])
  const evidence = report?.round.evidence
  const change = async (operation: 'next' | 'review', body: Record<string, unknown>) => {
    if (working || !report) return
    setOperation(operation)
    setError('')
    try {
      setReport(await changeRound(taskId, roundId, operation, { ...body, rev: report.rev }))
      setConfirmSplit('')
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOperation(undefined)
    }
  }
  const download = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = taskId + '-' + roundId + '.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const action = (label: string, click: () => void, disabled = false) => (
    <button type="button" style={linkButtonStyle} disabled={disabled} onClick={click}>
      {label}
    </button>
  )
  const mutable = report?.isCurrent && !active && !working && !loading
  return (
    <section style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
      {action(t(open ? 'evidence.close' : 'evidence.open'), () => {
        if (!open) setError('')
        setOpen(!open)
      })}
      {open && (
        <>
          {error && <p role="alert">{error}</p>}
          {!evidence && !error && <p>{t('rounds.loading')}</p>}
          {evidence && report && (
            <>
              <div>
                {tpl(t('evidence.counts'), {
                  raw:
                    report.round.stats?.rawHits ??
                    evidence.runs.reduce(
                      (n, r) => n + r.pages.reduce((sum, p) => sum + (p.committed?.kept ?? 0), 0),
                      0,
                    ),
                  ...evidence.counts,
                })}
              </div>
              {action(t('evidence.export'), download)}
              {evidence.runs.map((run) => {
                const query = report.round.conditions.queries.find((q) => q.id === run.queryId)
                const next = run.progress.lastCommittedPage + 1
                const resumable = ['ready', 'error', 'timeout', 'canceled', 'rateLimited'].includes(
                  run.progress.stopReason,
                )
                return (
                  <section
                    key={run.queryId + ':' + run.source}
                    style={{ borderTop: '1px solid var(--ls-line)', padding: '8px 0' }}
                  >
                    <strong>
                      {query?.name || run.queryId} · {t('source.' + run.source)}
                    </strong>
                    <div>
                      {tpl(t('evidence.progress'), { n: run.progress.lastCommittedPage })} ·{' '}
                      {t('evidence.stop.' + run.progress.stopReason)}
                    </div>
                    {run.progress.retryAfter && (
                      <div>
                        {t('evidence.retryAfter')} {new Date(run.progress.retryAfter).toLocaleString()}
                      </div>
                    )}
                    {resumable &&
                      report.canContinue &&
                      action(
                        tpl(
                          t(run.pages.some((p) => p.pageNo === next) ? 'evidence.retry' : 'evidence.next'),
                          { n: next },
                        ),
                        () => void change('next', { source: run.source, queryId: run.queryId, pageNo: next }),
                        !mutable,
                      )}
                    <details>
                      <summary>{t('evidence.requests')}</summary>
                      <div>
                        {t('evidence.original')} <code>{query?.text}</code>
                      </div>
                      <div>
                        {t('evidence.adapted')} <code>{run.adaptedQuery}</code>
                      </div>
                      {run.adaptation.map((a) => (
                        <div key={a.kind + a.detail}>{a.detail}</div>
                      ))}
                      {run.pages.map((page) => {
                        const c = page.committed
                        const unknown = t('evidence.unknown')
                        return (
                          <div key={page.pageNo} style={{ margin: '8px 0' }}>
                            <strong>{tpl(t('evidence.page'), { n: page.pageNo })}</strong>
                            {c && (
                              <div>
                                {tpl(t('evidence.pageCounts'), {
                                  total: c.reportedTotal ?? unknown,
                                  returned: c.returned ?? unknown,
                                  norm: c.normalized ?? unknown,
                                  observed: c.observedEntries,
                                  kept: c.kept,
                                })}
                              </div>
                            )}
                            {page.attempts.map((a, i) => (
                              <div key={i}>
                                {new Date(a.startedAt).toLocaleString()} ·{' '}
                                {t('evidence.attempt.' + a.outcome)} {a.detail}
                                {a.requests.map((r, j) => (
                                  <div key={j}>
                                    <code>
                                      {r.endpoint}{' '}
                                      {Object.entries(r.params)
                                        .map(([k, v]) => k + '=' + v)
                                        .join(' · ')}
                                    </code>
                                  </div>
                                ))}
                              </div>
                            ))}
                            {c && (
                              <details>
                                <summary>{t('evidence.positions')}</summary>
                                {c.hits.map((h) => (
                                  <div key={h.position}>
                                    #{h.sourceRank} ·{' '}
                                    {h.status === 'invalid' ? h.sourceId : report.records[h.recordId]?.title}
                                    {' · '}
                                    {h.status === 'invalid'
                                      ? t('evidence.reason.' + h.reason)
                                      : h.status === 'kept'
                                        ? t('evidence.kept')
                                        : h.reasons.map((r) => t('evidence.reason.' + r)).join(' / ')}
                                  </div>
                                ))}
                              </details>
                            )}
                          </div>
                        )
                      })}
                    </details>
                  </section>
                )
              })}
              <details>
                <summary>
                  {tpl(t('evidence.reviews'), {
                    n: evidence.reviews.filter((r) => !r.decisions.length).length,
                  })}
                </summary>
                {evidence.reviews.map((r) => (
                  <section key={r.id} style={{ margin: '8px 0' }}>
                    <strong>{t('evidence.review.' + r.reason)}</strong>
                    <div>{r.evidence.join(' · ')}</div>
                    {r.recordIds.map((id) => {
                      const record = report.records[id]
                      return (
                        record && (
                          <div key={id}>
                            {t('source.' + record.source)} · {record.title} · {record.doi || record.sourceId}
                          </div>
                        )
                      )
                    })}
                    {r.decisions.length ? (
                      <div>{t('evidence.decision.' + r.decisions.at(-1)!.action)}</div>
                    ) : r.reason === 'screeningConflict' ? (
                      r.stateCandidates?.map((c) => (
                        <div key={c.originalPaperId}>
                          {c.originalPaperId} ·{' '}
                          {action(
                            t('evidence.choose') + ' ' + t('screening.' + c.state.screening),
                            () =>
                              void change('review', {
                                action: 'resolveScreening',
                                subject: r.id,
                                choice: c.originalPaperId,
                              }),
                            !mutable,
                          )}
                        </div>
                      ))
                    ) : (
                      <div>
                        {action(
                          t('evidence.separate'),
                          () => void change('review', { action: 'keepSeparate', subject: r.id }),
                          !mutable,
                        )}{' '}
                        {action(
                          t('evidence.version'),
                          () => void change('review', { action: 'linkVersions', subject: r.id }),
                          !mutable,
                        )}
                      </div>
                    )}
                  </section>
                ))}
              </details>
              <details>
                <summary>{t('evidence.members')}</summary>
                {evidence.groups
                  .filter((g) => g.members.length > 1)
                  .map((g) => (
                    <div key={g.paperId} style={{ margin: '8px 0' }}>
                      <strong>{report.records[g.members[0]]?.title}</strong>
                      <div>
                        {g.members.map((id) => t('source.' + report.records[id]?.source)).join(' + ')}
                      </div>
                      <small>{g.matches.map((m) => m.field + '=' + m.value).join(' · ')}</small>
                      {mutable && (
                        <div>
                          {confirmSplit === g.paperId ? (
                            <>
                              {action(
                                t('evidence.confirmSplit'),
                                () => void change('review', { action: 'split', subject: g.paperId }),
                              )}{' '}
                              {action(t('evidence.cancel'), () => setConfirmSplit(''))}
                            </>
                          ) : (
                            action(t('evidence.split'), () => setConfirmSplit(g.paperId))
                          )}
                        </div>
                      )}
                    </div>
                  ))}
              </details>
              {working && (
                <div>
                  <p style={statusStyle} role="status">
                    {t('evidence.working')}
                  </p>
                  {operation === 'next' &&
                    action(
                      t('task.cancel'),
                      () => void cancelTask(taskId).catch((err) => setError(String(err))),
                    )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
