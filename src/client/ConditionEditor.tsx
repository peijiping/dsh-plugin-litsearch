/**
 * 任务条件编辑器：在任务 tab 内改检索式、数据源、条数、年份与排序。
 *
 * 保存走 PATCH /tasks/:id，带 rev 做乐观并发；运行中的任务由 TaskPane
 * 隐藏入口，避免 Host 侧冲突错误。
 */

import { useState, type CSSProperties, type ReactElement } from 'react'

import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'

import { MAX_LIMIT } from '../search/config'
import type { SortMode, SourceId, TaskDetail, TaskLanguage } from '../search/types'
import { SOURCE_IDS } from '../search/types'
import { updateTask, type TaskConditionsPatch } from './api'
import { useHealth } from './health'
import { tpl, type Translate } from './locales'
import { sourceSyntaxTitle, SyntaxHint } from './SyntaxHint'
import {
  draftsFromQueries,
  newQuery,
  QueryEditor,
  toQueryBodies,
  type QueryDraft,
} from './QueryEditor'
import { ERROR, linkButtonStyle, sourceRowStyle } from './styles'

const LANGUAGES: readonly TaskLanguage[] = ['any', 'eng', 'chi']
const SORTS: readonly SortMode[] = ['relevance', 'citations', 'year']

interface Props {
  t: Translate
  detail: TaskDetail
  onSaved(): void
  onCancel(): void
}

function parseYear(value: string): number | null | undefined {
  const text = value.trim()
  if (text === '') return null
  const year = Number.parseInt(text, 10)
  return Number.isInteger(year) && year >= 1 && year <= 9999 ? year : undefined
}

