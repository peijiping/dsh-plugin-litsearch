/**
 * 任务结果的筛选条。
 *
 * 除关键词（本质是检索词）与筛读状态外，所有条件都是下拉选择：
 * - 关键词使用文本框；
 * - 筛读状态为带计数的胶囊按钮，点击生效、再点取消；
 * - 年份用预设区间（不限 / 近 1 年 / 近 5 年 / 近 10 年 / 自定义范围）；
 * - 类型、出处、作者候选取自当前结果的统计口径（`/stats`），避免手输完整值对不上；
 * - 来源、分组、语言、排序沿用固定枚举。
 *
 * 关键词本地暂存 300ms 再上抛，避免每敲一个字都打一次 Host；下拉类条件立即生效。
 *
 * 「筛选（N）」入口由调用方放在覆盖率行（FilterToggleButton）；已生效条件与
 * 重置由 ActiveFilterChips 渲染在同一行。所有生效条件共用 collectActiveFilters：
 * 新增筛选维度时只在那里加一项，不要另外单写 chip，否则两处会再次不同步。
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type {
  CountEntry,
  QueryBlock,
  SortMode,
  SourceId,
  TaskGroup,
  TaskLanguage,
  TaskStatsReport,
} from '../search/types'
import { TASK_LANGUAGES } from '../search/types'
import type { ResultsQuery } from './api'
import { FilterIcon } from './icons'
import { tpl, type Translate } from './locales'

const TEXT_DEBOUNCE_MS = 300

const SORT_MODES: readonly SortMode[] = ['relevance', 'citations', 'year']
// 空 option 已经是「不限」，不再重复列出 TaskLanguage 的 any。
const LANGUAGES = TASK_LANGUAGES.filter((code) => code !== 'any')
const SCREENINGS = ['unread', 'read', 'included', 'excluded'] as const

const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS: readonly number[] = Array.from(
  { length: CURRENT_YEAR - 1899 },
  (_, index) => CURRENT_YEAR - index,
)

type Screening = (typeof SCREENINGS)[number]

const YEAR_PRESETS = ['any', '1', '5', '10', 'custom'] as const
type YearPreset = (typeof YEAR_PRESETS)[number]

interface Props {
  t: Translate
  value: ResultsQuery
  sources: readonly SourceId[]
  queries: readonly QueryBlock[]
  groups?: readonly TaskGroup[]
  /** 任务级统计（不含当前筛选），用于生成类型/出处/作者候选值。 */
  stats?: TaskStatsReport | null
  /** 筛读各状态的篇数；传入后状态在弹窗内显示为带计数的胶囊按钮。 */
  screeningCounts?: Readonly<Record<Screening, number>>
  /** 弹窗开关由调用方持有，入口按钮（FilterToggleButton）可放在筛选条之外。 */
  open: boolean
  onOpenChange(open: boolean): void
  onChange(next: ResultsQuery): void
}

/** 「筛选（N）」入口按钮；与结果页覆盖率行同排，点击打开筛选弹窗。 */
export function FilterToggleButton({
  t,
  count,
  onClick,
}: {
  t: Translate
  count: number
  onClick(): void
}): ReactElement {
  return (
    <button
      type="button"
      style={count > 0 ? TOGGLE_ACTIVE_STYLE : TOGGLE_STYLE}
      onClick={onClick}
    >
      <FilterIcon />
      <span>
        {t('filter.show')}
        {count === 0 ? '' : `（${count}）`}
      </span>
    </button>
  )
}

/** 已生效条件和「重置」：由调用方紧跟在筛选入口之后渲染。 */
export function ActiveFilterChips({
  t,
  value,
  queries,
  groups,
  onChange,
}: {
  t: Translate
  value: ResultsQuery
  queries: readonly QueryBlock[]
  groups: readonly TaskGroup[]
  onChange(next: ResultsQuery): void
}): ReactElement | null {
  const chips = collectActiveFilters(value, t, queries, groups)
  if (chips.length === 0) return null
  return (
    <>
      <button type="button" style={RESET_STYLE} onClick={() => onChange({})}>
        {t('filter.reset')}
      </button>
      {chips.map((chip) => (
        <ActiveChip
          key={chip.key}
          label={chip.label}
          onRemove={() => onChange({ ...value, ...chip.clear })}
        />
      ))}
    </>
  )
}

