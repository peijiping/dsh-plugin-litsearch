/**
 * 开放获取全文定位：候选位置、Unpaywall 补充与 EPMC/arXiv 网页全文。
 *
 * 候选只负责「可能在哪」，真正的下载与安全校验在 Host 侧（`host/pdf/store.ts`）。
 * 本文件只依赖类型与纯函数，可被 node:test 直接以 `.ts` 运行。
 */

import type { OaLocation, OaSource, Paper } from './types.js'

const EPMC_REST = 'https://www.ebi.ac.uk/europepmc/webservices/rest'
const EPMC_ARTICLE = 'https://europepmc.org/articles'
const PMC_ARTICLE = 'https://www.ncbi.nlm.nih.gov/pmc/articles'
const ARXIV_PDF = 'https://arxiv.org/pdf'
const ARXIV_HTML = 'https://arxiv.org/html'
const UNPAYWALL_API = 'https://api.unpaywall.org/v2'

const RENDER_HOSTS = ['europepmc.org', 'www.ncbi.nlm.nih.gov']

/** 规范化去重键：小写 scheme/host、去默认端口、去 fragment、保留 query。 */
export function oaUrlKey(raw: string): string {
  const value = raw.trim()
  if (value === '') return ''
  try {
    const url = new URL(value)
    url.hash = ''
    if (url.protocol === 'http:') url.protocol = 'https:'
    url.hostname = url.hostname.toLowerCase()
    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
    ) {
      url.port = ''
    }
    return url.toString()
  } catch {
    return value
  }
}

/** 仓储的 PDF 渲染页：浏览器能开、后台请求普遍被拦，排到最后兜底。 */
export function isPdfRenderUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (!RENDER_HOSTS.includes(host)) return false
    return /\?pdf=render/iu.test(parsed.search) || /\/pdf\/?$/u.test(parsed.pathname)
  } catch {
    return false
  }
}

/** 按 URL 并集合并；多源命中写入 `alsoIn`，`oa / best / license` 取并集。 */
export function mergeOaLocations(lists: readonly (readonly OaLocation[])[]): OaLocation[] {
  const merged = new Map<string, OaLocation>()
  for (const list of lists) {
    for (const location of list) {
      const url = location.url.trim()
      if (url === '') continue
      const key = oaUrlKey(url)
      const existing = merged.get(key)
      if (existing === undefined) {
        merged.set(key, {
          url,
          kind: location.kind,
          source: location.source,
          oa: location.oa,
          ...(location.best === true ? { best: true } : {}),
          ...(location.license === undefined || location.license === ''
            ? {}
            : { license: location.license }),
          ...(location.textMining === true ? { textMining: true } : {}),
        })
        continue
      }
      if (existing.source !== location.source) {
        const alsoIn = new Set<OaSource>(existing.alsoIn ?? [])
        alsoIn.add(location.source)
        existing.alsoIn = [...alsoIn]
      }
      existing.oa = existing.oa || location.oa
      if (location.best === true) existing.best = true
      if (existing.license === undefined && location.license !== undefined) {
        existing.license = location.license
      }
      // 同一 URL 既被判 landing 又被判 pdf 时，以信息量更大的 pdf 为准。
      if (location.kind === 'pdf' && existing.kind !== 'pdf') existing.kind = 'pdf'
    }
  }
  return [...merged.values()]
}

/** 三档排序；同档保持来源顺序，`best` 提前。 */
export function rankOaLocations(list: readonly OaLocation[]): OaLocation[] {
  return list
    .map((location, index) => ({ location, index, tier: tierOf(location) }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier
      const bestA = a.location.best === true ? 0 : 1
      const bestB = b.location.best === true ? 0 : 1
      if (bestA !== bestB && a.tier === 0) return bestA - bestB
      return a.index - b.index
    })
    .map((entry) => entry.location)
}

function tierOf(location: OaLocation): number {
  if (location.kind !== 'pdf') return 3
  if (isPdfRenderUrl(location.url)) return 2
  return location.oa ? 0 : 1
}

/** 可作为自动下载候选的 URL（排除订阅页与 text-mining 专用链接）。 */
export function pdfLinksOf(list: readonly OaLocation[]): string[] {
  return rankOaLocations(list)
    .filter((location) => location.kind === 'pdf' && location.textMining !== true)
    .map((location) => location.url)
}

/** 排序后第一个 PDF 直链，供 `paper.pdfUrl` 复用。 */
export function bestPdfUrl(list: readonly OaLocation[]): string {
  return pdfLinksOf(list)[0] ?? ''
}

/** 落地页类链接：DOI、原文页，一律 `oa: false`。 */
export function landingLinks(paper: Pick<Paper, 'doi' | 'url'>): OaLocation[] {
  const links: OaLocation[] = []
  if (paper.doi !== '') {
    links.push({ url: `https://doi.org/${paper.doi}`, kind: 'landing', source: 'doi', oa: false })
  }
  const url = paper.url.trim()
  if (url !== '' && oaUrlKey(url) !== oaUrlKey(links[0]?.url ?? '')) {
    links.push({ url, kind: 'landing', source: 'metadata', oa: false })
  }
  return links
}

