/**
 * 「下载 PDF / 查看已下载」与「存入 Zotero」按钮的状态、文案与颜色推导。
 *
 * 结果卡片、论文页与全文台账共用同一套规则，保证同一篇文献在不同面板上的
 * 标签、提示、进度反馈与状态色完全一致。
 */

import type { OaLocation, Paper, PaperState, PdfFailureReason, PdfStatus } from '../search/types'
import { tpl, type Translate } from './locales'

/** 单篇下载的进行中 / 已完成状态（由任务面板维护，跨 reload 保留）。 */
export interface PdfDownloadUi {
  state: 'downloading' | 'downloaded' | 'failed'
  /** 下载成功后的绝对路径。 */
  path?: string
  error?: string
  /** Host 返回的失败根因；用于区分「程序故障」与「需手动保存」。 */
  reason?: PdfFailureReason
  /** Host 返回的可点击全文位置，失败时用于渲染动作条。 */
  links?: OaLocation[]
}

/** 出版商明确要求订阅 / 拒绝访问时，不再提供「下载 PDF」，避免必然失败的操作。 */
const NO_PDF_STATUSES: ReadonlySet<PdfStatus> = new Set(['paywalled', 'blocked'])

/** 这篇文献是否展示「下载 PDF」：状态允许且还有可尝试的全文入口。 */
export function canDownloadPdf(paper: Paper, status: PdfStatus): boolean {
  return (
    !NO_PDF_STATUSES.has(status) &&
    (paper.pdfUrl !== '' || paper.ids.pmcid !== '' || paper.ids.arxivId !== '' || paper.doi !== '')
  )
}

export function paperPdfStatus(paper: Paper, state?: PaperState): PdfStatus {
  return state?.pdfStatus ?? (paper.pdfUrl === '' ? 'unknown' : 'available')
}

export interface PdfActionUi {
  downloading: boolean
  downloaded: boolean
  downloadedPath?: string
  pdfMissing: boolean
  failedMessage?: string
  label: string
  hint: string
  /** 已下载绿色 / 文件缺失警示色；普通状态不设颜色。 */
  color?: string
}

/**
 * 单篇下载按钮的展示状态。即时下载结果优先于 Host 记录的文献状态；
 * 文件被删除（missing）优先于本地下载记录，避免删文件后按钮仍是「查看已下载」。
 */
export function pdfActionUi({
  paper,
  state,
  download,
  downloadDir,
  t,
}: {
  paper: Paper
  state?: PaperState
  download?: PdfDownloadUi
  /** PDF 保存目录，用于下载按钮的悬停提示。 */
  downloadDir?: string
  t: Translate
}): PdfActionUi {
  const status = paperPdfStatus(paper, state)
  const downloading = download?.state === 'downloading'
  const pdfMissing = !downloading && status === 'missing'
  const downloaded =
    !pdfMissing &&
    (download?.state === 'downloaded' || (status === 'downloaded' && !downloading))
  const downloadedPath = downloaded ? download?.path ?? state?.pdfFile : undefined
  const failedMessage =
    download?.state === 'failed'
      ? download.error
      : status === 'failed'
        ? state?.pdfError
        : undefined
  const label = downloading
    ? t('pdf.downloading')
    : downloaded
      ? t('pdf.downloadedAction')
      : pdfMissing
        ? t('pdf.missingAction')
        : status === 'failed'
          ? t('pdf.retry')
          : t('pdf.download')
  const hint = downloading
    ? t('pdf.downloadingHint')
    : downloaded
      ? tpl(t('pdf.downloadedHint'), { path: downloadedPath ?? downloadDir ?? '' })
      : pdfMissing
        ? t('pdf.missingHint')
        : failedMessage !== undefined
          ? tpl(t('pdf.retryHint'), { message: failedMessage })
          : tpl(t('pdf.downloadHint'), { path: downloadDir ?? t('pdf.downloadDirUnknown') })
  const color = pdfMissing
    ? 'var(--ls-error)'
    : downloaded
      ? 'var(--ls-success)'
      : undefined
  return {
    downloading,
    downloaded,
    pdfMissing,
    label,
    hint,
    ...(downloadedPath === undefined ? {} : { downloadedPath }),
    ...(failedMessage === undefined ? {} : { failedMessage }),
    ...(color === undefined ? {} : { color }),
  }
}

export interface ZoteroActionUi {
  label: string
  hint?: string
  color?: string
}

/** 「存入 Zotero」按钮：文字回显上次同步结果，悬停看目标目录或失败原因。 */
export function zoteroActionUi(t: Translate, state?: PaperState): ZoteroActionUi {
  if (state?.zoteroStatus === 'synced') {
    return { label: t('pdf.zoteroSynced'), hint: state.zoteroCollection, color: 'var(--ls-success)' }
  }
  if (state?.zoteroStatus === 'failed') {
    return { label: t('pdf.zoteroRetry'), hint: state.zoteroError, color: 'var(--ls-error)' }
  }
  return { label: t('pdf.zotero') }
}
