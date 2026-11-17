/**
 * PMC 相关的纯函数解析，供 node:test 直接以 `.ts` 运行。
 */

/** `8005924` / `PMC8005924` / `pmc8005924` → `PMC8005924`。 */
export function normalizePmcid(value: string): string {
  const trimmed = value.trim().toUpperCase()
  if (trimmed === '') return ''
  return /^\d+$/u.test(trimmed) ? `PMC${trimmed}` : trimmed
}

/** 从 ELink `dbfrom=pubmed&db=pmc` 的结果里取第一条 PMCID。 */
export function parsePmcidFromElink(payload: unknown): string {
  for (const linkset of asArray(asRecord(payload)['linksets'])) {
    for (const entry of asArray(asRecord(linkset)['linksetdbs'])) {
      const db = asRecord(entry)
      // 同一响应里还有 `pubmed_pmc_refs`，必须精确匹配。
      if (asString(db['linkname']) !== 'pubmed_pmc') continue
      const pmcid = normalizePmcid(asString(asArray(db['links'])[0]))
      if (pmcid !== '') return pmcid
    }
  }
  return ''
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
  return typeof value === 'string' ? value : ''
}
