/**
 * 检索式编辑器：名称、启停、单源覆写。
 *
 * 新建任务与「改条件」共用同一份草稿结构；提交前由 {@link toQueryBodies}
 * 去掉空行与空的覆写，保持 Host 的入参校验宽松。
 */

import { useState, type CSSProperties, type ReactElement } from 'react'

import { Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'

import type { QueryBlock, SourceId } from '../search/types'
import { SOURCE_IDS } from '../search/types'
import type { QueryBody } from './api'
import { tpl, type Translate } from './locales'
import { ACCENT, linkButtonStyle, sourceRowStyle } from './styles'

/** 检索式草稿：名称、启停与单源覆写都在面板内编辑。 */
export interface QueryDraft {
  name: string
  text: string
  enabled: boolean
  perSource: Partial<Record<SourceId, string>>
}

export function newQuery(): QueryDraft {
  return { name: '', text: '', enabled: true, perSource: {} }
}

export function draftsFromQueries(queries: readonly QueryBlock[]): QueryDraft[] {
  return queries.map((query) => ({
    name: query.name,
    text: query.text,
    enabled: query.enabled,
    perSource: { ...query.perSource },
  }))
}

function overrideSources(draft: QueryDraft): SourceId[] {
  return SOURCE_IDS.filter((id) => draft.perSource[id] !== undefined)
}

/** 只提交有文本的检索式；禁用项也保留进任务，便于之后重新启用。 */
export function toQueryBodies(drafts: readonly QueryDraft[]): QueryBody[] {
  return drafts
    .filter((draft) => draft.text.trim() !== '')
    .map((draft) => {
      const perSource: Partial<Record<SourceId, string>> = {}
      for (const id of overrideSources(draft)) {
        const text = draft.perSource[id]?.trim() ?? ''
        if (text !== '') perSource[id] = text
      }
      return {
        text: draft.text.trim(),
        enabled: draft.enabled,
        ...(draft.name.trim() === '' ? {} : { name: draft.name.trim() }),
        ...(Object.keys(perSource).length === 0 ? {} : { perSource }),
      }
    })
}

interface Props {
  t: Translate
  index: number
  draft: QueryDraft
  canRemove: boolean
  onChange(patch: Partial<QueryDraft>): void
  onRemove(): void
}

export function QueryEditor({
  t,
  index,
  draft,
  canRemove,
  onChange,
  onRemove,
}: Props): ReactElement {
  const [showOverrides, setShowOverrides] = useState(false)
  const overridden = overrideSources(draft)

  const toggleOverride = (id: SourceId): void => {
    const next = { ...draft.perSource }
    if (next[id] === undefined) next[id] = ''
    else delete next[id]
    onChange({ perSource: next })
  }

  const editOverride = (id: SourceId, text: string): void => {
    onChange({ perSource: { ...draft.perSource, [id]: text } })
  }

  return (
    <div style={draft.enabled ? queryCardStyle : disabledQueryCardStyle}>
      <div style={queryHeadStyle}>
        <button
          type="button"
          style={{ ...enableButtonStyle, color: draft.enabled ? ACCENT : 'inherit' }}
          title={t(draft.enabled ? 'search.disableQuery' : 'search.enableQuery')}
          aria-label={t(draft.enabled ? 'search.disableQuery' : 'search.enableQuery')}
          aria-pressed={draft.enabled}
          onClick={() => onChange({ enabled: !draft.enabled })}
        >
          {draft.enabled ? '●' : '○'}
        </button>
        <span style={nameLabelStyle}>{t('search.nameLabel')}</span>
        <Input
          value={draft.name}
          placeholder={t('search.namePlaceholder')}
          aria-label={t('search.namePlaceholder')}
          style={nameInputStyle}
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <button
          type="button"
          style={linkButtonStyle}
          title={t('search.perSourceHint')}
          aria-expanded={showOverrides}
          onClick={() => setShowOverrides((previous) => !previous)}
        >
          {overridden.length === 0
            ? t('search.perSource')
            : tpl(t('search.perSourceCount'), { n: overridden.length })}
        </button>
        {canRemove && (
          <button
            type="button"
            style={{ ...linkButtonStyle, whiteSpace: 'nowrap', flexShrink: 0 }}
            title={t('search.removeQuery')}
            aria-label={t('search.removeQuery')}
            onClick={onRemove}
          >
            {t('search.removeQueryText')}
          </button>
        )}
      </div>
      <Input
        value={draft.text}
        placeholder={
          index === 0
            ? t('search.placeholder')
            : tpl(t('search.queryPlaceholder'), { n: index + 1 })
        }
        aria-label={
          index === 0
            ? t('search.placeholder')
            : tpl(t('search.queryPlaceholder'), { n: index + 1 })
        }
        onChange={(event) => onChange({ text: event.target.value })}
      />
      {showOverrides && (
        <div style={overridePanelStyle}>
          <div style={sourceRowStyle}>
            {SOURCE_IDS.map((id) => (
              <Pill
                key={id}
                type="button"
                active={draft.perSource[id] !== undefined}
                aria-pressed={draft.perSource[id] !== undefined}
                onClick={() => toggleOverride(id)}
              >
                {t(`source.${id}`)}
              </Pill>
            ))}
          </div>
          {overridden.map((id) => (
            <div key={id} style={overrideRowStyle}>
              <span style={overrideLabelStyle} title={t(`source.${id}`)}>
                {t(`source.${id}`)}
              </span>
              <Input
                value={draft.perSource[id] ?? ''}
                placeholder={t('search.perSourcePlaceholder')}
                aria-label={tpl(t('search.perSourceLabel'), { source: t(`source.${id}`) })}
                onChange={(event) => editOverride(id, event.target.value)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const queryCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  padding: '7px 8px',
  border: '1px solid rgba(127,127,127,0.22)',
  borderRadius: 7,
  minWidth: 0,
}

const disabledQueryCardStyle: CSSProperties = {
  ...queryCardStyle,
  opacity: 0.55,
}

const queryHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

const enableButtonStyle: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  fontSize: 13,
  lineHeight: 1,
  cursor: 'pointer',
}

const nameLabelStyle: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 11,
  opacity: 0.7,
  whiteSpace: 'nowrap',
}

const nameInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 11.5,
}

const overridePanelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  paddingTop: 6,
  borderTop: '1px dashed rgba(127,127,127,0.25)',
}

const overrideRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

const overrideLabelStyle: CSSProperties = {
  flex: '0 0 72px',
  fontSize: 11,
  opacity: 0.7,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
