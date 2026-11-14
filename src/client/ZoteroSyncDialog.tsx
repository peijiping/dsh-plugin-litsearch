/**
 * Zotero 同步弹窗：先选目标目录，再逐篇同步，并实时显示每篇的结果。
 *
 * 与下载弹窗一致：逐篇调用 Host（单篇一次请求），因此能实时展示进度；
 * 最终状态由 Host 写回任务，关掉弹窗再打开仍能看到「已同步」。
 */

import type { CSSProperties, ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type { PaperState, ZoteroTarget } from '../search/types'
import { fetchZoteroTargets, syncZotero } from './api'
import type { BatchDownloadItem } from './DownloadDialog'
import { SpinnerIcon } from './icons'
import { tpl, type Translate } from './locales'
import { ACCENT, ERROR, statusStyle } from './styles'

type RowPhase = 'pending' | 'syncing' | 'synced' | 'failed'

interface Row {
  paperId: string
  title: string
  phase: RowPhase
  error?: string
  note?: string
}

const PHASE_COLOR: Record<RowPhase, string> = {
  pending: 'rgba(127,127,127,0.9)',
  syncing: ACCENT,
  synced: '#2e9e5b',
  failed: ERROR,
}

interface Props {
  t: Translate
  open: boolean
  taskId: string
  items: readonly BatchDownloadItem[]
  states: Record<string, PaperState>
  onClose(): void
  /** 同步结束后回调（失败文献 id 用于展示 RIS 兜底）。 */
  onDone(failedPaperIds: readonly string[]): void
}

function initialRows(
  items: readonly BatchDownloadItem[],
  states: Record<string, PaperState>,
): Row[] {
  return items.map((item) => {
    const state = states[item.paperId]
    const phase: RowPhase =
      state?.zoteroStatus === 'synced'
        ? 'synced'
        : state?.zoteroStatus === 'failed'
          ? 'failed'
          : 'pending'
    return {
      paperId: item.paperId,
      title: item.title,
      phase,
      ...(state?.zoteroError === undefined ? {} : { error: state.zoteroError }),
      ...(phase === 'synced' && state?.zoteroCollection !== undefined
        ? { note: state.zoteroCollection }
        : {}),
    }
  })
}

function targetLabel(t: Translate, target: ZoteroTarget, currentId?: string): string {
  const indent = '\u3000'.repeat(Math.max(0, target.level))
  const suffix =
    target.filesEditable === false
      ? ` ${t('zotero.dialog.readonly')}`
      : target.id === currentId
        ? ` ${t('zotero.dialog.current')}`
        : ''
  return `${indent}${target.name}${suffix}`
}

export function ZoteroSyncDialog({
  t,
  open,
  taskId,
  items,
  states,
  onClose,
  onDone,
}: Props): ReactElement {
  const [rows, setRows] = useState<Row[]>(() => initialRows(items, states))
  const [targets, setTargets] = useState<ZoteroTarget[]>([])
  const [currentId, setCurrentId] = useState<string | undefined>(undefined)
  const [targetId, setTargetId] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [hasRun, setHasRun] = useState(false)
  /** 取消后停止派发剩余文献；已发出的请求仍会完成。 */
  const stopRef = useRef(false)

  const key = items.map((item) => item.paperId).join(',')

  // 每次打开（或换了一批文献）都重置进度，并重新读取目录列表。
  useEffect(() => {
    if (!open) return
    setRows(initialRows(items, states))
    setHasRun(false)
    setNotice(undefined)
    setLoadError(undefined)
    let cancelled = false
    setLoading(true)
    fetchZoteroTargets()
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          setTargets([])
          setLoadError(result.error ?? t('zotero.dialog.unknownError'))
          return
        }
        setTargets(result.targets)
        setCurrentId(result.current?.id)
        setTargetId(result.current?.id ?? result.targets[0]?.id ?? '')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setTargets([])
        setLoadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // key 覆盖「同一弹窗内切换文献」；items/states 的引用变化不触发重置。
  }, [open, key])

  const target = targets.find((entry) => entry.id === targetId)
  const total = rows.length
  const synced = rows.filter((row) => row.phase === 'synced').length
  const failed = rows.filter((row) => row.phase === 'failed').length
  const pending = rows.filter((row) => row.phase === 'pending').length
  const syncing = rows.filter((row) => row.phase === 'syncing').length
  const done = total - pending - syncing
  const rerunHint = rows.some((row) => row.phase === 'synced')

  const run = async (): Promise<void> => {
    if (running || target === undefined) return
    setRunning(true)
    setNotice(undefined)
    setHasRun(true)
    stopRef.current = false
    const list = rows.map((row) => ({ ...row, phase: 'pending' as RowPhase, error: undefined, note: undefined }))
    setRows(list)
    const failedIds: string[] = []

    for (let index = 0; index < list.length; index += 1) {
      if (stopRef.current) break
      const row = list[index]!
      setRows((prev) =>
        prev.map((entry) =>
          entry.paperId === row.paperId ? { ...entry, phase: 'syncing', error: undefined } : entry,
        ),
      )
      try {
        const result = await syncZotero(taskId, [row.paperId], {
          id: target.id,
          name: target.name,
          ...(target.filesEditable === undefined ? {} : { filesEditable: target.filesEditable }),
        })
        const item = result.items[0]
        const ok = item?.ok ?? result.ok
        const note = item?.ok === true ? result.messages[0] : undefined
        if (!ok) failedIds.push(row.paperId)
        setRows((prev) =>
          prev.map((entry) =>
            entry.paperId === row.paperId
              ? {
                  ...entry,
                  phase: ok ? 'synced' : 'failed',
                  ...(ok
                    ? note === undefined
                      ? {}
                      : { note }
                    : { error: item?.error ?? result.messages[0] ?? t('zotero.dialog.failFallback') }),
                }
              : entry,
          ),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const rest = list.slice(index).map((entry) => entry.paperId)
        failedIds.push(...rest)
        setRows((prev) =>
          prev.map((entry) =>
            rest.includes(entry.paperId)
              ? { ...entry, phase: 'failed', error: message }
              : entry,
          ),
        )
        setNotice(message)
        break
      }
    }
    setRunning(false)
    onDone(failedIds)
  }

  const summary = running
    ? t('zotero.dialog.running')
    : done > 0 && failed === 0 && pending === 0
      ? tpl(t('zotero.dialog.done'), { n: synced })
      : done > 0
        ? tpl(t('zotero.dialog.partial'), { saved: synced, failed })
        : undefined

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!running) onClose()
      }}
      title={t('zotero.dialog.title')}
      description={tpl(t('zotero.dialog.desc'), { n: total })}
      className={WIDE_MODAL_CLASS}
      footer={
        <div style={FOOTER_STYLE}>
          <span style={statusStyle}>{tpl(t('zotero.dialog.progress'), { done, total })}</span>
          <div style={ACTIONS_STYLE}>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => {
                if (running) {
                  // 只停止派发后续文献，已在途的请求会正常结束并写回状态。
                  stopRef.current = true
                } else {
                  onClose()
                }
              }}
            >
              {running ? t('zotero.dialog.cancel') : t('zotero.dialog.close')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={run}
              disabled={running || loading || target === undefined}
            >
              {running
                ? t('zotero.dialog.syncing')
                : hasRun || rerunHint
                  ? t('zotero.dialog.resync')
                  : t('zotero.dialog.sync')}
            </Button>
          </div>
        </div>
      }
    >
      <style>{WIDE_MODAL_CSS}</style>

      <div style={TARGET_BOX_STYLE}>
        <label style={TARGET_LABEL_STYLE} htmlFor="litsearch-zotero-target">
          {t('zotero.dialog.target')}
        </label>
        {loading ? (
          <span style={MUTED_STYLE}>{t('zotero.dialog.loading')}</span>
        ) : loadError !== undefined ? (
          <span style={ERROR_TEXT_STYLE} title={loadError}>
            {tpl(t('zotero.dialog.loadFail'), { message: loadError })}
          </span>
        ) : targets.length === 0 ? (
          <span style={MUTED_STYLE}>{t('zotero.dialog.noTarget')}</span>
        ) : (
          <select
            id="litsearch-zotero-target"
            style={SELECT_STYLE}
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            disabled={running}
          >
            {targets.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {targetLabel(t, entry, currentId)}
              </option>
            ))}
          </select>
        )}
        {rerunHint && <div style={HINT_STYLE}>{t('zotero.dialog.rerunHint')}</div>}
      </div>

      <div style={OVERVIEW_STYLE} role="status" aria-live="polite">
        <div style={COUNTS_STYLE}>
          <span>{tpl(t('zotero.dialog.total'), { n: total })}</span>
          <span style={{ color: PHASE_COLOR.synced }}>
            {tpl(t('zotero.dialog.synced'), { n: synced })}
          </span>
          <span style={{ color: PHASE_COLOR.syncing }}>
            {tpl(t('zotero.dialog.syncingCount'), { n: syncing })}
          </span>
          <span>{tpl(t('zotero.dialog.pending'), { n: pending })}</span>
          <span style={{ color: PHASE_COLOR.failed }}>
            {tpl(t('zotero.dialog.failed'), { n: failed })}
          </span>
        </div>
        {summary !== undefined && (
          <div style={{ ...SUMMARY_STYLE, color: failed > 0 ? ERROR : '#2e9e5b' }}>
            {running && <SpinnerIcon />}
            {summary}
          </div>
        )}
        {notice !== undefined && (
          <div style={ERROR_TEXT_STYLE} title={notice}>
            {notice}
          </div>
        )}
      </div>

      <ul style={LIST_STYLE}>
        {rows.map((row, index) => (
          <li key={row.paperId} style={ROW_STYLE}>
            <span style={INDEX_STYLE}>{index + 1}</span>
            <div style={ROW_MAIN_STYLE}>
              <span style={ROW_TITLE_STYLE} title={row.title}>
                {row.title === '' ? t('zotero.dialog.untitled') : row.title}
              </span>
              {row.error !== undefined && row.error !== '' && (
                <span style={ROW_ERROR_STYLE} title={row.error}>
                  {row.error}
                </span>
              )}
              {row.error === undefined && row.note !== undefined && row.note !== '' && (
                <span style={ROW_NOTE_STYLE} title={row.note}>
                  {row.note}
                </span>
              )}
            </div>
            <span style={{ ...STATUS_CHIP_STYLE, color: PHASE_COLOR[row.phase] }}>
              {row.phase === 'syncing' && <SpinnerIcon />}
              {t(`zotero.dialog.status.${row.phase}`)}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

const WIDE_MODAL_CLASS = 'litsearch-zotero-modal'
const WIDE_MODAL_CSS = `
.${WIDE_MODAL_CLASS}{width:min(760px,calc(100vw - 48px))}
`

const FOOTER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}

const TARGET_BOX_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginBottom: 10,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid rgba(80,140,255,0.25)',
  background: 'rgba(80,140,255,0.06)',
}

const TARGET_LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 650,
  opacity: 0.7,
}

