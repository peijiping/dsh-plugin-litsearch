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

/** 从 URL 里取主机名，用于「原文链接」这类紧凑展示。 */
export function hostOf(url: string): string {
  const stripped = url.replace(/^https?:\/\//u, '')
  const host = stripped.split('/')[0]
  return host === undefined || host === '' ? url : host
}