/** 由当前年份区间反推预设；非预设区间时归入「自定义范围」。 */
function yearPresetOf(value: ResultsQuery): YearPreset {
  if (value.yearFrom === undefined && value.yearTo === undefined) return 'any'
  if (value.yearTo === undefined) {
    if (value.yearFrom === CURRENT_YEAR - 1) return '1'
    if (value.yearFrom === CURRENT_YEAR - 5) return '5'
    if (value.yearFrom === CURRENT_YEAR - 10) return '10'
  }
  return 'custom'
}

/** 统计候选值 → 下拉项；标签带命中数，当前值不在清单里时补在最前面。 */
function facetOptions(
  entries: readonly CountEntry[] | undefined,
  current: string | undefined,
): { key: string; label: string }[] {
  const options = (entries ?? []).map((entry) => ({
    key: entry.key,
    label: `${entry.key}（${entry.count}）`,
  }))
  if (current !== undefined && current !== '' && !options.some((option) => option.key === current)) {
    options.unshift({ key: current, label: current })
  }
  return options
}

interface ActiveFilter {
  key: string
  label: string
  /** 点 × 时清掉的条件（可能同时清多个字段，如年份区间）。 */
  clear: Partial<ResultsQuery>
}

/**
 * 已生效条件的唯一清单：折叠态的计数与顶部标签都从这里派生，
 * 新增筛选维度时只需加一项，两处必然同步（此前只有 6 个维度有标签）。
 * `t` 可省略——只计数时用占位翻译，文案不参与判断。
 */
function collectActiveFilters(
  value: ResultsQuery,
  t: Translate = (key) => key,
  queries: readonly QueryBlock[] = [],
  groups: readonly TaskGroup[] = [],
): ActiveFilter[] {
  const list: ActiveFilter[] = []
  const add = (key: string, label: string, clear: Partial<ResultsQuery>): void => {
    list.push({ key, label, clear })
  }

  if (value.q !== undefined && value.q.trim() !== '') {
    add('q', tpl(t('filter.keywordChip'), { value: value.q }), { q: undefined })
  }
  if (value.source !== undefined) {
    add(
      'source',
      tpl(t('filter.sourceChip'), { value: t(`source.${value.source}`) }),
      { source: undefined },
    )
  }
  if (value.yearFrom !== undefined || value.yearTo !== undefined) {
    const from = value.yearFrom === undefined ? '' : String(value.yearFrom)
    const to = value.yearTo === undefined ? '' : String(value.yearTo)
    add('year', tpl(t('filter.yearChip'), { value: `${from}–${to}` }), {
      yearFrom: undefined,
      yearTo: undefined,
    })
  }
  if (value.screening !== undefined) {
    add(
      'screening',
      tpl(t('filter.screeningChip'), { value: t(`screening.${value.screening}`) }),
      { screening: undefined },
    )
  }
  if (value.queryId !== undefined) {
    const name = queries.find((query) => query.id === value.queryId)?.name ?? value.queryId
    add('queryId', tpl(t('filter.queryChip'), { value: name }), { queryId: undefined })
  }
  if (value.groupId !== undefined) {
    const name = groups.find((group) => group.id === value.groupId)?.name ?? value.groupId
    add('groupId', tpl(t('filter.groupChip'), { value: name }), { groupId: undefined })
  }
  if (value.language !== undefined && value.language !== 'any') {
    add(
      'language',
      tpl(t('filter.languageChip'), { value: t(`lang.${value.language}`) }),
      { language: undefined },
    )
  }
  if (value.sort !== undefined && value.sort !== 'relevance') {
    add('sort', tpl(t('filter.sortChip'), { value: t(`sort.${value.sort}`) }), {
      sort: undefined,
    })
  }
  if (value.openAccessOnly === true) {
    add('openAccessOnly', t('filter.openAccess'), { openAccessOnly: undefined })
  }
  if (value.hasPdf === true) {
    add('hasPdf', t('filter.hasPdf'), { hasPdf: undefined })
  }
  if (value.missingFullText === true) {
    add('missingFullText', t('filter.missingFullText'), { missingFullText: undefined })
  }
  if (value.hasFullText === true) {
    add('hasFullText', t('filter.hasFullText'), { hasFullText: undefined })
  }
  if (value.pdfStatus !== undefined) {
    add(
      'pdfStatus',
      tpl(t('filter.pdfStatusChip'), { value: t(`pdf.status.${value.pdfStatus}`) }),
      { pdfStatus: undefined },
    )
  }
  if (value.type !== undefined) {
    add('type', tpl(t('filter.typeChip'), { value: value.type }), { type: undefined })
  }
  if (value.venue !== undefined) {
    add('venue', tpl(t('filter.venueChip'), { value: value.venue }), { venue: undefined })
  }
  if (value.author !== undefined) {
    add('author', tpl(t('filter.authorChip'), { value: value.author }), { author: undefined })
  }
  if (value.newOnly === true) {
    add('newOnly', t('filter.newChip'), { newOnly: undefined })
  }
  return list
}

