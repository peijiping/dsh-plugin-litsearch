/**
 * Zotero 同步弹窗：先选目标目录，再逐篇同步，并实时显示每篇的结果。
 *
 * 与下载弹窗一致：逐篇调用 Host（单篇一次请求），因此能实时展示进度；
 * 最终状态由 Host 写回任务，关掉弹窗再打开仍能看到「已同步」。
 *
 * 模型发起时额外带 `meta`：展示范围说明与用户原话；若对话里点名了目录且
 * Host 已核实，则预选该目录并自动开跑，否则保持「选目录 → 点同步」原样。
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
  /** 命中数据源 / `期刊 · 年份`；模型发起时由 Host 直接带上，便于核对。 */
  source?: string
  meta?: string
}

/** 模型发起的 Zotero 同步：弹窗展示信息与自动执行开关。 */
export interface ZoteroCommandMeta {
  origin: 'model'
  /** Host 生成的中文范围说明（含篇数），这里只展示。 */
  scopeLabel: string
  /** 模型复述的用户意图。 */
  reason: string
  /** 对话里点名、且已在 Zotero 目录列表里核实过的目标目录。 */
  initialTarget?: ZoteroTarget
  /** true = 目录已确定，弹窗加载完立即自动同步；false = 等用户选目录。 */
  autoStart: boolean
}

