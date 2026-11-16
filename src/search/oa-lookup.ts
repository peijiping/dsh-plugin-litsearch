/**
 * OA 位置反查（Host 侧网络层）。
 *
 * 三源并发、单源失败只记录不抛：OpenAlex 为主，Europe PMC 与 OpenAIRE 补充，
 * Unpaywall 作为可选兜底（该服务已转入维护态，不再作为唯一主力）。
 *
 * 结果带 1h 正缓存 / 6h 负缓存，避免批量下载时反复打上游。
 */

import { asArray, asRecord, asString, normalizeDoi } from './normalize.js'
import { epmcFullTextLocations, unpaywallLocations } from './oa.js'
import { mergeOaLocations } from './oa.js'
import { limitedJson } from './rate-limit.js'
import type { OaLocation, OaSource, Paper } from './types.js'

const OPENALEX_WORK = 'https://api.openalex.org/works'
const EPMC_SEARCH = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'
const OPENAIRE_GRAPH = 'https://api.openaire.eu/graph/v3/research-products'

const RESULT_TTL_MS = 60 * 60 * 1000
const EMPTY_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_LIMIT = 200

export interface OaLookupOptions {
  contactEmail: string
  timeoutMs: number
  signal?: AbortSignal | undefined
}

export interface OaLookupResult {
  locations: OaLocation[]
  /** 单源失败原因（面向诊断，不阻塞下载）。 */
  sourceErrors: Partial<Record<OaSource, string>>
}

interface CacheEntry {
  at: number
  ttl: number
  result: OaLookupResult
}

const cache = new Map<string, CacheEntry>()

/** 反查 OA 位置；无 DOI/PMCID 时直接返回空（无法反查）。 */
export async function lookupOaLocations(
  paper: Paper,
  options: OaLookupOptions,
): Promise<OaLookupResult> {
  const key = cacheKey(paper)
  if (key === '') return { locations: [], sourceErrors: {} }
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < hit.ttl) return hit.result

  const tasks: Array<Promise<{ source: OaSource; locations: OaLocation[] }>> = []
  if (paper.doi !== '') {
    tasks.push(
      wrap('openalex', openalexLocations(paper.doi, options)),
      wrap('openaire', openaireLocations(paper.doi, options)),
    )
    if (options.contactEmail !== '') {
      tasks.push(wrap('unpaywall', unpaywallLocations(paper.doi, options.contactEmail, options.timeoutMs, options.signal)))
    }
  }
  if (paper.doi !== '' || paper.ids.pmcid !== '') {
    tasks.push(wrap('europepmc', europepmcLocations(paper, options)))
  }

  const settled = await Promise.allSettled(tasks)
  const sourceErrors: Partial<Record<OaSource, string>> = {}
  const lists: OaLocation[][] = []
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      lists.push(outcome.value.locations)
      continue
    }
    const reason = outcome.reason
    const source = (reason as { source?: OaSource } | undefined)?.source
    if (source !== undefined) {
      sourceErrors[source] = reason instanceof Error ? reason.message : String(reason)
    }
  }

  const result: OaLookupResult = { locations: mergeOaLocations(lists), sourceErrors }
  remember(key, result)
  return result
}

/** 清空缓存（测试与设置变更时使用）。 */
export function resetOaLookupCache(): void {
  cache.clear()
}

async function openalexLocations(doi: string, options: OaLookupOptions): Promise<OaLocation[]> {
  const url = `${OPENALEX_WORK}/https://doi.org/${encodeURIComponent(doi)}`
  const payload = await limitedJson('openalex', url, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    headers: {
      accept: 'application/json',
      ...(options.contactEmail === ''
        ? {}
        : { 'user-agent': `dsh-plugin-litsearch/0.1.0 (mailto:${options.contactEmail})` }),
    },
  })
  const work = asRecord(payload)
  const best = asRecord(work['best_oa_location'])
  const entries = [best, ...asArray(work['locations']).map(asRecord)]
  const result: OaLocation[] = []
  for (const location of entries) {
    if (Object.keys(location).length === 0) continue
    const isOa = location['is_oa'] === true
    const license = asString(location['license'])
    const shared = {
      source: 'openalex' as const,
      oa: isOa,
      ...(license === '' ? {} : { license }),
      ...(location === best ? { best: true } : {}),
    }
    const pdf = asString(location['pdf_url'])
    if (pdf !== '') {
      result.push({ url: pdf, kind: 'pdf', ...shared })
      continue
    }
    const landing = asString(location['landing_page_url'])
    if (landing !== '') {
      result.push({ url: landing, kind: 'landing', ...shared, oa: false })
    }
  }
  return mergeOaLocations([result])
}

