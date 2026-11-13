/**
 * 检索式语法差异提示。
 *
 * 字段标签（`[tiab]`、`AU:`）与布尔式在 PubMed 等源有效，但 Semantic Scholar
 * 与 PubTator 只按自然语言处理。面板据此在选中这些源时给出提醒。
 */

import type { SourceId } from '../search/types'

/** 只接受自然语言、不解析字段标签/布尔式的来源。 */
export const NATURAL_ONLY_SOURCES: readonly SourceId[] = [
  'semanticscholar',
  'pubtator',
  'googlescholar',
]

const FIELD_SYNTAX =
  /\[[a-z]{1,8}\]|\b(?:AND|OR|NOT)\b|\b(?:AU|TI|AB|TA|MESH|DOI|PMID|KW|JT|IS|VI|IP|PG|LA|PT|SU|SB|AD|AFFL)\s*:/u

/** 是否包含只被部分数据源识别的检索语法。 */
export function hasFieldSyntax(text: string): boolean {
  return FIELD_SYNTAX.test(text)
}

/** 当前选中的自然语言源中，会忽略上述语法的那些。 */
export function naturalOnlySelected(sources: readonly SourceId[]): SourceId[] {
  return NATURAL_ONLY_SOURCES.filter((source) => sources.includes(source))
}