/** 批量同步的并发数，与批量下载保持一致。 */
const SYNC_CONCURRENCY = 5

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
  /** 模型发起时传入；不传则与手动同步完全一致。 */
  meta?: ZoteroCommandMeta
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
      ...(item.source === undefined || item.source === '' ? {} : { source: item.source }),
      ...(item.meta === undefined || item.meta === '' ? {} : { meta: item.meta }),
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
  meta,
}: Props): ReactElement {
  const [rows, setRows] = useState<Row[]>(() => initialRows(items, states))
  const [targets, setTargets] = useState<ZoteroTarget[]>([])
  const [currentId, setCurrentId] = useState<string | undefined>(undefined)
  const [targetId, setTargetId] = useState<string>('')
  const [loading, setLoading] = useState(false)
  /** 目录列表本轮是否已读完（含失败）；自动同步必须等它就绪，避免用到上一批目录。 */
  const [targetsReady, setTargetsReady] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [hasRun, setHasRun] = useState(false)
  /** 取消后停止派发剩余文献；已发出的请求仍会完成。 */
  const stopRef = useRef(false)
  /** 自动同步只跑一次；每次打开/换清单时重置。 */
  const autoStartRef = useRef(false)

  const key = items.map((item) => item.paperId).join(',')
  const desiredId = meta?.initialTarget?.id
  const desiredName = meta?.initialTarget?.name ?? ''

  // 每次打开（或换了一批文献）都重置进度，并重新读取目录列表。
  useEffect(() => {
    if (!open) return
    setRows(initialRows(items, states))
    setHasRun(false)
    setNotice(undefined)
    setLoadError(undefined)
    setTargetsReady(false)
    setTargets([])
    setTargetId('')
    autoStartRef.current = false
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
        // 模型点名了目录就预选它；目录已被删掉时回落到当前目录，并提示用户自己选。
        const matched =
          desiredId === undefined
            ? undefined
            : result.targets.find((entry) => entry.id === desiredId)
        if (desiredId !== undefined && matched === undefined) {
          setNotice(tpl(t('zotero.dialog.modelTargetMissing'), { name: desiredName }))
        }
        setTargetId(matched?.id ?? result.current?.id ?? result.targets[0]?.id ?? '')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setTargets([])
        setLoadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        setTargetsReady(true)
      })
    return () => {
      cancelled = true
    }
    // key 覆盖「同一弹窗内切换文献」；items/states 的引用变化不触发重置。
    // desiredId 变化时（连发两条不同目录的指令）也要重读目录并重新预选。
  }, [open, key, desiredId])

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

    const runOne = async (row: Row): Promise<void> => {
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
        // 连接层面的错误（Zotero 没开、目录失效）：记下原因并停止派发后续文献。
        const message = error instanceof Error ? error.message : String(error)
        stopRef.current = true
        failedIds.push(row.paperId)
        setRows((prev) =>
          prev.map((entry) =>
            entry.paperId === row.paperId ? { ...entry, phase: 'failed', error: message } : entry,
          ),
        )
        setNotice(message)
      }
    }

    // 固定 5 个 worker 从同一个游标取任务：并发不超过 5，也不会重复同步同一篇。
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (!stopRef.current && cursor < list.length) {
        const row = list[cursor]
        cursor += 1
        if (row !== undefined) await runOne(row)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(SYNC_CONCURRENCY, list.length) }, () => worker()),
    )
    setRunning(false)
    onDone(failedIds)
  }

  // 模型点名了目录：等目录加载完、预选生效后自动开跑一次（ref 防重复）。
  // 目录读不到 / 指定目录不在列表里时一律退回手动，绝不猜一个目录就写入数据。
  useEffect(() => {
    if (!open || loading || !targetsReady || meta?.autoStart !== true || autoStartRef.current) return
    if (running) return
    if (desiredId === undefined) {
      autoStartRef.current = true
      return
    }
    if (target === undefined || target.id !== desiredId) {
      // targetId 还是旧值时不要提前判失败；只有目录确实加载完了才收口。
      if (loadError !== undefined || targets.length === 0) {
        autoStartRef.current = true
        setNotice(t('zotero.dialog.modelNoAuto'))
      } else if (!targets.some((entry) => entry.id === desiredId)) {
        autoStartRef.current = true
      }
      return
    }
    autoStartRef.current = true
    void run()
    // run 每次渲染都是新函数，故意不进依赖；ref + running 保证只执行一次。
  }, [
    open,
    loading,
    targetsReady,
    running,
    target,
    targets,
    loadError,
    desiredId,
    meta?.autoStart,
  ])

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
      title={meta === undefined ? t('zotero.dialog.title') : t('zotero.dialog.modelTitle')}
      description={tpl(
        meta === undefined
          ? t('zotero.dialog.desc')
          : meta.autoStart
            ? t('zotero.dialog.modelDescAuto')
            : t('zotero.dialog.modelDescPick'),
        { n: total },
      )}
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
        {meta?.initialTarget !== undefined && (
          <div style={HINT_STYLE}>
            {tpl(t('zotero.dialog.modelTarget'), { name: meta.initialTarget.name })}
          </div>
        )}
        {rerunHint && <div style={HINT_STYLE}>{t('zotero.dialog.rerunHint')}</div>}
      </div>

      <div style={OVERVIEW_STYLE} role="status" aria-live="polite">
        {meta !== undefined && (
          <div style={MODEL_BADGE_STYLE}>
            <span style={MODEL_TAG_STYLE}>{t('zotero.dialog.originModel')}</span>
            {meta.scopeLabel !== '' && <span>{meta.scopeLabel}</span>}
            {meta.reason !== '' && (
              <span style={REASON_STYLE} title={meta.reason}>
                {meta.reason}
              </span>
            )}
          </div>
        )}
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
              {(row.source !== undefined && row.source !== '') ||
              (row.meta !== undefined && row.meta !== '') ? (
                <span style={ROW_META_STYLE}>
                  {[
                    row.source === undefined || row.source === ''
                      ? ''
                      : tpl(t('zotero.dialog.source'), { source: row.source }),
                    row.meta ?? '',
                  ]
                    .filter((part) => part !== '')
                    .join(' · ')}
                </span>
              ) : null}
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

const MODEL_BADGE_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  lineHeight: 1.5,
  paddingBottom: 4,
  borderBottom: '1px solid rgba(127,127,127,0.18)',
}

const MODEL_TAG_STYLE: CSSProperties = {
  flexShrink: 0,
  padding: '1px 6px',
  borderRadius: 4,
  border: `1px solid ${ACCENT}`,
  color: ACCENT,
  fontWeight: 650,
  fontSize: 11,
}

const REASON_STYLE: CSSProperties = {
  opacity: 0.75,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '100%',
}

const ROW_META_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  opacity: 0.65,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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
