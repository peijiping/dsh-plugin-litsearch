/**
 * 右侧栏「文献检索」面板。
 *
 * 输入关键词、勾选数据源即可检索；结果按数据源展示标题、作者、年份、出处、
 * 被引与开放获取状态。摘要默认截断，可展开；「插入到对话」只写进会话草稿。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'

import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Paper, SearchResult, SourceId } from '../search/types'
import { SOURCE_IDS } from '../search/types'
import { search } from './api'
import { paperText } from './compose'
import { insertBuilt, type InputActions } from './inline'
import { tpl, type Translate } from './locales'
import {
  ERROR,
  actionRowStyle,
  abstractStyle,
  badgeRowStyle,
  badgeStyle,
  cardStyle,
  formStyle,
  linkButtonStyle,
  linkStyle,
  listStyle,
  metaStyle,
  panelStyle,
  sourceLabelStyle,
  sourceRowStyle,
  statusStyle,
  titleStyle,
  toastStyle,
} from './styles'

/** 折叠态摘要长度。 */
const ABSTRACT_PREVIEW = 260

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; result: SearchResult }

export interface SearchPaneProps {
  t: Translate
  inputActions?: InputActions
}

export function SearchPane({ t, inputActions }: SearchPaneProps): ReactElement {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SourceId[]>([...SOURCE_IDS])
  const [state, setState] = useState<SearchState>({ kind: 'idle' })
  const [toast, setToast] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    if (toast === '') return undefined
    const timer = setTimeout(() => setToast(''), 2400)
    return () => clearTimeout(timer)
  }, [toast])

  const toggleSource = (id: SourceId): void => {
    setSelected((previous) => {
      if (previous.includes(id)) {
        // 至少保留一个数据源。
        return previous.length === 1 ? previous : previous.filter((source) => source !== id)
      }
      return SOURCE_IDS.filter((source) => source === id || previous.includes(source))
    })
  }

  const run = async (): Promise<void> => {
    const q = query.trim()
    if (q === '') return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setState({ kind: 'loading' })
    try {
      const result = await search({ q, sources: selected, signal: controller.signal })
      if (!controller.signal.aborted) setState({ kind: 'ready', result })
    } catch (error) {
      if (controller.signal.aborted) return
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const insert = async (paper: Paper): Promise<void> => {
    const outcome = await insertBuilt(inputActions, () => paperText(t, paper))
    if (outcome === 'inserted') setToast(t('result.inserted'))
    else setToast(t(outcome === 'no-editor' ? 'error.noEditor' : 'error.draftChanged'))
  }

  const loading = state.kind === 'loading'

  return (
    <div style={panelStyle}>
      <form
        style={formStyle}
        onSubmit={(event) => {
          event.preventDefault()
          void run()
        }}
      >
        <Input
          value={query}
          placeholder={t('search.placeholder')}
          aria-label={t('search.placeholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" variant="primary" size="sm" disabled={loading || query.trim() === ''}>
          {loading ? t('search.searching') : t('search.button')}
        </Button>
      </form>

      <div style={sourceRowStyle}>
        <span style={sourceLabelStyle}>{t('search.sources')}</span>
        {SOURCE_IDS.map((id) => (
          <Pill
            key={id}
            type="button"
            active={selected.includes(id)}
            aria-pressed={selected.includes(id)}
            onClick={() => toggleSource(id)}
          >
            {t(`source.${id}`)}
          </Pill>
        ))}
      </div>

      {toast !== '' && <div style={toastStyle}>{toast}</div>}

      <SearchStatus state={state} t={t} />

      {state.kind === 'ready' && state.result.papers.length > 0 && (
        <ul style={listStyle}>
          {state.result.papers.map((paper) => (
            <li key={`${paper.source}:${paper.doi || paper.sourceId || paper.title}`}>
              <PaperRow paper={paper} t={t} onInsert={insert} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SearchStatus({ state, t }: { state: SearchState; t: Translate }): ReactElement | null {
  if (state.kind === 'idle') return <div style={statusStyle}>{t('search.empty')}</div>
  if (state.kind === 'loading') return <div style={statusStyle}>{t('search.searching')}</div>
  if (state.kind === 'error') return <div style={{ ...statusStyle, color: ERROR }}>{state.message}</div>

  const failed = state.result.sources.filter((source) => !source.ok)
  return (
    <>
      <div style={statusStyle}>
        {tpl(t('search.count'), { n: state.result.papers.length })}
      </div>
      {failed.length > 0 && (
        <div style={{ ...statusStyle, color: ERROR }}>
          {failed
            .map((source) =>
              tpl(t('error.sourceFailed'), {
                source: t(`source.${source.id}`),
                message: source.error ?? '',
              }),
            )
            .join('；')}
        </div>
      )}
      {state.result.papers.length === 0 && (
        <div style={statusStyle}>{t('search.noResults')}</div>
      )}
    </>
  )
}

function PaperRow({
  paper,
  t,
  onInsert,
}: {
  paper: Paper
  t: Translate
  onInsert: (paper: Paper) => Promise<void>
}): ReactElement {
  const [expanded, setExpanded] = useState(false)

  const authors =
    paper.authors.length === 0
      ? ''
      : `${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' et al.' : ''}`
  const meta = [authors, paper.year === null ? '' : String(paper.year), paper.venue]
    .filter((part) => part !== '')
    .join(' · ')
  const canCollapse = paper.abstract.length > ABSTRACT_PREVIEW
  const abstract =
    expanded || !canCollapse
      ? paper.abstract
      : `${paper.abstract.slice(0, ABSTRACT_PREVIEW)}…`

  return (
    <article style={cardStyle}>
      {paper.url === '' ? (
        <span style={titleStyle}>{paper.title}</span>
      ) : (
        <a style={titleStyle} href={paper.url} target="_blank" rel="noreferrer noopener">
          {paper.title}
        </a>
      )}

      {meta !== '' && <div style={metaStyle}>{meta}</div>}

      <div style={badgeRowStyle}>
        <span style={badgeStyle}>{t(`source.${paper.source}`)}</span>
        {paper.citedBy !== null && (
          <span style={badgeStyle}>{tpl(t('result.citedBy'), { n: paper.citedBy })}</span>
        )}
        {paper.openAccess && <span style={badgeStyle}>{t('result.openAccess')}</span>}
      </div>

      {paper.abstract !== '' && (
        <div style={abstractStyle}>
          {abstract}
          {canCollapse && (
            <>
              {' '}
              <button
                type="button"
                style={linkButtonStyle}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? t('result.collapseAbstract') : t('result.expandAbstract')}
              </button>
            </>
          )}
        </div>
      )}

      <div style={actionRowStyle}>
        <Button variant="ghost" size="sm" type="button" onClick={() => void onInsert(paper)}>
          {t('result.insert')}
        </Button>
        {paper.pdfUrl !== '' && (
          <a style={linkStyle} href={paper.pdfUrl} target="_blank" rel="noreferrer noopener">
            {t('result.pdf')}
          </a>
        )}
        {paper.doi !== '' && (
          <a
            style={linkStyle}
            href={`https://doi.org/${paper.doi}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            DOI
          </a>
        )}
      </div>
    </article>
  )
}
