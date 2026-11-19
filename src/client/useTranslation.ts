/**
 * 标题 / 摘要的「原 ↔ 译」切换。
 *
 * 只在用户点按钮时才翻译：首次点击命中缓存就秒切，未命中才请求 Host；
 * 之后在原文 / 译文之间来回切都不再请求引擎。缓存只存内存，刷新页面即失效。
 *
 * 并发闸门与在途去重仍然保留：用户可能连着点很多张卡，同一篇也可能同时出现在
 * 结果卡片与单篇页两个 tab 里。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { TranslateResult } from '../search/types'
import { translateTexts } from './api'
import type { Translate } from './locales'
import { showNotice } from './noticeStore'
import { plainText } from './text'
import { patchOn, readEntry, writeEntry, type TranslationEntry } from './translateStore'

/** 同时在途的翻译请求上限：连点很多张卡时排队，别一次打满上游。 */
const MAX_CONCURRENT = 3

let active = 0
const waiters: Array<() => void> = []

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  active += 1
  try {
    return await task()
  } finally {
    active -= 1
    waiters.shift()?.()
  }
}

/**
 * 同一篇可能同时出现在结果卡片和单篇页（两个 tab 都挂着），
 * 共用一个在途请求，避免同一篇翻两遍、花两份额度。
 */
const inflight = new Map<string, Promise<TranslateResult>>()

function startOnce(key: string, task: () => Promise<TranslateResult>): Promise<TranslateResult> {
  const existing = inflight.get(key)
  if (existing !== undefined) return existing
  const pending = withSlot(task)
  inflight.set(key, pending)
  void pending.finally(() => inflight.delete(key)).catch(() => {})
  return pending
}

/** 只依赖标题与摘要，单篇页在详情加载完成前也能无条件调用这个 hook。 */
export interface TranslationSource {
  paperId: string
  title: string
  abstract: string
}

export interface TranslationState {
  /** 当前是否显示译文。 */
  on: boolean
  /** 正在请求翻译（含排队）。 */
  busy: boolean
  /** 按当前状态应展示的标题。 */
  title: string
  /** 按当前状态应展示的摘要（纯文本，截断交给调用方）。 */
  abstract: string
  /** 原文摘要的纯文本，供调用方按原文长度决定是否可折叠（跨语言稳定）。 */
  sourceAbstract: string
  /** 当前译文的引擎；未翻译时为空。 */
  provider?: TranslationEntry['provider']
  toggle(): void
}

export function useTranslation(paper: TranslationSource, t: Translate): TranslationState {
  const srcTitle = paper.title
  const srcAbstract = plainText(paper.abstract)
  // 落盘时长摘要尾部会补一个 …（见 host/tasks/store.ts 的 truncatePaper），它不是正文的一部分。
  // 原文展示仍保留它（提示摘要被截短），但送进翻译会被渲染成 "......"，让人误以为译文没翻全。
  const translateAbstract = srcAbstract.replace(/\s*…$/u, '')
  const paperId = paper.paperId

  const [entry, setEntry] = useState<TranslationEntry | undefined>(() =>
    readEntry(paperId, srcTitle, srcAbstract),
  )
  const [busy, setBusy] = useState(false)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // 列表刷新可能把同一个组件实例换给另一篇：回包时按 id 判断还能不能落到状态上。
  const currentId = useRef(paperId)
  currentId.current = paperId

  /** 真正的请求：只在用户点按钮、且缓存未命中时调用。 */
  const load = useCallback(async (): Promise<void> => {
    const cached = readEntry(paperId, srcTitle, srcAbstract)
    if (cached !== undefined) {
      setEntry(cached)
      return
    }
    setBusy(true)
    const body =
      translateAbstract === '' ? { texts: [srcTitle] } : { texts: [srcTitle, translateAbstract] }
    try {
      // 缓存键仍用带省略号的原文：它随原文变化，能保证同一篇复用、换篇失效。
      const result = await startOnce(`${paperId}\u0000${srcTitle}\u0000${srcAbstract}`, () =>
        translateTexts(body),
      )
      if (result.sameLanguage) {
        if (alive.current && currentId.current === paperId) {
          showNotice(t('result.translateSameLanguage'), 'info')
        }
        return
      }
      const next: TranslationEntry = {
        srcTitle,
        srcAbstract,
        title: result.texts[0] ?? srcTitle,
        abstract: result.texts[1] ?? '',
        provider: result.provider,
        target: result.target,
        on: true,
      }
      // 译文始终写回内存缓存，但只有仍停在这一篇时才更新界面。
      writeEntry(paperId, next)
      if (alive.current && currentId.current === paperId) setEntry(next)
    } catch (error) {
      if (!alive.current || currentId.current !== paperId) return
      const detail = error instanceof Error ? error.message : String(error)
      showNotice(`${t('result.translateFailed')}：${detail}`, 'error')
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [paperId, srcTitle, srcAbstract, translateAbstract, t])

  // 换了一篇（列表复用组件实例）时重新读缓存；不会主动发请求。
  useEffect(() => {
    setEntry(readEntry(paperId, srcTitle, srcAbstract))
  }, [paperId, srcTitle, srcAbstract])

  const toggle = useCallback(() => {
    if (busy) return
    // 已经翻过：只在原文 / 译文之间切换，不再请求引擎。
    const cached = readEntry(paperId, srcTitle, srcAbstract)
    if (cached !== undefined) {
      setEntry(patchOn(paperId, !cached.on))
      return
    }
    void load()
  }, [busy, load, paperId, srcTitle, srcAbstract])

  // 组件可能被复用到另一篇（列表刷新时不带 key）：源文对不上就先按原文展示。
  const current =
    entry !== undefined && entry.srcTitle === srcTitle && entry.srcAbstract === srcAbstract
      ? entry
      : undefined

  if (current !== undefined && current.on) {
    return {
      on: true,
      busy,
      title: current.title,
      abstract: current.abstract === '' ? srcAbstract : current.abstract,
      sourceAbstract: srcAbstract,
      provider: current.provider,
      toggle,
    }
  }
  return { on: false, busy, title: srcTitle, abstract: srcAbstract, sourceAbstract: srcAbstract, toggle }
}
