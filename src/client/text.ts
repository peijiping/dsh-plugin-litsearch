/**
 * 展示层文本清洗。
 *
 * 上游 API 的摘要常带 JATS / HTML 行内标签：有些被 XML 解析器解码成了字面量
 * `<i>`，有些是 `&lt;i&gt;` 二次转义，直接渲染会在正文里看到标记本身。
 * 这里只处理已知的行内标签白名单，避免误伤「p < 0.05」这类比较符。
 */

/** JATS / HTML 里常见的行内标签，命中即删；`n` 是 PubMed 摘要里的编号残留。 */
const INLINE_TAG = /<\/?(?:i|b|em|strong|sup|sub|u|p|n|br|span|sc|italic|bold)\b[^>]*>/giu

/** 实体解码：只解最常见的几个，顺序上 `&amp;` 放最后避免二次解码。 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
}

/** 把带标记的摘要压成可直接阅读的一段文本。 */
export function plainText(value: string): string {
  // 先删原始标签，再解码实体，最后再删一次——有些源站是二次转义的 `&lt;i&gt;`。
  const stripped = decodeEntities(value.replace(INLINE_TAG, '')).replace(INLINE_TAG, '')
  return (
    stripped
      // 部分上游把「≤」破坏成 `</=`，还原成符号比留着标记干净。
      .replace(/<\/=/gu, '≤')
      .replace(/([≤≥])\s+(\d)/gu, '$1$2')
      .replace(/\s{2,}/gu, ' ')
      .replace(/\s+([,.;:])/gu, '$1')
      .trim()
  )
}

/**
 * 摘要的折叠预览。
 *
 * 关键点：是否可折叠由「原文」长度决定，而不是当前展示的文本。英文摘要落盘后被截到
 * 800 字（远超 260），译成中文却只剩 200 来字；若按译文长度判断，译后「展开摘要」
 * 按钮会直接消失，看上去就像只翻了一截。用原文判定能让按钮跨语言稳定保留。
 *
 * 折叠时的预览长度按 当前文本/原文 的比例缩放：原文态取 previewChars 字，译文态
 * 等比例缩短，这样译后点开仍能看到「全文」，折叠语义在两种语言下都成立。
 */
export function abstractPreview(args: {
  /** 当前要展示的文本（原文态是原文，译文态是译文）。 */
  shown: string
  /** 原文纯文本，用于稳定的折叠判定与比例计算。 */
  source: string
  /** 原文的预览字数。 */
  previewChars: number
  /** 是否已展开。 */
  expanded: boolean
}): { text: string; collapsible: boolean } {
  const { shown, source, previewChars, expanded } = args
  // 原文本就不长：无需折叠，原文/译文都全文显示。
  if (source.length <= previewChars) return { text: shown, collapsible: false }
  // 预览长度按当前文本相对原文的比例缩放，译文更短时预览也相应变短。
  const limit = Math.max(1, Math.round((previewChars * shown.length) / source.length))
  if (expanded || shown.length <= limit) return { text: shown, collapsible: true }
  return { text: `${shown.slice(0, limit)}…`, collapsible: true }
}

/** 从 URL 里取主机名，用于「原文链接」这类紧凑展示。 */
export function hostOf(url: string): string {
  const stripped = url.replace(/^https?:\/\//u, '')
  const host = stripped.split('/')[0]
  return host === undefined || host === '' ? url : host
}
