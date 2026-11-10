/**
 * 开放获取全文定位：候选 PDF 与 Europe PMC HTML 全文。
 *
 * 候选只负责“可能在哪”，真正的下载与安全校验在 Host 侧（`host/pdf/store.ts`）。
 */

import type { Paper } from './types.js'

const EPMC_REST = 'https://www.ebi.ac.uk/europepmc/webservices/rest'
const EPMC_ARTICLE = 'https://europepmc.org/articles'
const PMC_ARTICLE = 'https://www.ncbi.nlm.nih.gov/pmc/articles'
const ARXIV_PDF = 'https://arxiv.org/pdf'
const UNPAYWALL_API = 'https://api.unpaywall.org/v2'

/** 去重后的 PDF 候选地址（顺序即尝试优先级）。 */
export function pdfCandidates(paper: Paper): string[] {
  const candidates = new Set<string>()
  if (paper.pdfUrl !== '') candidates.add(paper.pdfUrl)
  const pmcid = normalizePmcid(paper.ids.pmcid)
  if (pmcid !== '') {
    candidates.add(`${EPMC_ARTICLE}/${pmcid}?pdf=render`)
    candidates.add(`${PMC_ARTICLE}/${pmcid}/pdf/`)
  }
  if (paper.ids.arxivId !== '') candidates.add(`${ARXIV_PDF}/${paper.ids.arxivId}`)
  return [...candidates]
}

/** Europe PMC 的全文 XML 地址；没有 PMCID 时返回 null。 */
export function epmcXmlUrl(paper: Paper): string | null {
  const pmcid = normalizePmcid(paper.ids.pmcid)
  return pmcid === '' ? null : `${EPMC_REST}/${pmcid}/fullTextXML`
}

/** Unpaywall 查询（需要联系邮箱，遵守其 polite pool）。 */
export async function unpaywallPdfCandidates(
  doi: string,
  email: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  if (doi === '' || email === '') return []
  const url = `${UNPAYWALL_API}/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return []
    const body = (await response.json()) as Record<string, unknown>
    const urls = new Set<string>()
    const best = asRecord(body['best_oa_location'])
    const bestPdf = asString(best['url_for_pdf'])
    if (bestPdf !== '') urls.add(bestPdf)
    for (const raw of asArray(body['oa_locations'])) {
      const pdf = asString(asRecord(raw)['url_for_pdf'])
      if (pdf !== '') urls.add(pdf)
    }
    return [...urls]
  } catch {
    return []
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function normalizePmcid(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  return /^\d+$/u.test(trimmed) ? `PMC${trimmed}` : trimmed
}

/**
 * JATS XML → 可读 HTML 片段。
 *
 * 只保留标题、段落、列表等结构，其余标签一律剥离；所有文本先转义，
 * 因此上游 XML 里的脚本/属性不会进入阅读页。
 */
export function jatsToHtml(xml: string): string {
  let body = xml
  const start = body.indexOf('<body')
  const end = body.lastIndexOf('</body>')
  if (start >= 0 && end > start) body = body.slice(start, end + '</body>'.length)
  body = body.replace(/<back[\s\S]*?<\/back>/gu, '')
  body = body.replace(/<ref-list[\s\S]*?<\/ref-list>/gu, '')

  const P_OPEN = '\u0001popen\u0001'
  const P_CLOSE = '\u0001pclose\u0001'
  const T_OPEN = '\u0001h3open\u0001'
  const T_CLOSE = '\u0001h3close\u0001'
  const LI_OPEN = '\u0001li_open\u0001'
  const LI_CLOSE = '\u0001li_close\u0001'
  const UL_OPEN = '\u0001ul_open\u0001'
  const UL_CLOSE = '\u0001ul_close\u0001'

  let marked = body.replace(/<(\/?)p\b[^>]*>/gu, (_match, close: string) =>
    close === '/' ? P_CLOSE : P_OPEN,
  )
  marked = marked.replace(/<(\/?)title\b[^>]*>/gu, (_match, close: string) =>
    close === '/' ? T_CLOSE : T_OPEN,
  )
  marked = marked.replace(/<(\/?)list-item\b[^>]*>/gu, (_match, close: string) =>
    close === '/' ? LI_CLOSE : LI_OPEN,
  )
  marked = marked.replace(/<(\/?)list\b[^>]*>/gu, (_match, close: string) =>
    close === '/' ? UL_CLOSE : UL_OPEN,
  )

  const text = marked.replace(/<[^>]+>/gu, ' ').replace(/[ \t]+/gu, ' ')
  const escaped = escapeHtml(text)
  return escaped
    .replace(/\u0001popen\u0001/gu, '<p>')
    .replace(/\u0001pclose\u0001/gu, '</p>')
    .replace(/\u0001h3open\u0001/gu, '<h3>')
    .replace(/\u0001h3close\u0001/gu, '</h3>')
    .replace(/\u0001li_open\u0001/gu, '<li>')
    .replace(/\u0001li_close\u0001/gu, '</li>')
    .replace(/\u0001ul_open\u0001/gu, '<ul>')
    .replace(/\u0001ul_close\u0001/gu, '</ul>')
}

/** 包一层最小阅读页样式。 */
export function fullTextHtml(paper: Paper, fragment: string, source: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(paper.title)}</title>
<style>
  body { margin: 0; padding: 16px; font: 14px/1.7 -apple-system, "PingFang SC", sans-serif; color: #222; }
  h1 { font-size: 18px; line-height: 1.4; margin: 0 0 4px; }
  h3 { font-size: 15px; margin: 18px 0 6px; }
  p { margin: 0 0 10px; }
  .meta { font-size: 12px; color: #666; margin-bottom: 16px; }
  a { color: #2563eb; }
</style>
</head>
<body>
<h1>${escapeHtml(paper.title)}</h1>
<div class="meta">${escapeHtml(source)} · <a href="${escapeHtml(paper.url)}" target="_blank" rel="noreferrer">原文</a></div>
${fragment}
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