/** 已生效的筛选条件数量（用于折叠态提示）。 */
export function activeFilterCount(value: ResultsQuery): number {
  return collectActiveFilters(value).length
}

export function TaskFilters({
  t,
  value,
  sources,
  queries,
  groups = [],
  stats = null,
  screeningCounts,
  open,
  onOpenChange,
  onChange,
}: Props): ReactElement {
  const [keyword, setKeyword] = useState(value.q ?? '')
  // 「自定义」在没有年份区间时无法从 value 反推出来，需要单独记住用户的选择。
  const [customYear, setCustomYear] = useState(false)
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }

  const valueKey = JSON.stringify(value)

  // 外部点击筛选（概览里点柱子）时，把值同步回输入框。
  useEffect(() => {
    setKeyword(value.q ?? '')
  }, [valueKey])

  // 外部写入了固定的年份预设时退出「自定义」入口；重置为空也回到「不限」。
  useEffect(() => {
    if (yearPresetOf(value) !== 'custom') setCustomYear(false)
  }, [valueKey])

  useEffect(() => {
    const timer = setTimeout(() => {
      const current = latest.current
      if ((current.value.q ?? '') === keyword) return
      current.onChange({ ...current.value, q: keyword.trim() === '' ? undefined : keyword })
    }, TEXT_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [keyword])

  const patch = (next: Partial<ResultsQuery>): void => {
    onChange({ ...value, ...next })
  }

  const resetAll = (): void => {
    setCustomYear(false)
    onChange({})
  }

  const preset = customYear ? 'custom' : yearPresetOf(value)

  const setPreset = (next: YearPreset): void => {
    setCustomYear(next === 'custom')
    if (next === 'any' || next === 'custom') {
      // 自定义先清空，避免保留的年份区间又被识别回某个预设。
      patch({ yearFrom: undefined, yearTo: undefined })
      return
    }
    patch({ yearFrom: CURRENT_YEAR - Number(next), yearTo: undefined })
  }

  const typeOptions = facetOptions(stats?.byType, value.type)
  const venueOptions = facetOptions(stats?.topVenues, value.venue)
  const authorOptions = facetOptions(stats?.topAuthors, value.author)

  return (
    <Modal
        open={open}
        onClose={() => onOpenChange(false)}
        title={t('filter.title')}
        contentClassName={FILTER_CONTENT_CLASS}
        footer={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <button type="button" style={RESET_STYLE} onClick={resetAll}>
              {t('filter.reset')}
            </button>
            <Button variant="outline" size="sm" type="button" onClick={() => onOpenChange(false)}>
              {t('filter.done')}
            </Button>
          </div>
        }
      >
        <style>{FILTER_CONTENT_CSS}</style>
        <div style={GRID_STYLE}>
          <div style={SCREENING_FIELD_STYLE}>
            <span className="litsearch-filter-label">{t('filter.screening')}</span>
            <div style={PILL_ROW_STYLE}>
              {SCREENINGS.map((state) => (
                <button
                  key={state}
                  type="button"
                  style={value.screening === state ? PILL_ACTIVE_STYLE : PILL_STYLE}
                  onClick={() =>
                    patch({ screening: value.screening === state ? undefined : state })
                  }
                >
                  {t(`screening.${state}`)}
                  {screeningCounts === undefined ? '' : ` ${screeningCounts[state]}`}
                </button>
              ))}
            </div>
          </div>

          <label style={FIELD_STYLE}>
            <span>{t('filter.keyword')}</span>
            <input
              style={INPUT_STYLE}
              value={keyword}
              placeholder={t('filter.keywordPlaceholder')}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>

          <label style={FIELD_STYLE}>
            <span>{t('filter.source')}</span>
            <select
              style={INPUT_STYLE}
              value={value.source ?? ''}
              onChange={(event) =>
                patch({
                  source:
                    event.target.value === '' ? undefined : (event.target.value as SourceId),
                })
              }
            >
              <option value="">{t('filter.any')}</option>
              {sources.map((id) => (
                <option key={id} value={id}>
                  {t(`source.${id}`)}
                </option>
              ))}
            </select>
          </label>

          <label style={FIELD_STYLE}>
            <span>{t('filter.year')}</span>
            <select
              style={INPUT_STYLE}
              value={preset}
              onChange={(event) => setPreset(event.target.value as YearPreset)}
            >
              <option value="any">{t('filter.any')}</option>
              <option value="1">{t('filter.yearPreset1')}</option>
              <option value="5">{t('filter.yearPreset5')}</option>
              <option value="10">{t('filter.yearPreset10')}</option>
              <option value="custom">{t('filter.yearCustom')}</option>
            </select>
          </label>

          {preset === 'custom' && (
            <div style={CUSTOM_YEAR_STYLE}>
              <label style={FIELD_STYLE}>
                <span>{t('condition.yearFrom')}</span>
                <select
                  style={INPUT_STYLE}
                  value={value.yearFrom === undefined ? '' : String(value.yearFrom)}
                  onChange={(event) =>
                    patch({
                      yearFrom:
                        event.target.value === '' ? undefined : Number(event.target.value),
                    })
                  }
                >
                  <option value="">{t('filter.any')}</option>
                  {YEAR_OPTIONS.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>
              <label style={FIELD_STYLE}>
                <span>{t('condition.yearTo')}</span>
                <select
                  style={INPUT_STYLE}
                  value={value.yearTo === undefined ? '' : String(value.yearTo)}
                  onChange={(event) =>
                    patch({
                      yearTo: event.target.value === '' ? undefined : Number(event.target.value),
                    })
                  }
                >
                  <option value="">{t('filter.any')}</option>
                  {YEAR_OPTIONS.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <label style={FIELD_STYLE}>
            <span>{t('filter.group')}</span>
            <select
              style={INPUT_STYLE}
              value={value.groupId ?? ''}
              onChange={(event) =>
                patch({ groupId: event.target.value === '' ? undefined : event.target.value })
              }
            >
              <option value="">{t('filter.any')}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>

          <label style={FIELD_STYLE}>
            <span>{t('filter.language')}</span>
            <select
              style={INPUT_STYLE}
              value={value.language === 'any' ? '' : (value.language ?? '')}
              onChange={(event) =>
                patch({
                  language:
                    event.target.value === '' ? undefined : (event.target.value as TaskLanguage),
                })
              }
            >
              <option value="">{t('filter.any')}</option>
              {LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {t(`lang.${code}`)}
                </option>
              ))}
            </select>
          </label>

          <label style={FIELD_STYLE}>
            <span>{t('filter.sort')}</span>
            <select
              style={INPUT_STYLE}
              value={value.sort ?? 'relevance'}
              onChange={(event) =>
                // 相关度是默认排序，不写进筛选对象，否则会被当成一条生效条件。
                patch({
                  sort:
                    event.target.value === 'relevance'
                      ? undefined
                      : (event.target.value as SortMode),
                })
              }
            >
              {SORT_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`sort.${mode}`)}
                </option>
              ))}
            </select>
          </label>

          <div style={FULLTEXT_FIELD_STYLE}>
            <span className="litsearch-filter-label">{t('filter.fullText')}</span>
            <div style={CHECK_ROW_STYLE}>
              <label style={CHECK_STYLE}>
                <input
                  type="checkbox"
                  checked={value.openAccessOnly === true}
                  onChange={(event) =>
                    patch({ openAccessOnly: event.target.checked ? true : undefined })
                  }
                />
                {t('filter.openAccess')}
              </label>

              <label style={CHECK_STYLE}>
                <input
                  type="checkbox"
                  checked={value.hasPdf === true}
                  onChange={(event) => patch({ hasPdf: event.target.checked ? true : undefined })}
                />
                {t('filter.hasPdf')}
              </label>

              <label style={CHECK_STYLE}>
                <input
                  type="checkbox"
                  checked={value.missingFullText === true}
                  onChange={(event) =>
                    patch({
                      missingFullText: event.target.checked ? true : undefined,
                      hasFullText: undefined,
                    })
                  }
                />
                {t('filter.missingFullText')}
              </label>

              <label style={CHECK_STYLE}>
                <input
                  type="checkbox"
                  checked={value.hasFullText === true}
                  onChange={(event) =>
                    patch({
                      hasFullText: event.target.checked ? true : undefined,
                      missingFullText: undefined,
                    })
                  }
                />
                {t('filter.hasFullText')}
              </label>
            </div>
          </div>

          <label style={FIELD_STYLE}>
            <span>{t('filter.type')}</span>
            <select
              style={INPUT_STYLE}
              value={value.type ?? ''}
              onChange={(event) =>
                patch({ type: event.target.value === '' ? undefined : event.target.value })
              }
            >
              <option value="">{t('filter.any')}</option>
              {typeOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label style={FIELD_STYLE}>
            <span>{t('filter.venue')}</span>
            <select
              style={INPUT_STYLE}
              value={value.venue ?? ''}
              onChange={(event) =>
                patch({ venue: event.target.value === '' ? undefined : event.target.value })
              }
            >
              <option value="">{t('filter.any')}</option>
              {venueOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label style={FIELD_STYLE}>
            <span>{t('filter.author')}</span>
            <select
              style={INPUT_STYLE}
              value={value.author ?? ''}
              onChange={(event) =>
                patch({ author: event.target.value === '' ? undefined : event.target.value })
              }
            >
              <option value="">{t('filter.any')}</option>
              {authorOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
    </Modal>
  )
}

function ActiveChip({ label, onRemove }: { label: string; onRemove(): void }): ReactElement {
  return (
    <span style={CHIP_STYLE}>
      {label}
      <button type="button" style={CHIP_REMOVE_STYLE} onClick={onRemove} aria-label="remove">
        ×
      </button>
    </span>
  )
}

/** 与筛读计数按钮同款的胶囊按钮，前置漏斗图标；蓝色文字保证入口可发现。 */
const TOGGLE_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 10px',
  borderRadius: 999,
  border: '1px solid var(--ls-accent-line)',
  background: 'var(--ls-accent-soft)',
  color: 'var(--ls-accent-ink)',
  fontSize: 11.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
/** 有生效条件时高亮，提示点击可查看/清除。 */
const TOGGLE_ACTIVE_STYLE: CSSProperties = {
  ...TOGGLE_STYLE,
  borderColor: 'var(--ls-accent)',
  background: 'var(--ls-accent-soft-2)',
  color: 'var(--ls-accent-ink)',
  fontWeight: 500,
}
const RESET_STYLE: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  fontSize: 12,
  color: 'var(--ls-ink-2)',
  cursor: 'pointer',
}
const GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '10px 12px',
}
const FIELD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  minWidth: 0,
}
/** 筛读状态单独占满第一行，四个胶囊横向平铺。 */
const SCREENING_FIELD_STYLE: CSSProperties = {
  ...FIELD_STYLE,
  gridColumn: '1 / -1',
}
/** 「全文」勾选项合成一组，整行平铺，组内仍是多选。 */
const FULLTEXT_FIELD_STYLE: CSSProperties = {
  ...FIELD_STYLE,
  gridColumn: '1 / -1',
}
const CHECK_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px 16px',
  paddingTop: 1,
}
/** 筛读状态的胶囊按钮，与结果页原先的计数按钮同款。 */
const PILL_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  paddingTop: 1,
}
const PILL_STYLE: CSSProperties = {
  fontSize: 11.5,
  padding: '2px 8px',
  borderRadius: 10,
  border: '1px solid var(--ls-line-strong)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const PILL_ACTIVE_STYLE: CSSProperties = {
  ...PILL_STYLE,
  borderColor: 'var(--ls-accent)',
  color: 'var(--ls-accent-ink)',
  fontWeight: 500,
}
const INPUT_STYLE: CSSProperties = {
  fontSize: 12.5,
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid var(--ls-line-strong)',
  background: 'transparent',
  color: 'inherit',
  minWidth: 0,
}
const CUSTOM_YEAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  gridColumn: '1 / -1',
}
const CHECK_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 12,
  opacity: 0.92,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/** 分组标题需要比下拉框内容更醒目，样式只能通过 contentClassName 命中内部 label。 */
const FILTER_CONTENT_CLASS = 'litsearch-filter-content'
const FILTER_CONTENT_CSS = `
.${FILTER_CONTENT_CLASS} label>span,.${FILTER_CONTENT_CLASS} .litsearch-filter-label{font-size:12.5px;font-weight:500;line-height:1.5;color:var(--ls-ink-2)}
`

const CHIP_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11.5,
  padding: '2px 9px',
  borderRadius: 999,
  border: '1px solid var(--ls-accent-line)',
  background: 'var(--ls-accent-soft)',
  color: 'var(--ls-accent-ink)',
}
const CHIP_REMOVE_STYLE: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  lineHeight: 1,
  cursor: 'pointer',
}
