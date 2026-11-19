/**
 * 翻译的纯函数部分：语种判定、语言码映射、长文本切块、Bing 响应解析。
 *
 * 单独成文件的原因：这些函数要能被 `node --test` 直接导入（测试文件以 `.ts`
 * 路径引用），因此本文件**不得有任何运行时 import**，尤其是带 `.js` 后缀的
 * 构建期路径。
 */

/** 自动判向时，中文原文译入的语言。 */
export const TRANSLATE_AUTO_CHINESE = 'en' as const

/** 自动判向时，非中文原文译入的语言。 */
export const TRANSLATE_AUTO_FOREIGN = 'zh-CN' as const

/** Bing 端点只认 `zh-Hans` 这种写法，别把 `zh-CN` 直接塞进去。 */
export function bingLanguage(tag: string): string {
  const lower = tag.toLowerCase()
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-sg' || lower === 'zh-hans') {
    return 'zh-Hans'
  }
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower === 'zh-hant') {
    return 'zh-Hant'
  }
  if (lower.startsWith('zh-hans')) return 'zh-Hans'
  if (lower.startsWith('zh-hant')) return 'zh-Hant'
  return tag
}

/**
 * 本地语种判定：`zh` / `en` / `other`。
 *
 * 判据是「汉字数 × 5 > 拉丁字母数」而不是简单比大小：中文摘要里夹几个
 * `PCR` / `VSC` 不至于被判成英文，英文摘要里引一句中文也不会被判成中文。
 */
export function detectSource(text: string): 'zh' | 'en' | 'other' {
  // 假名一出就是日文，不能因为共用汉字被判成中文。
  const kana = (text.match(/[\u3040-\u30ff]/gu) ?? []).length
  if (kana > 0) return 'other'
  const han = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) ?? []).length
  const latin = (text.match(/[a-z\u00c0-\u024f]/giu) ?? []).length
  if (han > 0 && han * 5 > latin) return 'zh'
  if (latin > 0) return 'en'
  return 'other'
}

/** 自动判向：中文原文译英文，其余译中文简体。 */
export function autoTarget(text: string): 'en' | 'zh-CN' {
  return detectSource(text) === 'zh' ? TRANSLATE_AUTO_CHINESE : TRANSLATE_AUTO_FOREIGN
}

/** 语种族：`zh-CN` / `zh-TW` 同族，用来判断「原文已是目标语言」。 */
export function languageFamily(tag: string): string {
  const lower = tag.toLowerCase()
  if (lower.startsWith('zh')) return 'zh'
  return lower.split('-')[0] ?? lower
}

/**
 * 按上限切块，块与块的拼接结果严格等于原文。
 *
 * 优先在段落分隔处切，其次句末标点，最后退到空格 / 硬切；保留分隔符本身，
 * 这样逐块翻译后直接拼接就不会丢段落。
 */
export function splitChunks(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < max * 0.4) cut = lastSentenceEnd(rest, max)
    if (cut < max * 0.4) {
      const space = rest.lastIndexOf(' ', max)
      cut = space > max * 0.4 ? space + 1 : max
    }
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

function lastSentenceEnd(text: string, max: number): number {
  const window = text.slice(0, max)
  const pattern = /[.!?。！？；;]["'”’）)]?\s*/gu
  let end = -1
  let match: RegExpExecArray | null
  while ((match = pattern.exec(window)) !== null) {
    end = match.index + match[0].length
  }
  return end
}

/** 解析 Bing 响应：`[{detectedLanguage, translations:[{text}]}]`，按序一一对应。 */
export function readBingTranslations(
  payload: unknown,
  expected: number,
): { texts: string[]; detected: string } | undefined {
  if (!Array.isArray(payload) || payload.length !== expected) return undefined
  const texts: string[] = []
  let detected = ''
  for (const item of payload) {
    if (typeof item !== 'object' || item === null) return undefined
    const record = item as { detectedLanguage?: unknown; translations?: unknown }
    if (detected === '' && typeof record.detectedLanguage === 'object') {
      const language = (record.detectedLanguage as { language?: unknown }).language
      if (typeof language === 'string') detected = language
    }
    if (!Array.isArray(record.translations)) return undefined
    const entry: unknown = record.translations[0]
    if (typeof entry !== 'object' || entry === null) return undefined
    const text = (entry as { text?: unknown }).text
    if (typeof text !== 'string' || text.trim() === '') return undefined
    texts.push(text)
  }
  return { texts, detected }
}
