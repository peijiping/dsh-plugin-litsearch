/**
 * 数据源注册表。
 *
 * 新增数据源：实现 `Provider` → 在 {@link PROVIDERS} 登记 → 把 id 加进
 * `types.ts` 的 `SOURCE_IDS`，并补中英文案。
 */

import type { Provider, ProviderInfo, SourceId } from '../types.js'
import { SOURCE_IDS } from '../types.js'
import { crossref } from './crossref.js'
import { openalex } from './openalex.js'

export const PROVIDERS: Record<SourceId, Provider> = {
  openalex,
  crossref,
}

/** 注册顺序即聚合展示顺序。 */
export const PROVIDER_INFOS: readonly ProviderInfo[] = SOURCE_IDS.map((id) => PROVIDERS[id].info)

export function isSourceId(value: string): value is SourceId {
  return (SOURCE_IDS as readonly string[]).includes(value)
}

/** 把外部输入解析为合法 id 列表；空输入表示全部数据源。 */
export function resolveSources(requested: readonly string[] | undefined): SourceId[] {
  if (requested === undefined || requested.length === 0) return [...SOURCE_IDS]
  return SOURCE_IDS.filter((id) => requested.includes(id))
}
