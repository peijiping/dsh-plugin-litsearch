/**
 * 译文的内存缓存（不落盘，刷新即丢）。
 *
 * 卡片与单篇论文页共用同一份缓存，因此从列表点进某篇时仍是「译」态；
 * 缓存里同时存原文，重跑检索导致标题/摘要变化时按未命中处理。
 */

import type { TranslateEngine } from '../search/types'

export interface TranslationEntry {
  /** 生成译文时的原文，用来判断缓存是否过期。 */
  srcTitle: string
  srcAbstract: string
  title: string
  abstract: string
  /** 实际使用的引擎（DeepSeek 失败回落时为 bing）。 */
  provider: TranslateEngine
  /** 判向后的目标语言。 */
  target: string
  /** 当前是否显示译文；关掉后译文仍留着，下次点击秒回。 */
  on: boolean
}

const cache = new Map<string, TranslationEntry>()

/** 读缓存；原文已变则丢掉旧条目。 */
export function readEntry(
  paperId: string,
  srcTitle: string,
  srcAbstract: string,
): TranslationEntry | undefined {
  const hit = cache.get(paperId)
  if (hit === undefined) return undefined
  if (hit.srcTitle !== srcTitle || hit.srcAbstract !== srcAbstract) {
    cache.delete(paperId)
    return undefined
  }
  return hit
}

export function writeEntry(paperId: string, entry: TranslationEntry): void {
  cache.set(paperId, entry)
}

/** 只改开关态，保留译文。 */
export function patchOn(paperId: string, on: boolean): TranslationEntry | undefined {
  const hit = cache.get(paperId)
  if (hit === undefined) return undefined
  const next = { ...hit, on }
  cache.set(paperId, next)
  return next
}

/** 设置里换了引擎 / 目标语言时可整体清空；目前由组件按需重译。 */
export function clearTranslations(): void {
  cache.clear()
}
