/**
 * 批量下载进度弹窗：集中展示待下载文献的实时下载状态。
 *
 * 不维护独立状态机：每篇的状态直接取任务面板的即时下载记录（`downloads`）
 * 与 Host 记录的文献状态（`states`），弹窗只做汇总展示，因此关闭再打开、
 * 刷新任务后都与列表里看到的一致。
 */

import type { CSSProperties, ReactElement } from 'react'

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import { isManualPdfFailure, type PaperState } from '../search/types'
import { SpinnerIcon } from './icons'
import { tpl, type Translate } from './locales'
import type { PdfDownloadUi } from './PaperCard'
import { ACCENT, ERROR, statusStyle } from './styles'

/** 弹窗里的一条待下载文献。标题可能暂缺（跨页选中的文献靠详情接口补齐）。 */
export interface BatchDownloadItem {
  paperId: string
  title: string
}

type BatchPhase = 'pending' | 'downloading' | 'downloaded' | 'manual' | 'failed'

const PHASE_COLOR: Record<BatchPhase, string> = {
  pending: 'rgba(127,127,127,0.9)',
  downloading: ACCENT,
  downloaded: '#2e9e5b',
  manual: '#b26a00',
  failed: ERROR,
}

interface Props {
  t: Translate
  open: boolean
  items: readonly BatchDownloadItem[]
  /** 任务详情里的文献状态（真实下载结果落在这里）。 */
  states: Record<string, PaperState>
  /** 任务面板维护的即时下载状态（下载中 / 刚完成 / 刚失败）。 */
  downloads: Readonly<Record<string, PdfDownloadUi>>
  onClose(): void
}

/** 单篇的展示状态：即时状态优先，其次回落到 Host 记录的文献状态。 */
function phaseOf(
  paperId: string,
  states: Record<string, PaperState>,
  downloads: Readonly<Record<string, PdfDownloadUi>>,
): BatchPhase {
  const runtime = downloads[paperId]
  if (runtime?.state === 'failed' && isManualPdfFailure(runtime.reason)) return 'manual'
  if (runtime?.state !== undefined) return runtime.state
  const status = states[paperId]?.pdfStatus ?? 'unknown'
  if (status === 'downloaded') return 'downloaded'
  // 刷新后运行时状态丢失，按 Host 记录的状态归类：订阅/反爬受限不是程序故障，
  // 也不能留在 pending（否则弹窗永远不会显示「完成」）。
  if (status === 'blocked' || status === 'paywalled' || status === 'html-only') return 'manual'
  if (status === 'failed' || status === 'missing') return 'failed'
  return 'pending'
}

function errorOf(
  paperId: string,
  states: Record<string, PaperState>,
  downloads: Readonly<Record<string, PdfDownloadUi>>,
): string | undefined {
  return downloads[paperId]?.error ?? states[paperId]?.pdfError
}

export function DownloadDialog({
  t,
  open,
  items,
  states,
  downloads,
  onClose,
}: Props): ReactElement {
  const phases = items.map((item) => phaseOf(item.paperId, states, downloads))
  const downloaded = phases.filter((phase) => phase === 'downloaded').length
  const downloading = phases.filter((phase) => phase === 'downloading').length
  const manual = phases.filter((phase) => phase === 'manual').length
  const failed = phases.filter((phase) => phase === 'failed').length
  const pending = phases.filter((phase) => phase === 'pending').length
  const total = items.length
  const done = total - pending - downloading
  const rate = total === 0 ? 0 : Math.round((done / total) * 100)
  // 没有待下载、也没有在下载的条目时即为完成（全都已下载时立刻完成）。
  const complete = total > 0 && pending === 0 && downloading === 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('batch.title')}
      description={tpl(t('batch.desc'), { n: total })}
      className={WIDE_MODAL_CLASS}
      footer={
        <div style={FOOTER_STYLE}>
          <span style={statusStyle}>
            {tpl(t('batch.progress'), { done, total })}
          </span>
          <Button variant="outline" size="sm" type="button" onClick={onClose}>
            {t('batch.close')}
          </Button>
        </div>
      }
    >
      <style>{WIDE_MODAL_CSS}</style>
      <div style={OVERVIEW_STYLE} role="status" aria-live="polite">
        <div style={COUNTS_STYLE}>
          <span>{tpl(t('batch.total'), { n: total })}</span>
          <span style={{ color: PHASE_COLOR.downloaded }}>
            {tpl(t('batch.downloaded'), { n: downloaded })}
          </span>
          <span style={{ color: PHASE_COLOR.downloading }}>
            {tpl(t('batch.downloading'), { n: downloading })}
          </span>
          <span>{tpl(t('batch.pending'), { n: pending })}</span>
          <span style={{ color: PHASE_COLOR.manual }}>
            {tpl(t('batch.manual'), { n: manual })}
          </span>
          <span style={{ color: PHASE_COLOR.failed }}>
            {tpl(t('batch.failed'), { n: failed })}
          </span>
        </div>
        <div style={BAR_TRACK_STYLE}>
          <div style={{ ...BAR_FILL_STYLE, width: `${rate}%` }} />
        </div>
        {complete && <div style={COMPLETE_STYLE}>{t('batch.complete')}</div>}
      </div>

      <ul style={LIST_STYLE}>
        {items.map((item, index) => {
          const phase = phases[index] ?? 'pending'
          const error =
            phase === 'failed' || phase === 'manual'
              ? errorOf(item.paperId, states, downloads)
              : undefined
          return (
            <li key={item.paperId} style={ROW_STYLE}>
              <span style={INDEX_STYLE}>{index + 1}</span>
              <div style={ROW_MAIN_STYLE}>
                <span style={ROW_TITLE_STYLE} title={item.title}>
                  {item.title === '' ? t('batch.untitled') : item.title}
                </span>
                {error !== undefined && error !== '' && (
                  <span style={ROW_ERROR_STYLE} title={error}>
                    {error}
                  </span>
                )}
              </div>
              <span style={{ ...STATUS_CHIP_STYLE, color: PHASE_COLOR[phase] }}>
                {phase === 'downloading' && <SpinnerIcon />}
                {t(`batch.status.${phase}`)}
              </span>
            </li>
          )
        })}
      </ul>
    </Modal>
  )
}

/** 批量下载弹窗的宽度约为默认弹窗的两倍（默认约 540px）。 */
const WIDE_MODAL_CLASS = 'litsearch-download-modal'
const WIDE_MODAL_CSS = `
.${WIDE_MODAL_CLASS}{width:min(1080px,calc(100vw - 48px))}
`

const FOOTER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
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

const BAR_TRACK_STYLE: CSSProperties = {
  height: 4,
  borderRadius: 2,
  background: 'rgba(127,127,127,0.22)',
  overflow: 'hidden',
}

const BAR_FILL_STYLE: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  background: ACCENT,
  transition: 'width 0.25s ease',
}

const COMPLETE_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 650,
  color: '#2e9e5b',
}

const LIST_STYLE: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  maxHeight: '50vh',
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
