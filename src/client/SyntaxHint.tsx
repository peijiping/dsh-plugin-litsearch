/**
 * 数据源语法提示：只在检索式含字段/布尔语法且选中了自然语言源时出现。
 */

import type { CSSProperties, ReactElement } from 'react'

import type { ProviderInfo, SourceId } from '../search/types'
import { tpl, type Translate } from './locales'
import { hasFieldSyntax, naturalOnlySelected } from './syntax'

interface Props {
  t: Translate
  sources: readonly SourceId[]
  texts: readonly string[]
  infos?: readonly ProviderInfo[] | undefined
}

export function SyntaxHint({ t, sources, texts, infos }: Props): ReactElement | null {
  const affected = naturalOnlySelected(sources)
  if (affected.length === 0) return null
  if (!texts.some((text) => text !== '' && hasFieldSyntax(text))) return null

  const names = affected.map((source) => t(`source.${source}`)).join(' / ')
  const title = (infos ?? [])
    .filter((info) => affected.includes(info.id))
    .map((info) => `${info.label}：${info.syntax}`)
    .join('\n')

  return (
    <div style={HINT_STYLE} title={title === '' ? undefined : title}>
      {tpl(t('search.syntaxWarn'), { sources: names })}
    </div>
  )
}

/** 单个来源的语法说明，用作源按钮的 title。 */
export function sourceSyntaxTitle(
  infos: readonly ProviderInfo[] | undefined,
  id: SourceId,
): string | undefined {
  const info = infos?.find((entry) => entry.id === id)
  return info === undefined ? undefined : info.syntax
}

const HINT_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: '#b26a00',
}