/** 记录内自带的候选位置（不联网）。 */
export function metadataLocations(paper: Paper): OaLocation[] {
  const locations: OaLocation[] = []
  if (paper.pdfUrl !== '') {
    // 记录自带直链是否 OA 取决于上游是否声明；未声明按「未确认」处理。
    locations.push({ url: paper.pdfUrl, kind: 'pdf', source: 'metadata', oa: paper.openAccess })
  }
  const publisher = publisherPdfUrl(paper.doi)
  if (publisher !== null) {
    // 出版商固定规则不等于开放获取：Nature 订阅文章同样有 .pdf 地址，
    // 是否真能下由抓取层判定，这里不冒充 OA。
    locations.push({ url: publisher, kind: 'pdf', source: 'publisher-rule', oa: false })
  }
  const pmcid = normalizePmcid(paper.ids.pmcid)
  if (pmcid !== '') {
    locations.push({
      url: `${EPMC_ARTICLE}/${pmcid}?pdf=render`,
      kind: 'pdf',
      source: 'europepmc',
      oa: true,
    })
    locations.push({
      url: `${PMC_ARTICLE}/${pmcid}/pdf/`,
      kind: 'pdf',
      source: 'europepmc',
      oa: true,
    })
  }
  if (paper.ids.arxivId !== '') {
    locations.push({
      url: `${ARXIV_PDF}/${paper.ids.arxivId}`,
      kind: 'pdf',
      source: 'arxiv',
      oa: true,
    })
    locations.push({
      url: `${ARXIV_HTML}/${paper.ids.arxivId}`,
      kind: 'html',
      source: 'arxiv',
      oa: true,
    })
  }
  return mergeOaLocations([locations])
}

/** 去重、排序后的 PDF 候选地址（顺序即尝试优先级）。 */
export function pdfCandidates(paper: Paper, extra: readonly OaLocation[] = []): string[] {
  return pdfLinksOf(mergeOaLocations([metadataLocations(paper), extra]))
}

/** arXiv 的网页全文视图：PDF 之外的第二个全文通道。 */
export function arxivHtmlUrl(paper: Paper): string | null {
  return paper.ids.arxivId === '' ? null : `${ARXIV_HTML}/${paper.ids.arxivId}`
}

/**
 * 部分开放获取出版商的固定 PDF 地址规则。
 *
 * Europe PMC / PMC 的渲染页会对后台请求启用 Cloudflare 人机验证（浏览器能打开、
 * Host 下载却拿到 HTML），因此优先补一条出版商原生 PDF 地址。
 */
function publisherPdfUrl(doi: string): string | null {
  const value = doi.trim()
  if (value === '') return null
  // BMC / SpringerOpen：https://link.springer.com/content/pdf/<doi>.pdf
  if (value.startsWith('10.1186/') || value.startsWith('10.1007/')) {
    return `https://link.springer.com/content/pdf/${encodeURI(value)}.pdf`
  }
  // Frontiers：https://www.frontiersin.org/articles/<doi>/pdf
  if (value.startsWith('10.3389/')) {
    return `https://www.frontiersin.org/articles/${encodeURI(value)}/pdf`
  }
  // PLOS ONE
  if (value.startsWith('10.1371/journal.pone.')) {
    return `https://journals.plos.org/plosone/article/file?id=${encodeURI(value)}&type=printable`
  }
  // Nature 系列（开放获取文章可下载，订阅文章会落到 HTML 页并继续尝试其它候选）
  if (value.startsWith('10.1038/')) {
    return `https://www.nature.com/articles/${encodeURI(value.slice('10.1038/'.length))}.pdf`
  }
  return null
}

/** Europe PMC 的全文 XML 地址；没有 PMCID 时返回 null。 */
export function epmcXmlUrl(paper: Paper): string | null {
  const pmcid = normalizePmcid(paper.ids.pmcid)
  return pmcid === '' ? null : `${EPMC_REST}/${pmcid}/fullTextXML`
}

/**
 * Unpaywall 的 OA 位置（需要联系邮箱，遵守其 polite pool）。
 *
 * Unpaywall 已转入维护态，这里只作为补充来源，主力是 OpenAlex 与 Europe PMC。
 */
