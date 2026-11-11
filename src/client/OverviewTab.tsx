/**
 * 任务「概览」tab：漏斗、年份、来源、检索式贡献与指标。
 *
 * 统计口径由 Host 的 `/stats` 计算，与结果列表共用同一套筛选；点击图形 /
 * 表格中的条目会直接落到「结果」tab 的对应筛选上（由父组件切换 tab）。
 * 展示层约定：能画比例的一律画条，多指标的用「条 + 数字列」紧凑表，
 * 纯量指标用带色小卡；标签列定宽，避免左标签与右数值两端拉开的空白。
 */

import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'

import type { YearStat, TaskStatsReport } from '../search/types'
import { fetchStats, type ResultsQuery } from './api'
import { tpl, type Translate } from './locales'
import { ACCENT } from './styles'

const YEAR_BARS = 14

/** 概览配色：浅色 / 深色主题下都可读的中饱和色。 */
const C = {
  blue: ACCENT,
  teal: '#129c9c',
  violet: '#8a63e8',
  amber: '#e08a2e',
  green: '#2f9e68',
  rose: '#d2588a',
  slate: '#8793a8',
} as const

/** 全文状态与台账同一口径，颜色同时用于堆叠条和图例。 */
const FULLTEXT_STATUSES = [
  { status: 'unknown', key: 'unknown', color: '#98a3b3' },
  { status: 'available', key: 'available', color: C.blue },
  { status: 'downloaded', key: 'downloaded', color: C.green },
  { status: 'html-only', key: 'htmlOnly', color: C.teal },
  { status: 'paywalled', key: 'paywalled', color: C.amber },
  { status: 'blocked', key: 'blocked', color: C.rose },
  { status: 'failed', key: 'failed', color: '#d64545' },
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

/** 条形表的一行：value 决定条长与主数值，cells 是右侧紧凑数字列。 */
interface BarItem {
  key: string
  label: string
  value: number
  cells?: number[]
  onClick?: () => void
  title?: string
}

/** 堆叠条的一段：状态 / 三态分布，可单独点击筛选。 */
interface Segment {
  key: string
  label: string
  value: number
  color: string
  onClick?: () => void
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
  const clickHint = t('overview.clickToFilter')

  const funnelItems: BarItem[] = [
    { key: 'raw', label: t('overview.raw'), value: funnel.rawHits },
    { key: 'deduped', label: t('overview.deduped'), value: funnel.deduped },
    { key: 'filtered', label: t('overview.filtered'), value: funnel.filtered },
  ]
  const screeningSegments: Segment[] = [
    {
      key: 'included',
      label: t('overview.state.included'),
      value: funnel.included,
      color: C.green,
      onClick: () => onPick({ screening: 'included' }),
    },
    {
      key: 'excluded',
      label: t('overview.state.excluded'),
      value: funnel.excluded,
      color: C.rose,
      onClick: () => onPick({ screening: 'excluded' }),
    },
    {
      key: 'unread',
      label: t('overview.state.unread'),
      value: funnel.unread,
      color: C.slate,
      onClick: () => onPick({ screening: 'unread' }),
    },
  ]

  const fullTextSegments: Segment[] = FULLTEXT_STATUSES.map((entry) => ({
    key: entry.status,
    label: t(`pdf.status.${entry.status}`),
    value: report.fullText[entry.key],
    color: entry.color,
    // 「只看缺全文」与精确状态互斥，点状态时要清掉前者，否则两个条件相与后可能为空。
    onClick: () => onPick({ pdfStatus: entry.status, missingFullText: undefined }),
  }))

  const sourceItems: BarItem[] = report.bySource.map((source) => ({
    key: source.id,
    label: t(`source.${source.id}`),
    value: source.hits,
    cells: [source.uniqueOnly, source.oa, source.withPdf],
    title: tpl(t('overview.sourceStats'), {
      hits: source.hits,
      unique: source.uniqueOnly,
      oa: source.oa,
      pdf: source.withPdf,
    }),
    onClick: () => onPick({ source: source.id }),
  }))

  const queryItems: BarItem[] = report.byQuery.map((query) => ({
    key: query.queryId,
    label: query.name,
    value: query.hits,
    cells: [query.uniqueOnly],
    title: tpl(t('overview.hitsUnique'), { hits: query.hits, unique: query.uniqueOnly }),
    onClick: () => onPick({ queryId: query.queryId }),
  }))

  const typeItems: BarItem[] = report.byType.slice(0, 10).map((entry) => ({
    key: entry.key,
    label: entry.key,
    value: entry.count,
    onClick: () => onPick({ type: entry.key }),
  }))

  const languageItems: BarItem[] = report.byLanguage.slice(0, 8).map((entry) => {
    const language = languageFilter(entry.key)
    return {
      key: entry.key,
      label: entry.key,
      value: entry.count,
      onClick: language === undefined ? undefined : () => onPick({ language }),
    }
  })

  const venueItems: BarItem[] = report.topVenues.slice(0, 8).map((entry) => ({
    key: entry.key,
    label: entry.key,
    value: entry.count,
    onClick: () => onPick({ venue: entry.key }),
  }))

  const authorItems: BarItem[] = report.topAuthors.slice(0, 10).map((entry) => ({
    key: entry.key,
    label: entry.key,
    value: entry.count,
    onClick: () => onPick({ author: entry.key }),
  }))

  return (
    <div style={WRAP_STYLE}>
      {filterActive && <div style={SCOPED_STYLE}>{t('overview.scoped')}</div>}

      <Section title={t('overview.funnel')} color={C.blue}>
        <BarList items={funnelItems} color={C.blue} max={funnel.rawHits} t={t} />
        <SegmentChart
          segments={screeningSegments}
          label={t('overview.screening')}
          hint={clickHint}
          showTotal
        />
      </Section>

      <Section title={t('overview.metrics')} color={C.violet}>
        <div style={METRIC_GRID_STYLE}>
          <MetricCard label={t('overview.oaRate')} value={percent(metrics.oaRate)} color={C.teal} ratio={metrics.oaRate} />
          <MetricCard label={t('overview.pdfRate')} value={percent(metrics.pdfRate)} color={C.blue} ratio={metrics.pdfRate} />
          <MetricCard label={t('overview.medianCited')} value={String(metrics.medianCitations)} color={C.violet} />
          {metrics.newVsBase !== undefined && (
            <MetricCard label={t('overview.newVsBase')} value={String(metrics.newVsBase)} color={C.amber} />
          )}
        </div>
      </Section>

      <Section title={t('overview.fulltext')} color={C.teal}>
        <SegmentChart segments={fullTextSegments} hint={clickHint} />
        <button
          type="button"
          style={{ ...QUICK_FILTER_STYLE, marginTop: 5 }}
          onClick={() => onPick({ missingFullText: true, pdfStatus: undefined })}
        >
          {t('overview.missingFullText')}
        </button>
      </Section>

      <Section title={t('overview.years')} color={C.blue}>
        <YearBars years={report.byYear} hint={clickHint} onPick={onPick} />
      </Section>

      <Section title={t('overview.sources')} color={C.teal}>
        <BarList
          items={sourceItems}
          color={C.teal}
          columns={[t('overview.col.unique'), t('overview.col.oa'), t('overview.col.pdf')]}
          t={t}
        />
      </Section>

      {report.byQuery.length > 1 && (
        <Section title={t('overview.queries')} color={C.violet}>
          <BarList
            items={queryItems}
            color={C.violet}
            columns={[t('overview.col.unique')]}
            t={t}
          />
        </Section>
      )}

      {typeItems.length > 0 && (
        <Section title={t('overview.types')} color={C.amber}>
          <BarList items={typeItems} color={C.amber} t={t} />
        </Section>
      )}

      {languageItems.length > 0 && (
        <Section title={t('overview.languages')} color={C.green}>
          <BarList items={languageItems} color={C.green} t={t} />
        </Section>
      )}

      {venueItems.length > 0 && (
        <Section title={t('overview.venues')} color={C.rose}>
          <BarList items={venueItems} color={C.rose} t={t} />
        </Section>
      )}

      {authorItems.length > 0 && (
        <Section title={t('overview.authors')} color={C.slate}>
          <BarList items={authorItems} color={C.slate} t={t} />
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

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** #rrggbb → rgba(..., alpha)，用于淡色卡片 / 轨道底。 */
function tint(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`
}

function Section({
  title,
  color,
  children,
}: {
  title: string
  color: string
  children: ReactNode
}): ReactElement {
  return (
    <section style={SECTION_STYLE}>
      <h4 style={SECTION_HEAD_STYLE}>
        <span style={{ ...SECTION_MARK_STYLE, background: color }} />
        {title}
      </h4>
      {children}
    </section>
  )
}

/** 条形表：标签定宽 + 比例条 + 数值列，多指标时补右侧紧凑数字列。 */
function BarList({
  items,
  color,
  t,
  columns = [],
  max,
}: {
  items: BarItem[]
  color: string
  t: Translate
  columns?: string[]
  max?: number
}): ReactElement {
  if (items.length === 0) return <div style={TEXT_STYLE}>—</div>
  const peak = Math.max(max ?? 0, ...items.map((item) => item.value), 1)
  return (
    <div>
      {columns.length > 0 && (
        <div style={TABLE_HEAD_STYLE}>
          <span style={NAME_STYLE}>{t('overview.col.name')}</span>
          <span style={HEAD_TRACK_STYLE}>{t('overview.col.hits')}</span>
          <span style={HEAD_NUM_STYLE} />
          {columns.map((column) => (
            <span key={column} style={HEAD_NUM_STYLE}>
              {column}
            </span>
          ))}
        </div>
      )}
      {items.map((item) => {
        const ratio = Math.max(0, Math.min(1, item.value / peak))
        const content = (
          <>
            <span style={NAME_STYLE} title={item.label}>
              {item.label}
            </span>
            <span style={TRACK_STYLE}>
              <span
                style={{
                  ...BAR_FILL_STYLE,
                  width: `${ratio * 100}%`,
                  background: color,
                  opacity: 0.55 + 0.45 * ratio,
                }}
              />
            </span>
            <span style={{ ...NUM_STYLE, color }}>{item.value}</span>
            {(item.cells ?? []).map((cell, index) => (
              <span key={index} style={NUM_STYLE}>
                {cell}
              </span>
            ))}
          </>
        )
        const detail = item.title ?? `${item.label}: ${item.value}`
        const title = item.onClick === undefined ? detail : `${detail} · ${t('overview.clickToFilter')}`
        return item.onClick === undefined ? (
          <div key={item.key} style={{ ...ROW_STYLE, cursor: 'default', opacity: 0.72 }} title={detail}>
            {content}
          </div>
        ) : (
          <button key={item.key} type="button" style={ROW_STYLE} title={title} onClick={item.onClick}>
            {content}
          </button>
        )
      })}
    </div>
  )
}

/** 堆叠条 + 带色点的紧凑图例（表格化的数据区），每段都可点击筛选。 */
function SegmentChart({
  segments,
  hint,
  label,
  showTotal = false,
}: {
  segments: Segment[]
  hint: string
  label?: string
  showTotal?: boolean
}): ReactElement {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  return (
    <div style={{ marginTop: 4 }}>
      <div style={ROW_STYLE}>
        {label !== undefined && <span style={NAME_STYLE}>{label}</span>}
        <span style={STACK_TRACK_STYLE}>
          {segments
            .filter((segment) => segment.value > 0)
            .map((segment) => {
              const width = `${(segment.value / Math.max(1, total)) * 100}%`
              const title = `${segment.label} ${segment.value} · ${hint}`
              const segmentStyle: CSSProperties = {
                ...SEGMENT_STYLE,
                width,
                background: segment.color,
              }
              return segment.onClick === undefined ? (
                <span key={segment.key} style={segmentStyle} title={title} />
              ) : (
                <button
                  key={segment.key}
                  type="button"
                  style={segmentStyle}
                  title={title}
                  onClick={segment.onClick}
                />
              )
            })}
        </span>
        {showTotal && <span style={NUM_STYLE}>{total}</span>}
      </div>
      <div style={LEGEND_GRID_STYLE}>
        {segments.map((segment) => {
          const content = (
            <>
              <span style={{ ...LEGEND_DOT_STYLE, background: segment.color }} />
              <span style={LEGEND_LABEL_STYLE}>{segment.label}</span>
              <b style={{ ...LEGEND_VALUE_STYLE, color: segment.color }}>{segment.value}</b>
            </>
          )
          return segment.onClick === undefined ? (
            <span key={segment.key} style={{ ...LEGEND_ITEM_STYLE, cursor: 'default' }}>
              {content}
            </span>
          ) : (
            <button
              key={segment.key}
              type="button"
              style={LEGEND_ITEM_STYLE}
              title={`${segment.label} ${segment.value} · ${hint}`}
              onClick={segment.onClick}
            >
              {content}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 纯量指标用带色小卡：百分比额外补一条迷你进度条。 */
function MetricCard({
  label,
  value,
  color,
  ratio,
}: {
  label: string
  value: string
  color: string
  ratio?: number
}): ReactElement {
  return (
    <div style={{ ...METRIC_CARD_STYLE, borderColor: tint(color, 0.35), background: tint(color, 0.07) }}>
      <div style={METRIC_LABEL_STYLE}>{label}</div>
      <div style={{ ...METRIC_VALUE_STYLE, color }}>{value}</div>
      {ratio !== undefined && (
        <div style={MINI_TRACK_STYLE}>
          <span
            style={{
              ...BAR_FILL_STYLE,
              width: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
              background: color,
            }}
          />
        </div>
      )}
    </div>
  )
}

/** 年份柱形图：横轴显示完整 4 位年份，点击柱子筛选该年份。 */
function YearBars({
  years,
  hint,
  onPick,
}: {
  years: YearStat[]
  hint: string
  onPick(patch: Partial<ResultsQuery>): void
}): ReactElement {
  if (years.length === 0) return <div style={TEXT_STYLE}>—</div>
  const shown = years.slice(-YEAR_BARS)
  const max = Math.max(...shown.map((entry) => entry.count), 1)
  return (
    <div style={BARS_STYLE}>
      {shown.map((entry) => {
        const ratio = entry.count / max
        return (
          <button
            key={entry.year}
            type="button"
            style={BAR_ITEM_STYLE}
            title={`${entry.year} · ${entry.count} · ${hint}`}
            onClick={() => onPick({ yearFrom: entry.year, yearTo: entry.year })}
          >
            <span style={BAR_AREA_STYLE}>
              <span
                style={{
                  ...BAR_STYLE,
                  height: Math.max(2, Math.round(ratio * 46)),
                  opacity: 0.55 + 0.45 * ratio,
                }}
              />
            </span>
            <span style={BAR_LABEL_STYLE}>{entry.year}</span>
          </button>
        )
      })}
    </div>
  )
}

const WRAP_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const SCOPED_STYLE: CSSProperties = {
  fontSize: 11,
  color: C.violet,
  background: tint(C.violet, 0.08),
  borderRadius: 4,
  padding: '2px 6px',
  marginBottom: 2,
}
const SECTION_STYLE: CSSProperties = {
  padding: '5px 0',
  borderBottom: '1px solid rgba(127,127,127,0.12)',
}
const SECTION_HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 12,
  fontWeight: 600,
  opacity: 0.82,
  margin: '0 0 4px',
}
const SECTION_MARK_STYLE: CSSProperties = {
  width: 3,
  height: 11,
  borderRadius: 2,
  flex: '0 0 3px',
}
const TEXT_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5 }

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '2px 0',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 11,
  lineHeight: 1.35,
  textAlign: 'left',
  cursor: 'pointer',
}
const NAME_STYLE: CSSProperties = {
  flex: '0 0 88px',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 600,
}
const TRACK_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 20,
  height: 8,
  borderRadius: 4,
  background: 'rgba(127,127,127,0.14)',
  overflow: 'hidden',
}
const BAR_FILL_STYLE: CSSProperties = { display: 'block', height: '100%', borderRadius: 4 }
const NUM_STYLE: CSSProperties = {
  flex: '0 0 30px',
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 600,
}
const TABLE_HEAD_STYLE: CSSProperties = {
  ...ROW_STYLE,
  padding: '0 0 2px',
  fontSize: 10,
  opacity: 0.62,
  cursor: 'default',
}
const HEAD_TRACK_STYLE: CSSProperties = { flex: '1 1 auto', minWidth: 20 }
const HEAD_NUM_STYLE: CSSProperties = { flex: '0 0 30px', textAlign: 'right' }

const STACK_TRACK_STYLE: CSSProperties = {
  ...TRACK_STYLE,
  height: 10,
  display: 'flex',
  gap: 1,
  background: 'rgba(127,127,127,0.10)',
}
const SEGMENT_STYLE: CSSProperties = {
  height: '100%',
  minWidth: 2,
  border: 'none',
  padding: 0,
  borderRadius: 2,
  cursor: 'pointer',
}
const LEGEND_GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '1px 10px',
  marginTop: 4,
}
const LEGEND_ITEM_STYLE: CSSProperties = {
  ...ROW_STYLE,
  gap: 4,
  padding: '1px 0',
  fontSize: 10.5,
  minWidth: 0,
}
const LEGEND_DOT_STYLE: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 2,
  flex: '0 0 6px',
}
const LEGEND_LABEL_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  opacity: 0.78,
}
const LEGEND_VALUE_STYLE: CSSProperties = { flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }

const METRIC_GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 5,
}
const METRIC_CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  padding: '5px 7px',
  border: '1px solid',
  borderRadius: 5,
}
const METRIC_LABEL_STYLE: CSSProperties = { fontSize: 10, opacity: 0.72 }
const METRIC_VALUE_STYLE: CSSProperties = { fontSize: 16, fontWeight: 600, lineHeight: 1.3 }
const MINI_TRACK_STYLE: CSSProperties = {
  height: 3,
  borderRadius: 2,
  background: 'rgba(127,127,127,0.14)',
  overflow: 'hidden',
  marginTop: 2,
}

const QUICK_FILTER_STYLE: CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 10,
  border: `1px solid ${tint(C.teal, 0.5)}`,
  background: tint(C.teal, 0.08),
  color: C.teal,
  cursor: 'pointer',
}

const BARS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 2,
  height: 66,
  overflow: 'visible',
}
const BAR_ITEM_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flex: '1 1 0',
  minWidth: 0,
  height: '100%',
  gap: 3,
  padding: '2px 0 0',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}
const BAR_AREA_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  width: '100%',
  height: 48,
}
const BAR_STYLE: CSSProperties = {
  width: '100%',
  maxWidth: 20,
  borderRadius: '2px 2px 0 0',
  background: C.blue,
}
const BAR_LABEL_STYLE: CSSProperties = {
  width: '100%',
  textAlign: 'center',
  fontSize: 8.5,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  letterSpacing: '-0.2px',
  fontVariantNumeric: 'tabular-nums',
  opacity: 0.72,
}
