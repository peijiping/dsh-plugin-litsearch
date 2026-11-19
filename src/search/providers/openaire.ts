/**
 * OpenAIRE Graph provider —— 欧洲机构仓储聚合，补充 green OA 副本。
 *
 * 文档：https://graph.openaire.eu/docs/latest/apis/graph-api/research-products
 * 无需密钥；带 `mailto` 进入 polite pool。响应体积大，用 v4 的 `select` 裁剪字段。
 *
 * 注意：v4 支持 `select` 但不支持按 PID 精确过滤；按 DOI 反查放在 Host 的
 * `oa-lookup` 里走 v3 的 `pid=` 参数（v4 的 `pid=` 会被忽略，返回全库）。
 */

import { asArray, asRecord, asString, doiUrl, normalizeDoi, stripTags } from '../normalize.js'
import { limitedJson } from '../rate-limit.js'
import type { OaLocation, PaperRecord, Provider } from '../types.js'

const ENDPOINT = 'https://api.openaire.eu/graph/v4/research-products'

/** 响应体大、回传慢：实测 53 条约 230 KB，耗时中位数约 23s，给 30s 下限。 */
const TIMEOUT_FLOOR_MS = 30_000
/** 单次最多取的条数。耗时随响应体近似线性增长，25 条约 3–8s。 */
const REQUEST_SIZE_CAP = 25

/** 只取本 provider 用到的字段；字段名以 v4 实际返回为准。 */
const SELECT_FIELDS = [
  'id',
  'mainTitle',
  'publicationDate',
  'publisher',
  'authors',
  'pids',
  'bestAccessRight',
  'descriptions',
  'instances',
].join(',')

export const openaire: Provider = {
  info: {
    id: 'openaire',
    label: 'OpenAIRE',
    homepage: 'https://graph.openaire.eu',
    capabilities: { abstract: true, citationCount: false, openAccess: true, pdf: true },
    rateLimit: '自限约 0.7 req/s；带邮箱进入 polite pool',
    syntax: '自然语言关键词；仅检索出版物类型，OA 状态与副本链接由 instances 给出',
    optionalKey: false,
  },

  async search(query, options): Promise<PaperRecord[]> {
    const params = new URLSearchParams({
      search: query,
      filter: 'type:publication',
      // 专利记录会被过滤掉，但仍按 25 条封顶以控制响应体与耗时。
      page_size: String(Math.max(1, Math.min(options.limit, REQUEST_SIZE_CAP))),
      select: SELECT_FIELDS,
    })
    if (options.contactEmail !== '') params.set('mailto', options.contactEmail)

    const payload = await limitedJson('openaire', `${ENDPOINT}?${params.toString()}`, {
      timeoutMs: Math.max(options.timeoutMs, TIMEOUT_FLOOR_MS),
      signal: options.signal,
      bypassCooldown: options.bypassCooldown === true,
      headers: {
        accept: 'application/json',
        ...(options.contactEmail === ''
          ? {}
          : {
              'user-agent': `dsh-plugin-litsearch/0.1.0 (mailto:${options.contactEmail})`,
            }),
      },
    })

    const papers = asArray(asRecord(payload)['results'])
      .filter((raw) => !isPatentRecord(raw))
      .map(mapResult)
      .filter((paper) => paper.title !== '')
    const kept = options.openAccessOnly
      ? papers.filter((paper) => paper.openAccess)
      : papers
    return kept.slice(0, options.limit)
  },
}

/** OpenAIRE 把专利也归在 `type: publication` 下，全部实例都是专利时直接丢弃。 */
function isPatentRecord(raw: unknown): boolean {
  const instances = asArray(asRecord(raw)['instances']).map(asRecord)
  if (instances.length === 0) return false
  return instances.every((instance) => asString(instance['type']).toLowerCase() === 'patent')
}

function mapResult(raw: unknown): PaperRecord {
  const result = asRecord(raw)
  const doi = readDoi(result['pids'])
  const instances = asArray(result['instances']).map(asRecord)
  const locations = readLocations(instances)
  const oa = readOpenAccess(result, instances)
  const pdfUrl = locations.find((location) => location.kind === 'pdf')?.url ?? ''
  const landing = locations.find((location) => location.kind === 'landing')?.url ?? ''

  return {
    source: 'openaire',
    sourceId: asString(result['id']),
    ids: { doi, pmid: '', pmcid: '', arxivId: '' },
    title: asString(result['mainTitle']),
    authors: asArray(result['authors'])
      .map((entry) => asString(asRecord(entry)['fullName']) || asString(asRecord(entry)['name']))
      .filter((name) => name !== ''),
    year: readYear(result['publicationDate']),
    venue: asString(result['publisher']),
    doi,
    url: landing !== '' ? landing : pdfUrl !== '' ? pdfUrl : doiUrl(doi),
    abstract: readAbstract(result['descriptions']),
    citedBy: null,
    openAccess: oa,
    pdfUrl,
    ...(locations.length === 0 ? {} : { oaLocations: locations }),
    type: asString(result['type']) || 'publication',
  }
}

/** `descriptions` 是字符串数组（常带 JATS 标签），拼成一段纯文本摘要。 */
function readAbstract(value: unknown): string {
  return asArray(value)
    .map((entry) => stripTags(entry))
    .filter((text) => text !== '')
    .join(' ')
    .slice(0, 2_000)
}

/** `pids` 形如 `[{scheme:'doi', value:'10.…'}]`。 */
function readDoi(value: unknown): string {
  for (const entry of asArray(value)) {
    const pid = asRecord(entry)
    if (asString(pid['scheme']).toLowerCase() === 'doi') {
      return normalizeDoi(pid['value'])
    }
  }
  return ''
}

function readLocations(instances: Record<string, unknown>[]): OaLocation[] {
  const locations: OaLocation[] = []
  for (const instance of instances) {
    const accessRight = asString(asRecord(instance['accessRight'])['label']).toUpperCase()
    const isOa = accessRight === '' || accessRight.startsWith('OPEN')
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
  return locations
}

function readOpenAccess(
  result: Record<string, unknown>,
  instances: Record<string, unknown>[],
): boolean {
  const best = asString(asRecord(result['bestAccessRight'])['label']).toUpperCase()
  if (best !== '') return best.startsWith('OPEN')
  return instances.some((instance) => {
    const label = asString(asRecord(instance['accessRight'])['label']).toUpperCase()
    return label.startsWith('OPEN')
  })
}

function readYear(value: unknown): number | null {
  const match = /(\d{4})/u.exec(asString(value))
  return match === null ? null : Number(match[1])
}
