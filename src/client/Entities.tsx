/**
 * PubTator3 实体标注面板。
 *
 * 首次展开时才请求，结果按实体类型分组；窄栏里用紧凑 chip 展示原文，
 * 标准标识符放在 title 里，避免长 ID 挤占正文。
 */

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'

import type { PaperEntities, PaperEntity } from '../search/types'
import { fetchPaperEntities } from './api'
import { tpl, type Translate } from './locales'
import { ERROR, linkButtonStyle, statusStyle } from './styles'

interface Props {
  t: Translate
  taskId: string
  paperId: string
  pmid: string
}

interface State {
  data: PaperEntities | null
  loading: boolean
  error: string | null
}

export function EntityPanel({ t, taskId, paperId, pmid }: Props): ReactElement {
  const [state, setState] = useState<State>({ data: null, loading: false, error: null })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (pmid === '') return undefined
    const controller = new AbortController()
    setState({ data: null, loading: true, error: null })
    fetchPaperEntities(taskId, paperId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({
          data: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return () => controller.abort()
  }, [taskId, paperId, pmid, nonce])

  if (pmid === '') return <div style={statusStyle}>{t('entity.noPmid')}</div>
  if (state.loading) return <div style={statusStyle}>{t('entity.loading')}</div>
  if (state.error !== null) {
    return (
      <div style={{ ...statusStyle, color: ERROR }}>
        {tpl(t('entity.failed'), { message: state.error })}
        <button
          type="button"
          style={{ ...linkButtonStyle, marginLeft: 6 }}
          onClick={() => setNonce((value) => value + 1)}
        >
          {t('paperTab.retry')}
        </button>
      </div>
    )
  }
  const entities = state.data?.entities ?? []
  if (entities.length === 0) return <div style={statusStyle}>{t('entity.empty')}</div>

  const groups = groupByType(entities)
  return (
    <div style={WRAP_STYLE}>
      <div style={HINT_STYLE}>
        {tpl(t('entity.count'), { n: entities.length })} · {t('entity.hint')}
      </div>
      {groups.map(([type, items]) => (
        <div key={type} style={GROUP_STYLE}>
          <span style={TYPE_STYLE}>{typeLabel(t, type)}</span>
          <div style={CHIPS_STYLE}>
            {items.map((entity) => (
              <span
                key={`${entity.identifier}\u0000${entity.text}`}
                style={CHIP_STYLE}
                title={entityTitle(entity)}
              >
                {entity.text}
                {entity.count > 1 ? ` ×${entity.count}` : ''}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function groupByType(entities: readonly PaperEntity[]): [string, PaperEntity[]][] {
  const groups = new Map<string, PaperEntity[]>()
  for (const entity of entities) {
    const list = groups.get(entity.type)
    if (list === undefined) groups.set(entity.type, [entity])
    else list.push(entity)
  }
  return [...groups.entries()]
    .map(([type, items]) => [type, [...items].sort((a, b) => b.count - a.count)] as [string, PaperEntity[]])
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
}

function typeLabel(t: Translate, type: string): string {
  const key = `entity.type.${type.toLowerCase()}`
  const label = t(key)
  return label === key ? type : label
}

function entityTitle(entity: PaperEntity): string {
  const parts = [entity.name, entity.database, entity.identifier].filter((part) => part !== '')
  return parts.join(' · ')
}

const WRAP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  marginTop: 6,
  padding: '6px 8px',
  borderRadius: 6,
  background: 'rgba(127,127,127,0.07)',
}
const HINT_STYLE: CSSProperties = { fontSize: 11, opacity: 0.68 }
const GROUP_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  fontSize: 11,
}
const TYPE_STYLE: CSSProperties = {
  flex: '0 0 auto',
  minWidth: 48,
  fontWeight: 600,
  opacity: 0.72,
  lineHeight: '18px',
}
const CHIPS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  minWidth: 0,
}
const CHIP_STYLE: CSSProperties = {
  padding: '0 6px',
  borderRadius: 9,
  border: '1px solid rgba(127,127,127,0.28)',
  fontSize: 11,
  lineHeight: '16px',
  whiteSpace: 'nowrap',
}