export async function unpaywallLocations(
  doi: string,
  email: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OaLocation[]> {
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
    const best = asRecord(body['best_oa_location'])
    const locations = [best, ...asArray(body['oa_locations']).map(asRecord)]
    const result: OaLocation[] = []
    for (const location of locations) {
      if (Object.keys(location).length === 0) continue
      const license = asString(location['license'])
      const shared = {
        source: 'unpaywall' as const,
        oa: true,
        ...(license === '' ? {} : { license }),
      }
      const pdf = asString(location['url_for_pdf'])
      if (pdf !== '') {
        result.push({ url: pdf, kind: 'pdf', ...shared })
        continue
      }
      // 少数仓储只给 `url`，且本身就是 PDF 直链；只收明显是 PDF 的地址，
      // 避免把落地页塞进候选后又被判成「返回内容不是 PDF」。
      const landing = asString(location['url'])
      if (isPdfLikeUrl(landing)) {
        result.push({ url: landing, kind: 'pdf', ...shared })
      } else if (landing !== '') {
        // 订阅/落地页不算 OA，只作为可点击链接。
        result.push({ url: landing, kind: 'landing', source: 'unpaywall', oa: false })
      }
    }
    return result
  } catch {
    return []
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 只取 PDF 直链的兼容封装（旧调用点与测试仍可用）。 */
export async function unpaywallPdfCandidates(
  doi: string,
  email: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const locations = await unpaywallLocations(doi, email, timeoutMs, signal)
  return locations.filter((location) => location.kind === 'pdf').map((location) => location.url)
}

/**
 * Europe PMC 的 `fullTextUrlList` → 位置列表。
 *
 * `documentStyle` 决定类型（pdf / html / doi）；只有 `availabilityCode` 为
 * `OA` 或 `F` 才算开放获取，其余（订阅）只作为落地页链接。
 */
export function epmcFullTextLocations(value: unknown): OaLocation[] {
  const entries = asArray(asRecord(value)['fullTextUrl']).map(asRecord)
  const locations: OaLocation[] = []
  for (const entry of entries) {
    const url = asString(entry['url'])
    if (url === '') continue
    const style = asString(entry['documentStyle']).toLowerCase()
    const availability = asString(entry['availabilityCode']).toUpperCase()
    const oa = availability === 'OA' || availability === 'F'
    if (style === 'pdf' || /\.pdf(?:[?#]|$)/iu.test(url)) {
      locations.push({ url, kind: 'pdf', source: 'europepmc', oa })
    } else if (style === 'html') {
      locations.push({ url, kind: 'html', source: 'europepmc', oa })
    } else {
      locations.push({ url, kind: 'landing', source: 'europepmc', oa: false })
    }
  }
  return mergeOaLocations([locations])
}

function isPdfLikeUrl(url: string): boolean {
  return /\.pdf(?:[?#]|$)/iu.test(url) || /\/pdf\/(?:[?#]|$)/iu.test(url)
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

/**
 * 通用 HTML → 可读片段（arXiv 网页全文用）。
 *
 * 与 `jatsToHtml` 同一策略：先标记结构标签，再剥掉所有标签、统一转义，
 * 因此远端 HTML 里的脚本、属性、内联事件都不可能进入阅读页。
 */
export function htmlToFragment(html: string): string {
  let body = html
  const start = body.search(/<body\b/iu)
  const end = body.toLowerCase().lastIndexOf('</body>')
  if (start >= 0 && end > start) body = body.slice(start, end + '</body>'.length)
  for (const tag of ['script', 'style', 'nav', 'header', 'footer', 'figure', 'aside', 'form']) {
    body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'giu'), ' ')
  }

  const markers: Array<[RegExp, string, string]> = [
    [/<(\/?)p\b[^>]*>/gu, '\u0001p\u0001', '\u0002p\u0002'],
    [/<(\/?)h2\b[^>]*>/gu, '\u0001h2\u0001', '\u0002h2\u0002'],
    [/<(\/?)h3\b[^>]*>/gu, '\u0001h3\u0001', '\u0002h3\u0002'],
    [/<(\/?)li\b[^>]*>/gu, '\u0001li\u0001', '\u0002li\u0002'],
    [/<(\/?)ul\b[^>]*>/gu, '\u0001ul\u0001', '\u0002ul\u0002'],
    [/<(\/?)ol\b[^>]*>/gu, '\u0001ol\u0001', '\u0002ol\u0002'],
  ]
  let marked = body
  for (const [pattern, open, close] of markers) {
    marked = marked.replace(pattern, (_match, closing: string) => (closing === '/' ? close : open))
  }

  const text = marked
    .replace(/<[^>]+>/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\s+(\u0002)/gu, '$1')
    .replace(/(\u0001)\s+/gu, '$1')
  const escaped = escapeHtml(text)
  return escaped
    .replace(/\u0001p\u0001/gu, '<p>')
    .replace(/\u0002p\u0002/gu, '</p>')
    .replace(/\u0001h2\u0001/gu, '<h2>')
    .replace(/\u0002h2\u0002/gu, '</h2>')
    .replace(/\u0001h3\u0001/gu, '<h3>')
    .replace(/\u0002h3\u0002/gu, '</h3>')
    .replace(/\u0001li\u0001/gu, '<li>')
    .replace(/\u0002li\u0002/gu, '</li>')
    .replace(/\u0001ul\u0001/gu, '<ul>')
    .replace(/\u0002ul\u0002/gu, '</ul>')
    .replace(/\u0001ol\u0001/gu, '<ol>')
    .replace(/\u0002ol\u0002/gu, '</ol>')
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