function splitTypes(value: string): string[] {
  const seen = new Set<string>()
  for (const raw of value.split(',')) {
    const type = raw.trim().slice(0, 40)
    if (type !== '') seen.add(type)
    if (seen.size >= 20) break
  }
  return [...seen]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ConditionEditor({ t, detail, onSaved, onCancel }: Props): ReactElement {
  const health = useHealth()
  const [drafts, setDrafts] = useState<QueryDraft[]>(() =>
    draftsFromQueries(detail.conditions.queries),
  )
  const [sources, setSources] = useState<SourceId[]>([...detail.conditions.sources])
  const [pageSize, setPageSize] = useState(String(detail.conditions.pageSize))
  const [yearFrom, setYearFrom] = useState(
    detail.conditions.yearFrom === undefined ? '' : String(detail.conditions.yearFrom),
  )
  const [yearTo, setYearTo] = useState(
    detail.conditions.yearTo === undefined ? '' : String(detail.conditions.yearTo),
  )
  const [openAccessOnly, setOpenAccessOnly] = useState(detail.conditions.openAccessOnly)
  const [language, setLanguage] = useState<TaskLanguage>(detail.conditions.language)
  const [sort, setSort] = useState<SortMode>(detail.conditions.sort)
  const [types, setTypes] = useState((detail.conditions.types ?? []).join(', '))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patchQuery = (index: number, patch: Partial<QueryDraft>): void => {
    setDrafts((previous) =>
      previous.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)),
    )
  }

  const toggleSource = (id: SourceId): void => {
    setSources((previous) => {
      if (previous.includes(id)) {
        return previous.length === 1 ? previous : previous.filter((source) => source !== id)
      }
      return SOURCE_IDS.filter((source) => source === id || previous.includes(source))
    })
  }

  const save = (): void => {
    if (saving) return
    const bodies = toQueryBodies(drafts)
    if (!bodies.some((body) => body.enabled !== false)) {
      setError(t('condition.needQuery'))
      return
    }
    const size = Number.parseInt(pageSize, 10)
    if (!Number.isInteger(size) || size < 1 || size > MAX_LIMIT) {
      setError(tpl(t('condition.invalidPageSize'), { max: MAX_LIMIT }))
      return
    }
    const from = parseYear(yearFrom)
    const to = parseYear(yearTo)
    if (from === undefined || to === undefined) {
      setError(t('condition.invalidYear'))
      return
    }
    if (from !== null && to !== null && from > to) {
      setError(t('condition.invalidYear'))
      return
    }

    const conditions: TaskConditionsPatch = {
      queries: bodies,
      sources,
      pageSize: size,
      yearFrom: from,
      yearTo: to,
      openAccessOnly,
      language,
      sort,
      types: splitTypes(types),
    }
    setSaving(true)
    setError(null)
    void updateTask(detail.id, { conditions, rev: detail.rev })
      .then(() => onSaved())
      .catch((err: unknown) => setError(messageOf(err)))
      .finally(() => setSaving(false))
  }

  return (
    <section style={PANEL_STYLE}>
      <div style={HEAD_STYLE}>
        <strong style={{ fontSize: 12 }}>{t('condition.title')}</strong>
        <button type="button" style={linkButtonStyle} onClick={onCancel}>
          {t('condition.cancel')}
        </button>
      </div>

      <div style={QUERY_LIST_STYLE}>
        {drafts.map((draft, index) => (
          <QueryEditor
            key={index}
            t={t}
            index={index}
            draft={draft}
            canRemove={drafts.length > 1}
            onChange={(patch) => patchQuery(index, patch)}
            onRemove={() => setDrafts((previous) => previous.filter((_, i) => i !== index))}
          />
        ))}
        <button
          type="button"
          style={linkButtonStyle}
          onClick={() => setDrafts((previous) => [...previous, newQuery()])}
        >
          {t('search.addQuery')}
        </button>
      </div>

      <div style={sourceRowStyle}>
        <span style={FIELD_LABEL_STYLE}>{t('search.sources')}</span>
        {SOURCE_IDS.map((id) => (
          <span key={id} title={sourceSyntaxTitle(health?.sources, id)}>
            <Pill
              type="button"
              active={sources.includes(id)}
              aria-pressed={sources.includes(id)}
              onClick={() => toggleSource(id)}
            >
              {t(`source.${id}`)}
            </Pill>
          </span>
        ))}
      </div>

      <SyntaxHint
        t={t}
        sources={sources}
        texts={drafts.filter((draft) => draft.enabled).map((draft) => draft.text)}
        infos={health?.sources}
      />

      <div style={ROW_STYLE}>
        <label style={FIELD_STYLE}>
          <span style={FIELD_LABEL_STYLE}>{t('condition.pageSize')}</span>
          <Input
            type="number"
            min={1}
            max={MAX_LIMIT}
            value={pageSize}
            style={NUMBER_INPUT_STYLE}
            onChange={(event) => setPageSize(event.target.value)}
          />
        </label>
        <label style={FIELD_STYLE}>
          <span style={FIELD_LABEL_STYLE}>{t('condition.yearFrom')}</span>
          <Input
            inputMode="numeric"
            placeholder="2000"
            value={yearFrom}
            style={NUMBER_INPUT_STYLE}
            onChange={(event) => setYearFrom(event.target.value)}
          />
        </label>
        <label style={FIELD_STYLE}>
          <span style={FIELD_LABEL_STYLE}>{t('condition.yearTo')}</span>
          <Input
            inputMode="numeric"
            placeholder="2026"
            value={yearTo}
            style={NUMBER_INPUT_STYLE}
            onChange={(event) => setYearTo(event.target.value)}
          />
        </label>
      </div>

      <div style={ROW_STYLE}>
        <label style={CHECK_STYLE}>
          <input
            type="checkbox"
            checked={openAccessOnly}
            onChange={(event) => setOpenAccessOnly(event.target.checked)}
          />
          {t('condition.openAccess')}
        </label>
        <label style={FIELD_STYLE}>
          <span style={FIELD_LABEL_STYLE}>{t('filter.language')}</span>
          <select
            style={SELECT_STYLE}
            value={language}
            onChange={(event) => setLanguage(event.target.value as TaskLanguage)}
          >
            {LANGUAGES.map((value) => (
              <option key={value} value={value}>
                {t(`lang.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label style={FIELD_STYLE}>
          <span style={FIELD_LABEL_STYLE}>{t('filter.sort')}</span>
          <select
            style={SELECT_STYLE}
            value={sort}
            onChange={(event) => setSort(event.target.value as SortMode)}
          >
            {SORTS.map((value) => (
              <option key={value} value={value}>
                {t(`sort.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label style={{ ...FIELD_STYLE, flexDirection: 'column', alignItems: 'stretch' }}>
        <span style={FIELD_LABEL_STYLE}>{t('condition.types')}</span>
        <Input
          value={types}
          placeholder={t('condition.typesPlaceholder')}
          onChange={(event) => setTypes(event.target.value)}
        />
      </label>

      {error !== null && <div style={{ fontSize: 12, color: ERROR }}>{error}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" size="sm" type="button" disabled={saving} onClick={save}>
          {saving ? t('condition.saving') : t('condition.save')}
        </Button>
      </div>
    </section>
  )
}

const PANEL_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '8px 9px',
  borderRadius: 7,
  border: '1px solid rgba(80,140,255,0.3)',
  background: 'rgba(80,140,255,0.06)',
}

const HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

const QUERY_LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
}

const FIELD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
}

const FIELD_LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  opacity: 0.68,
  whiteSpace: 'nowrap',
}

const NUMBER_INPUT_STYLE: CSSProperties = {
  width: 64,
  fontSize: 11.5,
}

const SELECT_STYLE: CSSProperties = {
  fontSize: 11.5,
  padding: '2px 4px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
}

const CHECK_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
}
