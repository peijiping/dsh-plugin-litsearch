/**
 * 检索式按源适配。
 *
 * 面板/模型写的是「通用关键词」，但各源语法差异很大：PubMed/Europe PMC 支持
 * 字段标签与布尔语法，OpenAlex/Crossref/S2 只认自然语言，arXiv 需要 `all:`
 * 前缀，PubTator 只吃纯文本。`queries[].perSource` 非空时优先使用覆写值。
 */

import type { QueryBlock, SourceId } from './types.js'

export function adaptQuery(source: SourceId, block: Pick<QueryBlock, 'text' | 'perSource'>): string {
  const override = block.perSource?.[source]
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const text = block.text.trim()
  switch (source) {
    case 'pubmed':
    case 'europepmc':
      return text
    case 'openalex':
    case 'crossref':
    case 'semanticscholar':
      return stripFieldTags(text)
    case 'arxiv':
      return toArxivQuery(text)
    case 'pubtator':
      return toPlainText(text)
  }
}

/** 去掉 `[tiab]` 一类字段标签与通配符，保留引号短语与布尔词。 */
export function stripFieldTags(text: string): string {
  return text
    .replace(/\[[^\]]*\]/gu, ' ')
    .replace(/\*/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** arXiv 需要字段前缀；已带 `all:` / `ti:` 等前缀时原样保留。 */
export function toArxivQuery(text: string): string {
  const cleaned = stripFieldTags(text)
  if (/\b(?:all|ti|abs|au|cat|co|jr|rn):/iu.test(cleaned)) return cleaned

  const tokens = cleaned.split(/\s+/u).filter((token) => token !== '')
  const parts: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (/^(?:and|or|andnot|not)$/iu.test(token)) {
      parts.push(token.toUpperCase() === 'NOT' ? 'ANDNOT' : token.toUpperCase())
      continue
    }
    // 把相邻普通词合并成 `all:"a b"`，避免 arXiv 把整个短语当单个词。
    const words: string[] = [token]
    while (
      index + 1 < tokens.length &&
      !/^(?:and|or|andnot|not)$/iu.test(tokens[index + 1])
    ) {
      index += 1
      words.push(tokens[index])
    }
    const phrase = words.join(' ')
    parts.push(`all:${quoteIfPhrase(phrase)}`)
  }
  return parts.join(' ').trim()
}

function quoteIfPhrase(value: string): string {
  return /\s/u.test(value) && !value.startsWith('"') ? `"${value}"` : value
}

/** PubTator 只做纯文本匹配：去掉字段标签与布尔运算符。 */
export function toPlainText(text: string): string {
  return stripFieldTags(text)
    .replace(/\b(?:and|or|andnot|not)\b/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}
