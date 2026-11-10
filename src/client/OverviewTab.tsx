/**
 * 任务「概览」tab：漏斗、年份、来源、检索式贡献与指标。
 *
 * 统计口径由 Host 的 `/stats` 计算，与结果列表共用同一套筛选；点了来源 /
 * 检索式 / 类型会直接落到「结果」tab 的对应筛选上（由父组件切换 tab）。
 */

import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'

import type { SourceStat, TaskStatsReport, YearStat } from '../search/types'
import { fetchStats, type ResultsQuery } from './api'
import { tpl, type Translate } from './locales'

const YEAR_BARS = 14

const FULLTEXT_STATUSES = [
  { status: 'unknown', key: 'unknown' },
  { status: 'available', key: 'available' },
  { status: 'downloaded', key: 'downloaded' },
  { status: 'html-only', key: 'htmlOnly' },
  { status: 'paywalled', key: 'paywalled' },
  { status: 'blocked', key: 'blocked' },
  { status: 'failed', key: 'failed' },
] as const

interface Props {
  t: Translate
  taskId: string
  rev: number
  filters: ResultsQuery
  filterActive: boolean
  onPick(patch: Partial<ResultsQuery>): void
}

interface State {
  report: TaskStatsReport | null
  loading: boolean
  error: string | null
}

