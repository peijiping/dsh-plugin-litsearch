/**
 * Zotero Local API 只读访问：查目标目录里已有哪些条目，供同步前查重。
 *
 * Zotero 7 在 connector 同一端口提供 `/api/` 只读接口，读请求免鉴权；若用户
 * 关闭了「设置 → 高级 → 允许本机其他应用与 Zotero 通信」，所有请求返回 403。
 * 查重是增强能力：任何失败都要转成可读原因，由调用方回退到正常同步。
 *
 * 本文件只做类型导入，纯函数（路径还原 / 目录映射 / 匹配）可被 node --test 直接加载。
 */

import type {
  Paper,
  ZoteroDuplicateMatch,
  ZoteroTarget,
} from '../../search/types.js'

const DEFAULT_TIMEOUT_MS = 4_000

/** connector 地址 → Local API 根地址。 */
export function localApiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, '')
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`
}

export interface ZoteroTargetPath {
  /** 目标所属的资料库（level 0 的 `L<id>` 项）。 */
  library: ZoteroTarget
  /** 库内名称路径；空数组表示目标就是库本身。 */
  path: string[]
}

/**
 * 由 connector 的扁平 targets 还原目标的库与名称路径。
 *
 * targets 按前序排列：每个库一个 level 0 项，随后是该库的集合（level = 深度+1）。
 * 因此从目标往前找最近一个 level 0 项即为所属库；level 0 之后的名字依次为路径。
 */
export function resolveTargetPath(
  targets: readonly ZoteroTarget[],
  targetId: string,
): ZoteroTargetPath | undefined {
  const index = targets.findIndex((target) => target.id === targetId)
  if (index < 0) return undefined
  let root = index
  while (root > 0 && targets[root]?.level !== 0) root -= 1
  const library = targets[root]
  if (library === undefined || library.level !== 0) return undefined
  const path = targets
    .slice(root + 1, index + 1)
    .map((target) => target.name)
    .filter((name) => name !== '')
  return { library, path }
}

/** 名称归一化：全角转半角、合并空白、忽略大小写。 */
export function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

/** Zotero 资料库路径前缀：个人库 `users/0`，群组库 `groups/<groupID>`。 */
export async function resolveLibraryPrefix(
  apiBase: string,
  library: ZoteroTarget,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | undefined> {
  // 个人库的 libraryID 恒为 1，对应 Local API 的 users/0。
  if (library.id === 'L1') return 'users/0'
  const groups = await getJson(`${apiBase}/users/0/groups`, timeoutMs)
  const wanted = normalizeName(library.name)
  const matches = asArray(groups)
    .map((entry) => {
      const data = asRecord(asRecord(entry)?.['data']) ?? asRecord(entry)
      if (data === undefined) return undefined
      const name = asString(data['name'])
      const id = typeof data['id'] === 'number' ? data['id'] : undefined
      return name === undefined || id === undefined ? undefined : { name, id }
    })
    .filter((entry): entry is { name: string; id: number } => entry !== undefined)
    .filter((entry) => normalizeName(entry.name) === wanted)
  return matches.length === 1 ? `groups/${matches[0]?.id}` : undefined
}

interface CollectionNode {
  key: string
  name: string
  parent?: string
}

/** Local API 的集合数组 → 扁平节点；兼容 `{data:{...}}` 包裹与裸对象。 */
export function parseCollections(raw: unknown): CollectionNode[] {
  const nodes: CollectionNode[] = []
  for (const entry of asArray(raw)) {
    const data = asRecord(asRecord(entry)?.['data']) ?? asRecord(entry)
    if (data === undefined) continue
    const key = asString(data['key'])
    const name = asString(data['name'])
    if (key === undefined || name === undefined) continue
    const parentRaw = data['parentCollection']
    const parent = typeof parentRaw === 'string' && parentRaw !== '' ? parentRaw : undefined
    nodes.push(parent === undefined ? { key, name } : { key, name, parent })
  }
  return nodes
}

/** 还原每个集合在库内的名称路径（根集合路径长度为 1）。 */
export function collectionPaths(
  nodes: readonly CollectionNode[],
): { key: string; path: string[] }[] {
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const resolved = new Map<string, string[]>()
  const pathOf = (node: CollectionNode, seen: Set<string>): string[] => {
    const cached = resolved.get(node.key)
    if (cached !== undefined) return cached
    if (seen.has(node.key)) return [node.name]
    seen.add(node.key)
    const parent = node.parent === undefined ? undefined : byKey.get(node.parent)
    const path = parent === undefined ? [node.name] : [...pathOf(parent, seen), node.name]
    resolved.set(node.key, path)
    return path
  }
  return nodes.map((node) => ({ key: node.key, path: pathOf(node, new Set()) }))
}

/** 名称路径唯一命中才返回集合 key；0 个或多个命中视为无法定位。 */
export function matchCollectionKey(
  paths: readonly { key: string; path: string[] }[],
  wanted: readonly string[],
): string | undefined {
  const needle = wanted.map(normalizeName).join('/')
  const hits = paths.filter((entry) => entry.path.map(normalizeName).join('/') === needle)
  return hits.length === 1 ? hits[0]?.key : undefined
}

export type ZoteroTargetResolution =
  | { ok: true; prefix: string; collectionKey?: string }
  | { ok: false; error: string }

/**
 * 把 connector 的 target（`L<n>` / `C<n>`）映射为 Local API 的库前缀与集合 key。
 *
 * 只接受唯一命中：同名集合、找不到群组库等歧义一律放弃查重，绝不猜一个目录。
 */
export async function resolveTarget(
  apiBase: string,
  targets: readonly ZoteroTarget[],
  targetId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ZoteroTargetResolution> {
  const target = targets.find((entry) => entry.id === targetId)
  const resolved = resolveTargetPath(targets, targetId)
  if (target === undefined || resolved === undefined) {
    return { ok: false, error: '无法在 Zotero 目录列表里定位目标目录' }
  }
  const prefix = await resolveLibraryPrefix(apiBase, resolved.library, timeoutMs)
  if (prefix === undefined) {
    return { ok: false, error: `无法确定资料库「${resolved.library.name}」的访问路径` }
  }
  if (resolved.path.length === 0) return { ok: true, prefix }

  const collections = await getJson(`${apiBase}/${prefix}/collections`, timeoutMs)
  const key = matchCollectionKey(collectionPaths(parseCollections(collections)), resolved.path)
  if (key === undefined) {
    return {
      ok: false,
      error: `无法唯一确定目录「${resolved.path.join(' / ')}」在 Zotero 中的位置`,
    }
  }
  return { ok: true, prefix, collectionKey: key }
}

export interface ZoteroExistingIndex {
  /** 本插件写入的条目 id（extra 里的 `dsh-litsearch:<paperId>`）。 */
  ids: Set<string>
  dois: Set<string>
  pmids: Set<string>
  arxivs: Set<string>
  /** 归一化标题 + 年份。 */
  titles: Set<string>
}

/** 从 Local API 的条目数组构建匹配索引；附件、笔记、标注不参与。 */
export function indexFromItems(raw: unknown): ZoteroExistingIndex {
  const index: ZoteroExistingIndex = {
    ids: new Set(),
    dois: new Set(),
    pmids: new Set(),
    arxivs: new Set(),
    titles: new Set(),
  }
  for (const entry of asArray(raw)) {
    const data = asRecord(asRecord(entry)?.['data']) ?? asRecord(entry)
    if (data === undefined) continue
    const itemType = asString(data['itemType']) ?? ''
    if (itemType === 'attachment' || itemType === 'note' || itemType === 'annotation') continue

    const extra = asString(data['extra']) ?? ''
    const own = /^dsh-litsearch:\s*(\S+)\s*$/imu.exec(extra)
    if (own?.[1] !== undefined) index.ids.add(own[1])
    const pmid = /^PMID:\s*(\d+)\s*$/imu.exec(extra)
    if (pmid?.[1] !== undefined) index.pmids.add(pmid[1])
    const arxiv = /^arXiv:\s*(\S+)\s*$/imu.exec(extra)
    if (arxiv?.[1] !== undefined) index.arxivs.add(normalizeArxiv(arxiv[1]))

    const doi = normalizeDoi(asString(data['DOI']) ?? '')
    if (doi !== '') index.dois.add(doi)

    const title = asString(data['title']) ?? ''
    if (title !== '') index.titles.add(titleKey(title, yearOf(asString(data['date']) ?? '')))
  }
  return index
}

/** 目标是集合时只取该集合的条目；库根不带集合 key。 */
export async function fetchExistingIndex(
  apiBase: string,
  prefix: string,
  collectionKey?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ZoteroExistingIndex> {
  const scope =
    collectionKey === undefined
      ? `${apiBase}/${prefix}/items`
      : `${apiBase}/${prefix}/collections/${collectionKey}/items`
  const url = `${scope}?itemType=-attachment`
  return indexFromItems(await getJson(url, timeoutMs))
}

/** 判断文献在目标目录里是否已存在；返回命中的依据。 */
export function matchExisting(
  paper: Paper,
  index: ZoteroExistingIndex,
): ZoteroDuplicateMatch | undefined {
  if (index.ids.has(paper.paperId)) return 'id'
  const doi = normalizeDoi(paper.doi)
  if (doi !== '' && index.dois.has(doi)) return 'doi'
  const pmid = paper.ids.pmid.trim()
  if (pmid !== '' && index.pmids.has(pmid)) return 'pmid'
  const arxiv = normalizeArxiv(paper.ids.arxivId)
  if (arxiv !== '' && index.arxivs.has(arxiv)) return 'arxiv'
  if (index.titles.has(titleKey(paper.title, paper.year))) return 'title'
  return undefined
}

/** 裸 DOI：去 URL 前缀与 `doi:` 标记，忽略大小写。 */
export function normalizeDoi(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '')
    .trim()
    .toLowerCase()
}

/** arXiv 编号：去 `arXiv:` 前缀、忽略大小写、去版本号。 */
export function normalizeArxiv(value: string): string {
  return value
    .trim()
    .replace(/^arxiv:\s*/iu, '')
    .replace(/v\d+$/iu, '')
    .toLowerCase()
}

/** 标题归一化：全角转半角、去掉标点与空白、忽略大小写。 */
function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

function titleKey(title: string, year: number | null): string {
  return `${normalizeTitle(title)}|${year === null ? '' : String(year)}`
}

function yearOf(date: string): number | null {
  const match = /\b(\d{4})\b/u.exec(date)
  return match?.[1] === undefined ? null : Number(match[1])
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error(
          'Zotero 未开启本机 API 访问（设置 → 高级 → 允许本机其他应用与 Zotero 通信）',
        )
      }
      throw new Error(`Zotero 本机 API 返回 HTTP ${response.status}`)
    }
    return (await response.json()) as unknown
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Zotero 本机 API 请求超时')
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
