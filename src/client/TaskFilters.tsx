/**
 * 任务结果的筛选条。
 *
 * 文本类条件（关键词、年份、类型）本地暂存 300ms 再上抛，避免每敲一个字都
 * 打一次 Host；下拉类条件立即生效。父组件的筛选对象必须能直接喂给
 * `/results` 与 `/stats`。
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import type { QueryBlock, SortMode, SourceId, TaskGroup, TaskLanguage } from '../search/types'
import type { ResultsQuery } from './api'
import { tpl, type Translate } from './locales'

const TEXT_DEBOUNCE_MS = 300

const SORT_MODES: readonly SortMode[] = ['relevance', 'citations', 'year']
const LANGUAGES: readonly TaskLanguage[] = ['any', 'eng', 'chi']
const SCREENINGS = ['unread', 'read', 'included', 'excluded'] as const

type Screening = (typeof SCREENINGS)[number]

interface Draft {
  q: string
  yearFrom: string
  yearTo: string
  type: string
  venue: string
  author: string
}

interface Props {
  t: Translate
  value: ResultsQuery
  sources: readonly SourceId[]
  queries: readonly QueryBlock[]
  groups?: readonly TaskGroup[]
  onChange(next: ResultsQuery): void
}

function toDraft(value: ResultsQuery): Draft {
  return {
    q: value.q ?? '',
    yearFrom: value.yearFrom === undefined ? '' : String(value.yearFrom),
    yearTo: value.yearTo === undefined ? '' : String(value.yearTo),
    type: value.type ?? '',
    venue: value.venue ?? '',
    author: value.author ?? '',
  }
}

function mergeDraft(base: ResultsQuery, draft: Draft): ResultsQuery {
  const next: ResultsQuery = { ...base }
  // 保留原始文本（服务端会 trim），避免防抖回写把用户刚敲的空格吃掉、光标跳动。
  next.q = draft.q === '' ? undefined : draft.q
  next.type = draft.type === '' ? undefined : draft.type
  next.venue = draft.venue === '' ? undefined : draft.venue
  next.author = draft.author === '' ? undefined : draft.author
  const yearFrom = Number(draft.yearFrom)
  next.yearFrom =
    draft.yearFrom.trim() === '' || !Number.isFinite(yearFrom) || yearFrom <= 0
      ? undefined
      : Math.floor(yearFrom)
  const yearTo = Number(draft.yearTo)
  next.yearTo =
    draft.yearTo.trim() === '' || !Number.isFinite(yearTo) || yearTo <= 0
      ? undefined
      : Math.floor(yearTo)
  return next
}

/** 已生效的筛选条件数量（用于折叠态提示）。 */
export function activeFilterCount(value: ResultsQuery): number {
  let count = 0
  if (value.q !== undefined && value.q.trim() !== '') count += 1
  if (value.source !== undefined) count += 1
  if (value.yearFrom !== undefined || value.yearTo !== undefined) count += 1
  if (value.openAccessOnly === true) count += 1
  if (value.hasPdf === true) count += 1
  if (value.missingFullText === true) count += 1
  if (value.screening !== undefined) count += 1
  if (value.language !== undefined) count += 1
  if (value.queryId !== undefined) count += 1
  if (value.type !== undefined) count += 1
  if (value.sort !== undefined) count += 1
  if (value.groupId !== undefined) count += 1
  if (value.venue !== undefined) count += 1
  if (value.author !== undefined) count += 1
  if (value.newOnly === true) count += 1
  return count
}