const SELECT_STYLE: CSSProperties = {
  width: '100%',
  padding: '4px 6px',
  fontSize: 12.5,
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'transparent',
  color: 'inherit',
}

const HINT_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  opacity: 0.7,
}

const OVERVIEW_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginBottom: 8,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid rgba(80,140,255,0.25)',
  background: 'rgba(80,140,255,0.08)',
}

const COUNTS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  fontSize: 12,
  lineHeight: 1.5,
}

const SUMMARY_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  fontWeight: 650,
}

const MUTED_STYLE: CSSProperties = {
  fontSize: 12,
  opacity: 0.7,
}

const ERROR_TEXT_STYLE: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  color: ERROR,
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  wordBreak: 'break-word',
}

const LIST_STYLE: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  maxHeight: '46vh',
  overflowY: 'auto',
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '7px 0',
  borderTop: '1px solid rgba(127,127,127,0.18)',
}

const INDEX_STYLE: CSSProperties = {
  flexShrink: 0,
  minWidth: 18,
  fontSize: 11,
  lineHeight: '18px',
  opacity: 0.5,
  textAlign: 'right',
}

const ROW_MAIN_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  flex: 1,
  minWidth: 0,
}

const ROW_TITLE_STYLE: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.45,
  fontWeight: 600,
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  wordBreak: 'break-word',
}

const ROW_ERROR_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  color: ERROR,
  opacity: 0.85,
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  wordBreak: 'break-word',
}

const ROW_NOTE_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  opacity: 0.65,
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 1,
  WebkitBoxOrient: 'vertical',
  wordBreak: 'break-word',
}

const STATUS_CHIP_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  flexShrink: 0,
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid currentColor',
  fontSize: 11,
  lineHeight: 1.5,
  whiteSpace: 'nowrap',
}
