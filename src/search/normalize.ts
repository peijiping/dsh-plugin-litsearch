/**
 * 上游 JSON 的窄化与归一化助手。
 *
 * 免费 API 的字段普遍可空、类型漂移，因此统一在 provider 边界做一次
 * 「未知 → 安全值」的转换，聚合层之后只处理规整的 `Paper`。
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 去掉 `https://doi.org/` / `doi:` 前缀并转小写。 */
export function normalizeDoi(value: unknown): string {
  return asString(value)
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '')
    .toLowerCase()
}

export function doiUrl(doi: string): string {
  return doi === '' ? '' : `https://doi.org/${doi}`
}

/** 取字符串数组的第一项（Crossref 的 title / container-title）。 */
export function firstString(value: unknown): string {
  return asString(asArray(value)[0])
}

/** 去掉 JATS/HTML 标签与常见实体，压成单行文本。 */
export function stripTags(value: unknown): string {
  return asString(value)
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim()
}