export function TaskFilters({
  t,
  value,
  sources,
  queries,
  groups = [],
  onChange,
}: Props): ReactElement {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(() => toDraft(value))
  const latest = useRef({ value, onChange })
  latest.current = { value, onChange }

  const draftKey = JSON.stringify(draft)
  const valueKey = JSON.stringify(value)

  // 外部点击筛选（概览里点柱子）时，把值同步回输入框。
  useEffect(() => {
    setDraft(toDraft(value))
  }, [valueKey])

  useEffect(() => {
    const timer = setTimeout(() => {
      const current = latest.current
      current.onChange(mergeDraft(current.value, draft))
    }, TEXT_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [draftKey])

  const patch = (next: Partial<ResultsQuery>): void => {
    onChange({ ...value, ...next })
  }

  const count = activeFilterCount(value)
  const queryName =
    value.queryId === undefined
      ? ''
      : (queries.find((query) => query.id === value.queryId)?.name ?? value.queryId)
  const groupName =
    value.groupId === undefined
      ? ''
      : (groups.find((group) => group.id === value.groupId)?.name ?? value.groupId)

  const setDraftValue = (key: keyof Draft, text: string): void => {
    setDraft((previous) => ({ ...previous, [key]: text }))
  }

  return (
    <div style={WRAP_STYLE}>
      <div style={HEAD_ROW_STYLE}>
        <button type="button" style={TOGGLE_STYLE} onClick={() => setOpen((next) => !next)}>
          {open ? t('filter.hide') : t('filter.show')}
          {count === 0 ? '' : `（${count}）`}
        </button>
        {count > 0 && (
          <button type="button" style={RESET_STYLE} onClick={() => onChange({})}>
            {t('filter.reset')}
          </button>
        )}
        {value.type !== undefined && (
          <ActiveChip
            label={tpl(t('filter.typeChip'), { value: value.type })}
            onRemove={() => patch({ type: undefined })}
          />
        )}
        {value.queryId !== undefined && (
          <ActiveChip
            label={tpl(t('filter.queryChip'), { value: queryName })}
            onRemove={() => patch({ queryId: undefined })}
          />
        )}
        {value.groupId !== undefined && (
          <ActiveChip
            label={tpl(t('filter.groupChip'), { value: groupName })}
            onRemove={() => patch({ groupId: undefined })}
          />
        )}
        {value.venue !== undefined && (
          <ActiveChip
            label={tpl(t('filter.venueChip'), { value: value.venue })}
            onRemove={() => patch({ venue: undefined })}
          />
        )}
        {value.author !== undefined && (
          <ActiveChip
            label={tpl(t('filter.authorChip'), { value: value.author })}
            onRemove={() => patch({ author: undefined })}
          />
        )}
        {value.newOnly === true && (
          <ActiveChip
            label={t('filter.newChip')}
            onRemove={() => patch({ newOnly: undefined })}
          />
        )}
      </div>

      {open && (
        <div style={GRID_STYLE}>
          <label style={FIELD_STYLE}>
            <span>{t('filter.keyword')}</span>
            <input
              style={INPUT_STYLE}
              value={draft.q}
              placeholder={t('filter.keywordPlaceholder')}
              onChange={(event) => setDraftValue('q', event.target.value)}
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
            <span style={INLINE_STYLE}>
              <input
                style={{ ...INPUT_STYLE, width: 66 }}
                inputMode="numeric"
                value={draft.yearFrom}
                placeholder="1900"
                onChange={(event) => setDraftValue('yearFrom', event.target.value)}
              />
              <span style={DASH_STYLE}>–</span>
              <input
                style={{ ...INPUT_STYLE, width: 66 }}
                inputMode="numeric"
                value={draft.yearTo}
                placeholder="2026"
                onChange={(event) => setDraftValue('yearTo', event.target.value)}
              />
            </span>
          </label>

          <label style={FIELD_STYLE}>
            <span>{t('filter.screening')}</span>
            <select
              style={INPUT_STYLE}
              value={value.screening ?? ''}
              onChange={(event) =>
                patch({
                  screening:
                    event.target.value === '' ? undefined : (event.target.value as Screening),
                })
              }
            >
              <option value="">{t('filter.any')}</option>
              {SCREENINGS.map((state) => (
                <option key={state} value={state}>
                  {t(`screening.${state}`)}
                </option>
              ))}
            </select>
          </label>

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
              value={value.language ?? ''}
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
              onChange={(event) => patch({ sort: event.target.value as SortMode })}
            >
              {SORT_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`sort.${mode}`)}
                </option>
              ))}
            </select>
          </label>

          <label style={CHECK_STYLE}>
            <input
              type="checkbox"
              checked={value.openAccessOnly === true}
              onChange={(event) => patch({ openAccessOnly: event.target.checked ? true : undefined })}
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
                patch({ missingFullText: event.target.checked ? true : undefined })
              }
            />
            {t('filter.missingFullText')}
          </label>

          <label style={FIELD_STYLE}>
            <span>{t('filter.type')}</span>
            <input
              style={INPUT_STYLE}
              value={draft.type}
              placeholder={t('filter.typePlaceholder')}
              onChange={(event) => setDraftValue('type', event.target.value)}
            />
          </label>

          <label style={FIELD_STYLE}>
            <span>{t('filter.venue')}</span>
            <input
              style={INPUT_STYLE}
              value={draft.venue}
              placeholder={t('filter.venuePlaceholder')}
              onChange={(event) => setDraftValue('venue', event.target.value)}
            />
          </label>

          <label style={FIELD_STYLE}>
            <span>{t('filter.author')}</span>
            <input
              style={INPUT_STYLE}
              value={draft.author}
              placeholder={t('filter.authorPlaceholder')}
              onChange={(event) => setDraftValue('author', event.target.value)}
            />
          </label>
        </div>
      )}
    </div>
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

const WRAP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '4px 0',
  borderBottom: '1px solid rgba(127,127,127,0.12)',
}
const HEAD_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
}
const TOGGLE_STYLE: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: '#508cff',
  fontSize: 12,
  cursor: 'pointer',
}
const RESET_STYLE: CSSProperties = {
  ...TOGGLE_STYLE,
  color: 'inherit',
  opacity: 0.7,
}
const GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 6,
}
const FIELD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 11,
  opacity: 0.86,
  minWidth: 0,
}
const INPUT_STYLE: CSSProperties = {
  fontSize: 12,
  padding: '3px 5px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
  minWidth: 0,
}
const INLINE_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4 }
const DASH_STYLE: CSSProperties = { opacity: 0.5, fontSize: 11 }
const CHECK_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  opacity: 0.86,
  alignSelf: 'end',
  paddingBottom: 3,
}
const CHIP_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid rgba(80,140,255,0.4)',
  color: '#508cff',
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
