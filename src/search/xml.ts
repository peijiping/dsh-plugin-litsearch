/**
 * 极简 XML 取值助手。
 *
 * arXiv Atom 与 PubMed EFetch 都是结构稳定的服务端 XML，没有引入解析依赖的
 * 必要；这里只做「按标签取首段 / 取全部片段」与实体解码，够 provider 映射用。
 */

/** 取第一个 `<tag ...>…</tag>` 的内部文本（已去标签与解码实体）。 */
export function xmlText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'u').exec(xml)
  return match === null ? '' : decodeEntities(stripXmlTags(match[1]))
}

/** 取全部同名标签的内部文本。 */
export function xmlTexts(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gu')
  const values: string[] = []
  for (const match of xml.matchAll(pattern)) values.push(decodeEntities(stripXmlTags(match[1])))
  return values
}

/** 取全部同名标签的原始片段（保留内部标签，供再解析）。 */
export function xmlBlocks(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gu')
  const blocks: string[] = []
  for (const match of xml.matchAll(pattern)) blocks.push(match[1])
  return blocks
}

/** 取某个起始标签里的属性值；传入完整标签文本。 */
export function xmlAttr(tagText: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'iu').exec(tagText)
  return match === null ? '' : decodeEntities(match[1])
}

/** 找到第一个带指定属性的自闭合/普通标签文本。 */
export function xmlTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>`, 'u').exec(xml)
  return match === null ? '' : match[0]
}

/** 去掉 XML 标签并把空白压成单行。 */
export function stripXmlTags(value: string): string {
  return value.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()
}

/** 解码常见命名实体与数字实体。 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec: string) => codePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return ''
  try {
    return String.fromCodePoint(value)
  } catch {
    return ''
  }
}
