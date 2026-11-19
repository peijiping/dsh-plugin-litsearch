/**
 * 翻页条：首页 / 上一页 / 页码 / 下一页 / 末页。结果页与全文台账共用。
 */

import type { CSSProperties, ReactElement } from 'react'

import { tpl, type Translate } from './locales'

export function Pager({
  t,
  index,
  count,
  total,
  onChange,
}: {
  t: Translate
  index: number
  count: number
  /** 总篇数；给了就并进页码文案，省掉单独一行统计。 */
  total?: number
  onChange(index: number): void
}): ReactElement | null {
  if (count <= 1) return null
  const atStart = index <= 0
  const atEnd = index >= count - 1
  return (
    <div style={PAGER_STYLE}>
      <button
        type="button"
        style={atStart ? PAGER_BUTTON_DISABLED : PAGER_BUTTON}
        disabled={atStart}
        onClick={() => onChange(0)}
      >
        {t('pager.first')}
      </button>
      <button
        type="button"
        style={atStart ? PAGER_BUTTON_DISABLED : PAGER_BUTTON}
        disabled={atStart}
        onClick={() => onChange(index - 1)}
      >
        {t('pager.prev')}
      </button>
      <span style={PAGER_STATUS_STYLE}>
        {total === undefined
          ? tpl(t('pager.status'), { page: index + 1, pages: count })
          : tpl(t('pager.statusTotal'), { page: index + 1, pages: count, total })}
      </span>
      <button
        type="button"
        style={atEnd ? PAGER_BUTTON_DISABLED : PAGER_BUTTON}
        disabled={atEnd}
        onClick={() => onChange(index + 1)}
      >
        {t('pager.next')}
      </button>
      <button
        type="button"
        style={atEnd ? PAGER_BUTTON_DISABLED : PAGER_BUTTON}
        disabled={atEnd}
        onClick={() => onChange(count - 1)}
      >
        {t('pager.last')}
      </button>
    </div>
  )
}

const PAGER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexWrap: 'wrap',
  gap: 6,
  fontSize: 11.5,
}
const PAGER_BUTTON: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 10,
  border: '1px solid var(--ls-line-strong)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 11.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const PAGER_BUTTON_DISABLED: CSSProperties = {
  ...PAGER_BUTTON,
  opacity: 0.4,
  cursor: 'default',
}
const PAGER_STATUS_STYLE: CSSProperties = { color: 'var(--ls-ink-2)', whiteSpace: 'nowrap' }
