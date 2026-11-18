/**
 * 任务当前生效检索条件的结构化回显。
 *
 * 把数据源、每源数量、时间范围、排序拆成带图标的独立分区，避免堆成一行文字。
 * 检索式（可能有别名）单独分区逐条列出；改条件仍走外层标题的编辑弹窗。
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react'

import type { TaskConditions } from '../search/types'
import {
  ClockIcon,
  DatabaseIcon,
  FilterIcon,
  SortIcon,
  StackIcon,
} from './icons'
import { tpl, type Translate } from './locales'

interface Props {
  t: Translate
  conditions: TaskConditions
  fromTaskId?: string
}

/** 时间范围文案：起止均有 → 区间；只有一端 → 单边；都没有 → 不限。 */
function yearText(t: Translate, conditions: TaskConditions): string {
  const { yearFrom, yearTo } = conditions
  if (yearFrom === undefined && yearTo === undefined) return t('condition.year.any')
  if (yearFrom !== undefined && yearTo !== undefined) {
    return tpl(t('condition.year.range'), { from: yearFrom, to: yearTo })
  }
  if (yearFrom !== undefined) return tpl(t('condition.year.from'), { n: yearFrom })
  return tpl(t('condition.year.to'), { n: yearTo as number })
}

export function ConditionSummary({ t, conditions, fromTaskId }: Props): ReactElement {
  const queries = conditions.queries.filter((query) => query.enabled)
  const sources = conditions.sources.map((id) => t(`source.${id}`)).join(' / ')

  // 语言 / 开放获取 / 文献类型不是独立主分区，合并成一行附加条件回显。
  const extras: string[] = []
  if (conditions.language !== 'any') {
    extras.push(tpl(t('filter.languageChip'), { value: t(`lang.${conditions.language}`) }))
  }
  if (conditions.openAccessOnly) extras.push(t('condition.openAccess'))
  if ((conditions.types ?? []).length > 0) {
    extras.push(tpl(t('filter.typeChip'), { value: (conditions.types ?? []).join(', ') }))
  }

  return (
    <div style={BODY_STYLE}>
      <Section icon={<FilterIcon />} label={t('condition.section.queries')}>
        <div style={QUERY_LIST_STYLE}>
          {queries.map((query) => (
            <div key={query.id} style={QUERY_ROW_STYLE} title={query.text}>
              {query.name !== '' && (
                <span style={QUERY_NAME_STYLE}>{query.name}</span>
              )}
              <span style={QUERY_TEXT_STYLE}>{query.text}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={<DatabaseIcon />} label={t('condition.section.sources')} value={sources} />
      <Section
        icon={<StackIcon />}
        label={t('condition.section.pageSize')}
        value={tpl(t('condition.unit.count'), { n: conditions.pageSize })}
      />
      <Section icon={<ClockIcon />} label={t('condition.section.year')} value={yearText(t, conditions)} />
      <Section
        icon={<SortIcon />}
        label={t('condition.section.sort')}
        value={t(`sort.${conditions.sort}`)}
      />

      {extras.length > 0 && <div style={EXTRA_STYLE}>{extras.join(' · ')}</div>}

      {fromTaskId !== undefined && (
        <div style={FROM_STYLE} title={fromTaskId}>
          {tpl(t('ledger.fromTask'), { id: fromTaskId })}
        </div>
      )}
    </div>
  )
}

interface SectionProps {
  icon: ReactNode
  label: string
  value?: string
  children?: ReactNode
}

function Section({ icon, label, value, children }: SectionProps): ReactElement {
  return (
    <div style={SECTION_STYLE}>
      <span style={ICON_STYLE} aria-hidden>
        {icon}
      </span>
      <div style={SECTION_CONTENT_STYLE}>
        <span style={LABEL_STYLE}>{label}</span>
        {children !== undefined ? (
          children
        ) : (
          <span style={VALUE_STYLE}>{value}</span>
        )}
      </div>
    </div>
  )
}

const BODY_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  minWidth: 0,
  maxHeight: 168,
  overflowY: 'auto',
}

const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 7,
  minWidth: 0,
}

const ICON_STYLE: CSSProperties = {
  display: 'inline-flex',
  flexShrink: 0,
  marginTop: 1,
  color: 'var(--ls-accent-ink)',
}

const SECTION_CONTENT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  minWidth: 0,
  flex: 1,
}

const LABEL_STYLE: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 500,
  lineHeight: 1.3,
  opacity: 0.55,
}

const VALUE_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  wordBreak: 'break-word',
}

const QUERY_LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
}

const QUERY_ROW_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  wordBreak: 'break-word',
}

const QUERY_NAME_STYLE: CSSProperties = {
  marginRight: 5,
  fontSize: 11.5,
  fontWeight: 500,
  opacity: 0.6,
}

const QUERY_TEXT_STYLE: CSSProperties = {
  opacity: 0.92,
}

const EXTRA_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  opacity: 0.6,
  wordBreak: 'break-word',
  paddingLeft: 21,
}

const FROM_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.4,
  opacity: 0.55,
  wordBreak: 'break-word',
  paddingTop: 2,
  borderTop: '1px solid var(--ls-line)',
}