export function OverviewTab({
  t,
  taskId,
  rev,
  filters,
  filterActive,
  onPick,
}: Props): ReactElement {
  const [state, setState] = useState<State>({ report: null, loading: true, error: null })
  const filterKey = JSON.stringify(filters)

  useEffect(() => {
    const controller = new AbortController()
    setState((previous) => ({ ...previous, loading: true, error: null }))
    fetchStats(
      taskId,
      filters,
      filterActive ? 'filtered' : 'task',
      controller.signal,
    )
      .then((report) => {
        if (!controller.signal.aborted) setState({ report, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({
          report: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return () => {
      controller.abort()
    }
  }, [taskId, rev, filterKey, filterActive])

  const report = state.report
  if (report === null) {
    return (
      <div style={TEXT_STYLE}>
        {state.loading ? t('overview.loading') : (state.error ?? t('overview.empty'))}
      </div>
    )
  }

  const { funnel, metrics } = report

  return (
    <div style={WRAP_STYLE}>
      {filterActive && <div style={TEXT_STYLE}>{t('overview.scoped')}</div>}

      <Section title={t('overview.funnel')}>
        <FunnelRow label={t('overview.raw')} value={funnel.rawHits} />
        <FunnelRow label={t('overview.deduped')} value={funnel.deduped} />
        <FunnelRow label={t('overview.filtered')} value={funnel.filtered} strong />
        <FunnelRow
          label={t('overview.screening')}
          value={`${tpl(t('overview.included'), { n: funnel.included })} · ${tpl(
            t('overview.excluded'),
            { n: funnel.excluded },
          )} · ${tpl(t('overview.unread'), { n: funnel.unread })}`}
        />
      </Section>

      <Section title={t('overview.metrics')}>
        <div style={METRIC_ROW_STYLE}>
          <Metric label={t('overview.oaRate')} value={percent(metrics.oaRate)} />
          <Metric label={t('overview.pdfRate')} value={percent(metrics.pdfRate)} />
          <Metric label={t('overview.medianCited')} value={String(metrics.medianCitations)} />
          {metrics.newVsBase !== undefined && (
            <Metric label={t('overview.newVsBase')} value={String(metrics.newVsBase)} />
          )}
        </div>
      </Section>

      <Section title={t('overview.fulltext')}>
        <div style={CHIP_ROW_STYLE}>
          {FULLTEXT_STATUSES.map((entry) => (
            <span key={entry.key} style={CHIP_STYLE}>
              {t(`pdf.status.${entry.status}`)} {report.fullText[entry.key]}
            </span>
          ))}
        </div>
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            style={CHIP_BUTTON_STYLE}
            onClick={() => onPick({ missingFullText: true })}
          >
            {t('overview.missingFullText')}
          </button>
        </div>
      </Section>

      <Section title={t('overview.years')}>
        <YearBars years={report.byYear} />
      </Section>

      <Section title={t('overview.sources')}>
        {report.bySource.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            t={t}
            onClick={() => onPick({ source: source.id })}
          />
        ))}
      </Section>

      {report.byQuery.length > 1 && (
        <Section title={t('overview.queries')}>
          {report.byQuery.map((query) => (
            <button
              key={query.queryId}
              type="button"
              style={ROW_BUTTON_STYLE}
              title={t('overview.clickToFilter')}
              onClick={() => onPick({ queryId: query.queryId })}
            >
              <span style={ROW_NAME_STYLE}>{query.name}</span>
              <span style={ROW_VALUE_STYLE}>
                {tpl(t('overview.hitsUnique'), { hits: query.hits, unique: query.uniqueOnly })}
              </span>
            </button>
          ))}
        </Section>
      )}

      {report.byType.length > 0 && (
        <Section title={t('overview.types')}>
          <div style={CHIP_ROW_STYLE}>
            {report.byType.slice(0, 10).map((entry) => (
              <button
                key={entry.key}
                type="button"
                style={CHIP_BUTTON_STYLE}
                title={t('overview.clickToFilter')}
                onClick={() => onPick({ type: entry.key })}
              >
                {entry.key} {entry.count}
              </button>
            ))}
          </div>
        </Section>
      )}

      {report.byLanguage.length > 0 && (
        <Section title={t('overview.languages')}>
          <div style={CHIP_ROW_STYLE}>
            {report.byLanguage.slice(0, 8).map((entry) => {
              const language = languageFilter(entry.key)
              return (
                <button
                  key={entry.key}
                  type="button"
                  style={CHIP_BUTTON_STYLE}
                  title={language === undefined ? entry.key : t('overview.clickToFilter')}
                  disabled={language === undefined}
                  onClick={() => {
                    if (language !== undefined) onPick({ language })
                  }}
                >
                  {entry.key} {entry.count}
                </button>
              )
            })}
          </div>
        </Section>
      )}

      {report.topVenues.length > 0 && (
        <Section title={t('overview.venues')}>
          {report.topVenues.slice(0, 8).map((entry) => (
            <button
              key={entry.key}
              type="button"
              style={ROW_BUTTON_STYLE}
              title={t('overview.clickToFilter')}
              onClick={() => onPick({ venue: entry.key })}
            >
              <span style={ROW_NAME_STYLE}>{entry.key}</span>
              <span style={ROW_VALUE_STYLE}>{entry.count}</span>
            </button>
          ))}
        </Section>
      )}

      {report.topAuthors.length > 0 && (
        <Section title={t('overview.authors')}>
          {report.topAuthors.slice(0, 10).map((entry) => (
            <button
              key={entry.key}
              type="button"
              style={ROW_BUTTON_STYLE}
              title={t('overview.clickToFilter')}
              onClick={() => onPick({ author: entry.key })}
            >
              <span style={ROW_NAME_STYLE}>{entry.key}</span>
              <span style={ROW_VALUE_STYLE}>{entry.count}</span>
            </button>
          ))}
        </Section>
      )}
    </div>
  )
}

function languageFilter(key: string): 'eng' | 'chi' | undefined {
  const value = key.toLowerCase()
  if (value.startsWith('eng') || value.startsWith('en')) return 'eng'
  if (value.startsWith('chi') || value.startsWith('zh')) return 'chi'
  return undefined
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section style={SECTION_STYLE}>
      <h4 style={SECTION_HEAD_STYLE}>{title}</h4>
      {children}
    </section>
  )
}

function FunnelRow({
  label,
  value,
  strong = false,
}: {
  label: string
  value: number | string
  strong?: boolean
}): ReactElement {
  return (
    <div style={FUNNEL_ROW_STYLE}>
      <span style={{ ...TEXT_STYLE, opacity: 0.72 }}>{label}</span>
      <span style={strong ? FUNNEL_STRONG_STYLE : TEXT_STYLE}>{value}</span>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div style={METRIC_STYLE}>
      <div style={METRIC_VALUE_STYLE}>{value}</div>
      <div style={TEXT_STYLE}>{label}</div>
    </div>
  )
}

function YearBars({ years }: { years: YearStat[] }): ReactElement {
  if (years.length === 0) return <div style={TEXT_STYLE}>—</div>
  const shown = years.slice(-YEAR_BARS)
  const max = Math.max(...shown.map((entry) => entry.count), 1)
  return (
    <div style={BARS_STYLE}>
      {shown.map((entry) => (
        <div key={entry.year} style={BAR_ITEM_STYLE} title={`${entry.year}: ${entry.count}`}>
          <div
            style={{
              ...BAR_STYLE,
              height: Math.max(2, Math.round((entry.count / max) * 46)),
            }}
          />
          <span style={BAR_LABEL_STYLE}>{String(entry.year).slice(2)}</span>
        </div>
      ))}
    </div>
  )
}

function SourceRow({
  source,
  t,
  onClick,
}: {
  source: SourceStat
  t: Translate
  onClick(): void
}): ReactElement {
  return (
    <button
      type="button"
      style={ROW_BUTTON_STYLE}
      title={t('overview.clickToFilter')}
      onClick={onClick}
    >
      <span style={ROW_NAME_STYLE}>{t(`source.${source.id}`)}</span>
      <span style={ROW_VALUE_STYLE}>
        {tpl(t('overview.sourceStats'), {
          hits: source.hits,
          unique: source.uniqueOnly,
          oa: source.oa,
          pdf: source.withPdf,
        })}
      </span>
    </button>
  )
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

const WRAP_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
const SECTION_STYLE: CSSProperties = { padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,0.12)' }
const SECTION_HEAD_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  opacity: 0.72,
  margin: '0 0 4px',
}
const TEXT_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5 }
const FUNNEL_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 12,
  padding: '1px 0',
}
const FUNNEL_STRONG_STYLE: CSSProperties = { fontSize: 13, fontWeight: 600 }
const METRIC_ROW_STYLE: CSSProperties = { display: 'flex', gap: 16 }
const METRIC_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1 }
const METRIC_VALUE_STYLE: CSSProperties = { fontSize: 15, fontWeight: 600 }
const BARS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 3,
  height: 62,
  overflow: 'hidden',
}
const BAR_ITEM_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flex: '1 1 0',
  minWidth: 0,
  height: '100%',
  gap: 2,
}
const BAR_STYLE: CSSProperties = {
  width: '100%',
  maxWidth: 18,
  borderRadius: 2,
  background: 'rgba(80,140,255,0.55)',
}
const BAR_LABEL_STYLE: CSSProperties = { fontSize: 9, opacity: 0.6 }
const ROW_BUTTON_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  width: '100%',
  padding: '2px 0',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  textAlign: 'left',
  cursor: 'pointer',
}
const ROW_NAME_STYLE: CSSProperties = { fontWeight: 600 }
const ROW_VALUE_STYLE: CSSProperties = { opacity: 0.72, fontSize: 11 }
const CHIP_ROW_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 }
const CHIP_STYLE: CSSProperties = {
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
}
const CHIP_BUTTON_STYLE: CSSProperties = {
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid rgba(80,140,255,0.4)',
  background: 'transparent',
  color: '#508cff',
  cursor: 'pointer',
}
