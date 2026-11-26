import { AsyncLocalStorage } from 'node:async_hooks'
import type { SafeRequest } from './evidence.js'
import type { SourceId } from './types.js'

/** 在限流队列实际发送请求时采集，包括重试以及 PubMed 的第二个请求。 */
export const requestTrace = new AsyncLocalStorage<(request: SafeRequest) => Promise<void>>()
const allowed: Record<SourceId, string> = {
  pubmed: 'db term retmax retmode sort datetype mindate maxdate id',
  europepmc: 'query pageSize resultType format',
  openalex: 'search per-page sort filter',
  crossref: 'query rows select filter',
  semanticscholar: 'query limit fields year',
  arxiv: 'search_query start max_results sortBy sortOrder',
  pubtator: 'text page size',
  doaj: 'pageSize page',
  openreview: 'term source type content group limit',
  openaire: 'search filter page_size select',
  googlescholar: 'engine q num start hl as_ylo as_yhi',
}

export async function traceRequest(source: SourceId, address: string): Promise<void> {
  const trace = requestTrace.getStore()
  if (!trace) return
  const url = new URL(address)
  const params: Record<string, string> = {}
  for (const key of allowed[source].split(' ')) {
    const value = url.searchParams.get(key)
    if (value !== null) params[key] = value
  }
  // DOAJ 的查询表达式在路径末段。
  if (source === 'doaj') params.query = decodeURIComponent(url.pathname.split('/').pop() ?? '')
  await trace({
    sentAt: new Date().toISOString(),
    operation: url.pathname.endsWith('/efetch.fcgi') ? 'fetchDetails' : 'search',
    endpoint: url.origin + url.pathname,
    params,
  })
}