async function europepmcLocations(paper: Paper, options: OaLookupOptions): Promise<OaLocation[]> {
  const clauses: string[] = []
  if (paper.doi !== '') clauses.push(`DOI:"${paper.doi}"`)
  if (paper.ids.pmcid !== '') clauses.push(`EXT_ID:${paper.ids.pmcid}`)
  if (clauses.length === 0) return []
  const params = new URLSearchParams({
    query: clauses.join(' OR '),
    format: 'json',
    pageSize: '1',
    resultType: 'core',
  })
  const payload = await limitedJson('europepmc', `${EPMC_SEARCH}?${params.toString()}`, {
    timeoutMs: Math.max(options.timeoutMs, 15_000),
    signal: options.signal,
    headers: { accept: 'application/json' },
  })
  const result = asRecord(asArray(asRecord(asRecord(payload)['resultList'])['result'])[0])
  // EPMC 的 JATS 全文由 `/fulltext` 端点按 PMCID 现取，这里只收 PDF/网页位置。
  return mergeOaLocations([epmcFullTextLocations(result['fullTextUrlList'])])
}

async function openaireLocations(doi: string, options: OaLookupOptions): Promise<OaLocation[]> {
  // v4 的 `pid=` 会被忽略（返回全库），按 PID 精确查询必须用 v3。
  const params = new URLSearchParams({ pid: doi, pageSize: '1' })
  if (options.contactEmail !== '') params.set('mailto', options.contactEmail)
  const payload = await limitedJson('openaire', `${OPENAIRE_GRAPH}?${params.toString()}`, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    headers: { accept: 'application/json' },
  })
  const result = asRecord(asArray(asRecord(payload)['results'])[0])
  const locations: OaLocation[] = []
  for (const instance of asArray(result['instances']).map(asRecord)) {
    const label = asString(asRecord(instance['accessRight'])['label']).toUpperCase()
    const isOa = label === '' || label.startsWith('OPEN')
    const license = asString(instance['license'])
    for (const entry of asArray(instance['urls'])) {
      const url = asString(entry)
      if (url === '') continue
      const kind = /\.pdf(?:[?#]|$)/iu.test(url) || /\/pdf\//iu.test(url) ? 'pdf' : 'landing'
      locations.push({
        url,
        kind,
        source: 'openaire',
        oa: kind === 'pdf' && isOa,
        ...(license === '' ? {} : { license }),
      })
    }
  }
  return mergeOaLocations([locations])
}

function wrap(
  source: OaSource,
  promise: Promise<OaLocation[]>,
): Promise<{ source: OaSource; locations: OaLocation[] }> {
  return promise
    .then((locations) => ({ source, locations }))
    .catch((error: unknown) => {
      const wrapped = error instanceof Error ? error : new Error(String(error))
      throw Object.assign(wrapped, { source })
    })
}

function cacheKey(paper: Paper): string {
  if (paper.doi !== '') return `doi:${normalizeDoi(paper.doi)}`
  if (paper.ids.pmcid !== '') return `pmcid:${paper.ids.pmcid.toUpperCase()}`
  return ''
}

function remember(key: string, result: OaLookupResult): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, {
    at: Date.now(),
    ttl: result.locations.some((location) => location.kind === 'pdf') ? RESULT_TTL_MS : EMPTY_TTL_MS,
    result,
  })
}
