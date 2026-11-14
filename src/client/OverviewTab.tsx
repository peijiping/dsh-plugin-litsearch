/**
 * 任务「概览」tab：一眼看清本轮检索发生了什么。
 *
 * 统计口径由 Host 的 `/stats` 计算，与结果列表共用同一套筛选；点击图形 / 表格
 * 中的条目会直接落到「结果」tab 的对应筛选上（由父组件切换 tab）。
 *
 * 图形按「要回答的问题」分工，不把一切都画成横条：
 * - 一句概况 + 漏斗比例条 + 变化量：命中多少、流失多少（流程）
 * - 指标环形进度：比率离 100% 还有多远（完成度）
 * - 全文覆盖 / 文献类型 环形图：部分与整体（构成，类别多）
 * - 人工筛选 / 语言 100% 堆叠条：类别少时的构成对比
 * - 年份 面积折线：随时间的走势（趋势）
 * - 来源 / 检索式 双色条（独有 vs 共享）+ 数字列：贡献与重叠（比较）
 * - 高频出处 / 作者 纯文字排名：谁最多（排序，条形无信息增量）
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'

import type { CountEntry, TaskStatsReport, YearStat } from '../search/types'
import { fetchStats, type ResultsQuery } from './api'
import { tpl, type Translate } from './locales'
import { ACCENT } from './styles'

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

/** 环形图 / 堆叠条的取色顺序。 */
const PALETTE = [C.blue, C.teal, C.violet, C.amber, C.green, C.rose, C.slate] as const

/** 全文状态与台账同一口径，颜色同时用于环形图和图例。 */
const FULLTEXT_STATUSES = [
  { status: 'available', key: 'available', color: C.blue },
  { status: 'downloaded', key: 'downloaded', color: C.green },
  { status: 'missing', key: 'missing', color: '#d97706' },
  { status: 'html-only', key: 'htmlOnly', color: C.teal },
  { status: 'paywalled', key: 'paywalled', color: C.amber },
  { status: 'blocked', key: 'blocked', color: C.rose },
  { status: 'failed', key: 'failed', color: '#d64545' },
  { status: 'unknown', key: 'unknown', color: C.slate },
] as const

const DONUT_SIZE = 86
const DONUT_THICKNESS = 10
const RING_SIZE = 58
const RING_THICKNESS = 6
const TREND_HEIGHT = 96

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

/** 堆叠条 / 环形图的一段：可单独点击落到筛选。 */
interface Segment {
  key: string
  label: string
  value: number
  color: string
  onClick?: () => void
}

/** 双色条右侧的数字列。 */
interface Cell {
  text: string
  muted?: boolean
}

/** 双色条的一行：total 决定条长，unique 是前段（独有）长度。 */
interface ShareItem {
  key: string
  label: string
  total: number
  unique: number
  cells: Cell[]
  title: string
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
    fetchStats(taskId, filters, filterActive ? 'filtered' : 'task', controller.signal)
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
  const sectionHint = t('overview.tapHint')
  const retention = ratioOf(funnel.deduped, funnel.rawHits)
  const fullTextTotal = sum(Object.values(report.fullText))
  const accessible =
    report.fullText.available + report.fullText.downloaded + report.fullText.htmlOnly
  const screeningTotal = funnel.included + funnel.excluded + funnel.unread

  /* ---- 漏斗：三段比例条 + 变化量 ---- */
  const funnelStages = [
    { key: 'raw', label: t('overview.raw'), value: funnel.rawHits, drop: 0 },
    {
      key: 'deduped',
      label: t('overview.deduped'),
      value: funnel.deduped,
      drop: funnel.rawHits - funnel.deduped,
    },
    {
      key: 'filtered',
      label: t('overview.filtered'),
      value: funnel.filtered,
      drop: funnel.deduped - funnel.filtered,
    },
  ]

  /* ---- 人工筛选：类别少，用 100% 堆叠条 ---- */
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

  /* ---- 全文覆盖：构成，用环形图，零值状态不占位 ---- */
  const fullTextSegments: Segment[] = FULLTEXT_STATUSES.filter(
    (entry) => report.fullText[entry.key] > 0,
  ).map((entry) => ({
    key: entry.status,
    label: t(`pdf.status.${entry.status}`),
    value: report.fullText[entry.key],
    color: entry.color,
    // 「只看缺全文」与精确状态互斥，点状态时要清掉前者，否则两个条件相与后可能为空。
    onClick: () => onPick({ pdfStatus: entry.status, missingFullText: undefined }),
  }))

  /* ---- 来源：命中数比较 + 独有占比（重叠来源不可相加，故用双色条） ---- */
  const sourceItems: ShareItem[] = [...report.bySource]
    .filter((source) => source.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((source) => ({
      key: source.id,
      label: t(`source.${source.id}`),
      total: source.hits,
      unique: source.uniqueOnly,
      cells: [
        { text: String(source.hits) },
        { text: String(source.uniqueOnly), muted: true },
        { text: String(source.oa), muted: true },
        { text: String(source.withPdf), muted: true },
      ],
      title: tpl(t('overview.sourceStats'), {
        hits: source.hits,
        unique: source.uniqueOnly,
        oa: source.oa,
        pdf: source.withPdf,
      }),
      onClick: () => onPick({ source: source.id }),
    }))

  const queryItems: ShareItem[] = [...report.byQuery]
    .sort((a, b) => b.hits - a.hits)
    .map((query) => ({
      key: query.queryId,
      label: query.name,
      total: query.hits,
      unique: query.uniqueOnly,
      cells: [
        { text: String(query.hits) },
        { text: String(query.uniqueOnly), muted: true },
        { text: `${Math.round(ratioOf(query.uniqueOnly, query.hits) * 100)}%`, muted: true },
      ],
      title: tpl(t('overview.hitsUnique'), { hits: query.hits, unique: query.uniqueOnly }),
      onClick: () => onPick({ queryId: query.queryId }),
    }))

  /* ---- 文献类型：部分与整体，用环形图（长尾折叠成「其他」） ---- */
  const typeSegments = foldLongTail(
    report.byType.map((entry, index) => ({
      key: entry.key,
      label: entry.key,
      value: entry.count,
      color: PALETTE[index % PALETTE.length],
      onClick: () => onPick({ type: entry.key }),
    })),
    5,
    t('overview.other'),
    C.slate,
  )
  // 上游未给 type 的篇目不计入环形图（会把有意义的构成压成细弧），只用脚注说明差额。
  const untyped = report.loaded - sum(report.byType.map((entry) => entry.count))

  /* ---- 语言：几乎总是二元，用 100% 堆叠条 + 行内百分比 ---- */
  const languageSegments = foldLongTail(
    report.byLanguage.slice(0, 4).map((entry, index) => ({
      key: entry.key,
      label: languageLabel(entry.key, t),
      value: entry.count,
      color: PALETTE[index % PALETTE.length],
      onClick: pickLanguage(entry.key, onPick),
    })),
    3,
    t('overview.other'),
    C.slate,
  )

  return (
    <div style={WRAP_STYLE}>
      {filterActive && <div style={SCOPED_STYLE}>{t('overview.scoped')}</div>}

      <p style={SUMMARY_STYLE}>
        {tpl(t('overview.summary'), {
          sources: report.bySource.length,
          raw: funnel.rawHits,
          deduped: funnel.deduped,
          fulltext: Math.round(ratioOf(accessible, fullTextTotal) * 100),
          included: funnel.included,
          unread: funnel.unread,
        })}
      </p>

      <Section title={t('overview.funnel')} color={C.blue} hint={sectionHint}>
        <FunnelStages stages={funnelStages} />
        <p style={CAPTION_STYLE}>
          {tpl(t('overview.funnelKeep'), {
            raw: funnel.rawHits,
            kept: funnel.deduped,
            p: Math.round(retention * 100),
          })}
        </p>
        <SubHead label={t('overview.screening')} total={screeningTotal} t={t} />
        <ShareBar segments={screeningSegments} total={screeningTotal} hint={clickHint} />
      </Section>

      <Section title={t('overview.metrics')} color={C.violet}>
        <div style={METRIC_ROW_STYLE}>
          <RingGauge
            ratio={metrics.oaRate}
            color={C.teal}
            label={t('overview.oaRate')}
            hint={t('overview.rateHint')}
          />
          <RingGauge
            ratio={metrics.pdfRate}
            color={C.blue}
            label={t('overview.pdfRate')}
            hint={t('overview.rateHint')}
          />
          <div style={METRIC_DIVIDER_STYLE} />
          <div style={METRIC_FACTS_STYLE}>
            <Kpi label={t('overview.medianCited')} value={String(metrics.medianCitations)} color={C.violet} />
            {metrics.newVsBase !== undefined && (
              <Kpi
                label={t('overview.newVsBase')}
                value={`+${metrics.newVsBase}`}
                color={C.amber}
              />
            )}
          </div>
        </div>
      </Section>

      <Section title={t('overview.fulltext')} color={C.teal} hint={sectionHint}>
        {fullTextSegments.length === 0 ? (
          <div style={TEXT_STYLE}>—</div>
        ) : (
          <DonutPanel
            segments={fullTextSegments}
            total={fullTextTotal}
            center={`${Math.round(ratioOf(accessible, fullTextTotal) * 100)}%`}
            centerHint={t('overview.accessible')}
            hint={clickHint}
            t={t}
          />
        )}
        <button
          type="button"
          style={{ ...QUICK_FILTER_STYLE, marginTop: 6 }}
          onClick={() => onPick({ missingFullText: true, pdfStatus: undefined })}
        >
          {t('overview.missingFullText')}
        </button>
      </Section>

      <Section title={t('overview.years')} color={C.blue} hint={sectionHint}>
        <TrendChart years={report.byYear} hint={clickHint} t={t} onPick={onPick} />
      </Section>

      <Section title={t('overview.sources')} color={C.teal} hint={sectionHint}>
        {sourceItems.length === 0 ? (
          <div style={TEXT_STYLE}>—</div>
        ) : (
          <ShareBarList
            items={sourceItems}
            color={C.teal}
            columns={[
              { key: 'hits', label: t('overview.col.hits') },
              { key: 'unique', label: t('overview.col.unique') },
              { key: 'oa', label: t('overview.col.oa') },
              { key: 'pdf', label: t('overview.col.pdf') },
            ]}
            t={t}
          />
        )}
      </Section>

      {report.byQuery.length > 1 && (
        <Section title={t('overview.queries')} color={C.violet} hint={sectionHint}>
          <ShareBarList
            items={queryItems}
            color={C.violet}
            columns={[
              { key: 'hits', label: t('overview.col.hits') },
              { key: 'unique', label: t('overview.col.unique') },
              { key: 'share', label: t('overview.col.uniqueShare') },
            ]}
            t={t}
          />
        </Section>
      )}

      {typeSegments.length > 0 && (
        <Section title={t('overview.types')} color={C.amber} hint={sectionHint}>
          <DonutPanel
            segments={typeSegments}
            total={sum(typeSegments.map((segment) => segment.value))}
            center={String(sum(typeSegments.map((segment) => segment.value)))}
            centerHint={t('overview.col.total')}
            hint={clickHint}
            t={t}
          />
          {untyped > 0 && (
            <p style={CAPTION_STYLE}>{tpl(t('overview.untaggedNote'), { n: untyped })}</p>
          )}
        </Section>
      )}

      {languageSegments.length > 0 && (
        <Section title={t('overview.languages')} color={C.green} hint={sectionHint}>
          <ShareBar
            segments={languageSegments}
            total={sum(languageSegments.map((segment) => segment.value))}
            hint={clickHint}
          />
        </Section>
      )}

      {report.topVenues.length > 0 && (
        <Section title={t('overview.venues')} color={C.rose} hint={sectionHint}>
          <RankList
            entries={report.topVenues.slice(0, 5)}
            color={C.rose}
            hint={clickHint}
            onPick={(key) => onPick({ venue: key })}
            columns={1}
          />
        </Section>
      )}

      {report.topAuthors.length > 0 && (
        <Section title={t('overview.authors')} color={C.slate} hint={sectionHint}>
          <RankList
            entries={report.topAuthors.slice(0, 6)}
            color={C.slate}
            hint={clickHint}
            onPick={(key) => onPick({ author: key })}
          />
        </Section>
      )}
    </div>
  )
}

/* ---- 小工具 ------------------------------------------------------------- */

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function ratioOf(part: number, whole: number): number {
  return whole <= 0 ? 0 : part / whole
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 语言字段多为 `eng` / `chi`，翻成可读名称；未知的原样显示。 */
function languageLabel(key: string, t: Translate): string {
  const value = key.toLowerCase()
  if (value.startsWith('eng') || value.startsWith('en')) return t('overview.lang.eng')
  if (value.startsWith('chi') || value.startsWith('zh')) return t('overview.lang.chi')
  return key
}

function pickLanguage(
  key: string,
  onPick: (patch: Partial<ResultsQuery>) => void,
): (() => void) | undefined {
  const value = key.toLowerCase()
  if (value.startsWith('eng') || value.startsWith('en')) return () => onPick({ language: 'eng' })
  if (value.startsWith('chi') || value.startsWith('zh')) return () => onPick({ language: 'chi' })
  return undefined
}

/**
 * 长尾折叠：保留前 keep 项，其余合并成「其他」。
 * 各项计数互斥（每篇只落一个桶），所以合并后总和不失真。
 */
function foldLongTail(
  segments: Segment[],
  keep: number,
  otherLabel: string,
  otherColor: string,
): Segment[] {
  if (segments.length <= keep + 1) return segments
  const head = segments.slice(0, keep)
  const tail = segments.slice(keep)
  const rest = sum(tail.map((segment) => segment.value))
  if (rest > 0) {
    head.push({ key: '__other', label: otherLabel, value: rest, color: otherColor })
  }
  return head
}

/** #rrggbb → rgba(..., alpha)，用于淡色底 / 轨道。 */
function tint(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`
}

/* ---- 版式块 ------------------------------------------------------------- */

function Section({
  title,
  color,
  hint,
  children,
}: {
  title: string
  color: string
  hint?: string
  children: ReactNode
}): ReactElement {
  return (
    <section style={SECTION_STYLE}>
      <h4 style={SECTION_HEAD_STYLE}>
        <span style={{ ...SECTION_MARK_STYLE, background: color }} />
        {title}
        {hint !== undefined && <span style={SECTION_HINT_STYLE}>{hint}</span>}
      </h4>
      {children}
    </section>
  )
}

function SubHead({
  label,
  total,
  t,
}: {
  label: string
  total: number
  t: Translate
}): ReactElement {
  return (
    <div style={SUB_HEAD_STYLE}>
      <span>{label}</span>
      <span style={SUB_TOTAL_STYLE}>{tpl(t('overview.totalPieces'), { n: total })}</span>
    </div>
  )
}

/** 漏斗：按比例画条，右侧标数值与相邻阶段的流失量。 */
function FunnelStages({
  stages,
}: {
  stages: ReadonlyArray<{ key: string; label: string; value: number; drop: number }>
}): ReactElement {
  const peak = Math.max(...stages.map((stage) => stage.value), 1)
  return (
    <div>
      {stages.map((stage, index) => (
        <div key={stage.key} style={ROW_STYLE}>
          <span style={NAME_STYLE}>{stage.label}</span>
          <span style={TRACK_STYLE}>
            <span
              style={{
                ...BAR_FILL_STYLE,
                width: `${ratioOf(stage.value, peak) * 100}%`,
                background: C.blue,
                opacity: 1 - index * 0.18,
              }}
            />
          </span>
          <span style={{ ...NUM_STYLE, color: C.blue }}>{stage.value}</span>
          <span style={DROP_STYLE} title={stage.drop > 0 ? `−${stage.drop}` : undefined}>
            {stage.drop > 0 ? `−${stage.drop}` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

/** 100% 堆叠条 + 图例（数值 + 占比）：类别少时看构成最直观。 */
function ShareBar({
  segments,
  total,
  hint,
}: {
  segments: Segment[]
  total: number
  hint: string
}): ReactElement {
  if (segments.length === 0 || total <= 0) return <div style={TEXT_STYLE}>—</div>
  return (
    <div>
      <div style={STACK_TRACK_STYLE}>
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment) => {
            const title = `${segment.label} ${segment.value} · ${Math.round(
              ratioOf(segment.value, total) * 100,
            )}% · ${hint}`
            const style: CSSProperties = {
              ...SEGMENT_STYLE,
              width: `${ratioOf(segment.value, total) * 100}%`,
              background: segment.color,
            }
            return segment.onClick === undefined ? (
              <span key={segment.key} style={style} title={title} />
            ) : (
              <button
                key={segment.key}
                type="button"
                style={style}
                title={title}
                onClick={segment.onClick}
              />
            )
          })}
      </div>
      <div style={LEGEND_GRID_STYLE}>
        {segments.map((segment) => (
          <LegendItem
            key={segment.key}
            color={segment.color}
            label={segment.label}
            value={segment.value}
            percent={Math.round(ratioOf(segment.value, total) * 100)}
            hint={hint}
            onClick={segment.onClick}
          />
        ))}
      </div>
    </div>
  )
}

/** 环形图 + 右侧图例：部分与整体的构成。 */
function DonutPanel({
  segments,
  total,
  center,
  centerHint,
  hint,
  t,
}: {
  segments: Segment[]
  total: number
  center: string
  centerHint: string
  hint: string
  t: Translate
}): ReactElement {
  return (
    <div style={DONUT_ROW_STYLE}>
      <Donut segments={segments} total={total} center={center} centerHint={centerHint} hint={hint} />
      <div style={DONUT_LEGEND_STYLE}>
        {segments.map((segment) => (
          <LegendItem
            key={segment.key}
            color={segment.color}
            label={segment.label}
            value={segment.value}
            percent={Math.round(ratioOf(segment.value, total) * 100)}
            hint={hint}
            onClick={segment.onClick}
            wide
          />
        ))}
        {segments.length === 0 && <div style={TEXT_STYLE}>{t('overview.empty')}</div>}
      </div>
    </div>
  )
}

function LegendItem({
  color,
  label,
  value,
  percent,
  hint,
  onClick,
  wide = false,
}: {
  color: string
  label: string
  value: number
  percent: number
  hint: string
  onClick?: () => void
  wide?: boolean
}): ReactElement {
  const content = (
    <>
      <span style={{ ...LEGEND_DOT_STYLE, background: color }} />
      <span style={LEGEND_LABEL_STYLE}>{label}</span>
      <b style={{ ...LEGEND_VALUE_STYLE, color }}>{value}</b>
      <span style={LEGEND_PCT_STYLE}>{percent}%</span>
    </>
  )
  // 计数为 0 的状态整体压暗，避免「0 / 0%」抢注意力。
  const base: CSSProperties = wide
    ? { ...LEGEND_ITEM_STYLE, ...LEGEND_WIDE_STYLE }
    : LEGEND_ITEM_STYLE
  const style: CSSProperties = value === 0 ? { ...base, opacity: 0.42 } : base
  return onClick === undefined ? (
    <span style={{ ...style, cursor: 'default' }}>{content}</span>
  ) : (
    <button
      type="button"
      style={style}
      title={`${label} ${value} · ${percent}% · ${hint}`}
      onClick={onClick}
    >
      {content}
    </button>
  )
}

/** 双色条行：命中总数里「只被它命中」占多少 —— 揭示来源 / 检索式的独占贡献。 */
function ShareBarList({
  items,
  color,
  columns,
  t,
}: {
  items: ShareItem[]
  color: string
  columns: ReadonlyArray<{ key: string; label: string }>
  t: Translate
}): ReactElement {
  const peak = Math.max(...items.map((item) => item.total), 1)
  return (
    <div>
      <div style={SHARE_HEAD_STYLE}>
        <span style={NAME_STYLE}>{t('overview.col.name')}</span>
        <span style={SHARE_HEAD_TRACK_STYLE} />
        {columns.map((column) => (
          <span
            key={column.key}
            style={{ ...SHARE_CELL_HEAD_STYLE, width: columnWidth(columns.length) }}
          >
            {column.label}
          </span>
        ))}
      </div>
      {items.map((item) => {
        const share = ratioOf(item.total, peak)
        const uniqueShare = ratioOf(item.unique, item.total)
        const title = `${item.title} · ${t('overview.clickToFilter')}`
        return (
          <button
            key={item.key}
            type="button"
            style={ROW_STYLE}
            title={title}
            onClick={item.onClick}
          >
            <span style={NAME_STYLE} title={item.label}>
              {item.label}
            </span>
            <span style={TRACK_STYLE}>
              <span
                style={{
                  ...BAR_FILL_STYLE,
                  display: 'flex',
                  width: `${share * 100}%`,
                  background: tint(color, 0.32),
                  borderRadius: 4,
                  overflow: 'hidden',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    width: `${uniqueShare * 100}%`,
                    background: color,
                  }}
                />
              </span>
            </span>
            {item.cells.map((cell, index) => (
              <span
                key={index}
                style={{
                  ...SHARE_CELL_STYLE,
                  width: columnWidth(columns.length),
                  color: cell.muted === true ? undefined : color,
                  opacity: cell.muted === true ? 0.68 : 1,
                }}
              >
                {cell.text}
              </span>
            ))}
          </button>
        )
      })}
    </div>
  )
}

function columnWidth(count: number): number {
  return count >= 4 ? 26 : count === 3 ? 30 : 34
}

/** 年份面积折线：趋势用曲线，点击某一年筛选该年（年份空缺补 0，不连假线）。 */
function TrendChart({
  years,
  hint,
  t,
  onPick,
}: {
  years: YearStat[]
  hint: string
  t: Translate
  onPick(patch: Partial<ResultsQuery>): void
}): ReactElement {
  const [ref, width] = useMeasuredWidth()

  if (years.length === 0) return <div style={TEXT_STYLE}>—</div>

  const first = years[0].year
  const last = years[years.length - 1].year
  const lookup = new Map(years.map((entry) => [entry.year, entry]))
  const series: YearStat[] = []
  for (let year = first; year <= last; year += 1) {
    series.push(lookup.get(year) ?? { year, count: 0, included: 0 })
  }
  const shown = series.slice(-40)

  const total = sum(shown.map((entry) => entry.count))
  const peak = shown.reduce((best, entry) => (entry.count > best.count ? entry : best), shown[0])
  const recentFrom = shown[shown.length - 1].year - 4
  const recent = sum(shown.filter((entry) => entry.year >= recentFrom).map((entry) => entry.count))

  const padX = 4
  const padTop = 8
  const padBottom = 15
  const innerW = Math.max(1, width - padX * 2)
  const innerH = TREND_HEIGHT - padTop - padBottom
  const max = Math.max(...shown.map((entry) => entry.count), 1)
  const xOf = (index: number): number =>
    shown.length === 1 ? width / 2 : padX + (index / (shown.length - 1)) * innerW
  const yOf = (value: number): number => padTop + innerH - ratioOf(value, max) * innerH

  const points: Array<[number, number]> = shown.map((entry, index) => [xOf(index), yOf(entry.count)])
  const line = smoothPath(points, padTop, padTop + innerH)
  const area =
    points.length > 0
      ? `${line} L ${points[points.length - 1][0]} ${padTop + innerH} L ${points[0][0]} ${
          padTop + innerH
        } Z`
      : ''

  // X 轴刻度：等距抽样，末位强制显示且不与前一个撞车。
  const step = Math.max(1, Math.ceil(shown.length / 6))
  const ticks: number[] = []
  for (let index = 0; index < shown.length; index += step) ticks.push(index)
  const lastTick = ticks[ticks.length - 1]
  if (lastTick !== shown.length - 1) {
    if (shown.length - 1 - lastTick < step / 2 && ticks.length > 1) ticks.pop()
    ticks.push(shown.length - 1)
  }

  return (
    <div ref={ref} style={TREND_WRAP_STYLE}>
      <svg width={width} height={TREND_HEIGHT} style={SVG_STYLE} role="img">
        <defs>
          <linearGradient id="litsearch-year" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.blue} stopOpacity="0.28" />
            <stop offset="100%" stopColor={C.blue} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line
          x1={padX}
          y1={padTop + innerH}
          x2={width - padX}
          y2={padTop + innerH}
          stroke="currentColor"
          strokeOpacity="0.18"
        />
        {area !== '' && <path d={area} fill="url(#litsearch-year)" />}
        {line !== '' && (
          <path
            d={line}
            fill="none"
            stroke={C.blue}
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {shown.map((entry, index) => {
          const filled = entry.count > 0
          return (
            <g key={entry.year}>
              <rect
                x={Math.max(0, xOf(index) - innerW / Math.max(1, shown.length) / 2)}
                y={padTop}
                width={Math.max(6, innerW / Math.max(1, shown.length))}
                height={innerH}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onClick={() => onPick({ yearFrom: entry.year, yearTo: entry.year })}
              >
                <title>{`${entry.year} · ${entry.count} · ${hint}`}</title>
              </rect>
              {filled && (
                <circle
                  cx={xOf(index)}
                  cy={yOf(entry.count)}
                  r={entry.year === peak.year ? 2.8 : 1.6}
                  fill={C.blue}
                  fillOpacity={entry.year === peak.year ? 1 : 0.45}
                  pointerEvents="none"
                />
              )}
            </g>
          )
        })}
        {ticks.map((index) => (
          <text
            key={shown[index].year}
            x={xOf(index)}
            y={TREND_HEIGHT - 3}
            textAnchor={index === 0 ? 'start' : index === shown.length - 1 ? 'end' : 'middle'}
            fontSize="9"
            fill="currentColor"
            fillOpacity="0.55"
          >
            {shown[index].year}
          </text>
        ))}
      </svg>
      <p style={CAPTION_STYLE}>
        {tpl(t('overview.yearsCaption'), {
          from: shown[0].year,
          to: shown[shown.length - 1].year,
          year: peak.year,
          peak: peak.count,
          recent: Math.round(ratioOf(recent, total) * 100),
        })}
      </p>
    </div>
  )
}

/** Catmull-Rom → 三次贝塞尔；控制点夹在绘图区内，避免曲线冲出坐标轴。 */
function smoothPath(
  points: ReadonlyArray<readonly [number, number]>,
  min: number,
  max: number,
): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)]
    const p1 = points[index]
    const p2 = points[index + 1]
    const p3 = points[Math.min(points.length - 1, index + 2)]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6, min, max)
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6, min, max)
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`
  }
  return d
}

/** 单指标环形进度：值在圆心，一眼看出离 100% 的差距。 */
function RingGauge({
  ratio,
  color,
  label,
  hint,
}: {
  ratio: number
  color: string
  label: string
  hint: string
}): ReactElement {
  const radius = (RING_SIZE - RING_THICKNESS) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = clamp(ratio, 0, 1)
  return (
    <div style={RING_WRAP_STYLE} title={`${label} · ${Math.round(clamped * 100)}% · ${hint}`}>
      <svg width={RING_SIZE} height={RING_SIZE} style={SVG_STYLE}>
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.13"
          strokeWidth={RING_THICKNESS}
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={RING_THICKNESS}
          strokeLinecap="round"
          strokeDasharray={`${circumference * clamped} ${circumference}`}
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        />
        <text
          x={RING_SIZE / 2}
          y={RING_SIZE / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="13"
          fontWeight="600"
          fill={color}
        >
          {Math.round(clamped * 100)}%
        </text>
      </svg>
      <span style={RING_LABEL_STYLE}>{label}</span>
    </div>
  )
}

/** 纯量指标：文字 + 大号数字，不画条。 */
function Kpi({ label, value, color }: { label: string; value: string; color: string }): ReactElement {
  return (
    <div style={KPI_STYLE}>
      <span style={KPI_LABEL_STYLE}>{label}</span>
      <b style={{ ...KPI_VALUE_STYLE, color }}>{value}</b>
    </div>
  )
}

/** 纯文字排名：名称 + 计数，两列紧凑排布（排序列表画条没有额外信息）。 */
function RankList({
  entries,
  color,
  hint,
  onPick,
  columns = 2,
}: {
  entries: CountEntry[]
  color: string
  hint: string
  onPick(key: string): void
  columns?: 1 | 2
}): ReactElement {
  return (
    <div
      style={{
        ...RANK_GRID_STYLE,
        gridTemplateColumns: columns === 1 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))',
      }}
    >
      {entries.map((entry, index) => (
        <button
          key={entry.key}
          type="button"
          style={RANK_ITEM_STYLE}
          title={`${entry.key} · ${entry.count} · ${hint}`}
          onClick={() => onPick(entry.key)}
        >
          <span style={RANK_NO_STYLE}>{index + 1}</span>
          <span style={RANK_LABEL_STYLE} title={entry.key}>
            {entry.key}
          </span>
          <b style={{ ...RANK_VALUE_STYLE, color }}>{entry.count}</b>
        </button>
      ))}
    </div>
  )
}

/** 容器宽度测量：SVG 需要真实像素宽度才能按比例排布。 */
function useMeasuredWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(280)
  useEffect(() => {
    const node = ref.current
    if (node === null) return
    const update = (): void => {
      const next = node.clientWidth
      if (next > 0) setWidth(next)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/* ---- 环形图 ------------------------------------------------------------- */

/** 环形图本体：svg 圆环按角度分段，每段可点击。 */
function Donut({
  segments,
  total,
  center,
  centerHint,
  hint,
}: {
  segments: Segment[]
  total: number
  center: string
  centerHint: string
  hint: string
}): ReactElement {
  const radius = (DONUT_SIZE - DONUT_THICKNESS) / 2
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <svg width={DONUT_SIZE} height={DONUT_SIZE} style={{ ...SVG_STYLE, flex: '0 0 auto' }}>
      <circle
        cx={DONUT_SIZE / 2}
        cy={DONUT_SIZE / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.12"
        strokeWidth={DONUT_THICKNESS}
      />
      {segments
        .filter((segment) => segment.value > 0)
        .map((segment) => {
          const length = ratioOf(segment.value, total) * circumference
          const circle = (
            <circle
              key={segment.key}
              cx={DONUT_SIZE / 2}
              cy={DONUT_SIZE / 2}
              r={radius}
              fill="none"
              stroke={segment.color}
              strokeWidth={DONUT_THICKNESS}
              strokeDasharray={`${Math.max(0, length - 1.5)} ${circumference}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${DONUT_SIZE / 2} ${DONUT_SIZE / 2})`}
              style={segment.onClick === undefined ? undefined : { cursor: 'pointer' }}
              onClick={segment.onClick}
            >
              <title>{`${segment.label} ${segment.value} · ${Math.round(
                ratioOf(segment.value, total) * 100,
              )}% · ${hint}`}</title>
            </circle>
          )
          offset += length
          return circle
        })}
      <text
        x={DONUT_SIZE / 2}
        y={DONUT_SIZE / 2 - 4}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="15"
        fontWeight="600"
        fill="currentColor"
      >
        {center}
      </text>
      <text
        x={DONUT_SIZE / 2}
        y={DONUT_SIZE / 2 + 9}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="9"
        fill="currentColor"
        fillOpacity="0.6"
      >
        {centerHint}
      </text>
    </svg>
  )
}

/* ---- 样式 --------------------------------------------------------------- */

const WRAP_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const SCOPED_STYLE: CSSProperties = {
  fontSize: 11,
  color: C.violet,
  background: tint(C.violet, 0.08),
  borderRadius: 4,
  padding: '2px 6px',
  marginBottom: 2,
}
const SUMMARY_STYLE: CSSProperties = {
  margin: '2px 0 6px',
  fontSize: 12,
  lineHeight: 1.65,
  opacity: 0.85,
  fontVariantNumeric: 'tabular-nums',
}
const SECTION_STYLE: CSSProperties = {
  padding: '8px 0',
  borderBottom: '1px solid rgba(127,127,127,0.12)',
}
const SECTION_HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12.5,
  fontWeight: 650,
  opacity: 0.9,
  margin: '0 0 6px',
}
const SECTION_HINT_STYLE: CSSProperties = {
  marginLeft: 'auto',
  fontSize: 9.5,
  fontWeight: 400,
  opacity: 0.45,
  letterSpacing: 0,
}
const SECTION_MARK_STYLE: CSSProperties = {
  width: 3,
  height: 12,
  borderRadius: 2,
  flex: '0 0 3px',
}
const TEXT_STYLE: CSSProperties = { fontSize: 12.5, lineHeight: 1.55 }
const CAPTION_STYLE: CSSProperties = {
  margin: '5px 0 0',
  fontSize: 10.5,
  lineHeight: 1.5,
  opacity: 0.62,
  fontVariantNumeric: 'tabular-nums',
}
const SUB_HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  margin: '9px 0 3px',
  fontSize: 10.5,
  opacity: 0.75,
}
const SUB_TOTAL_STYLE: CSSProperties = { fontSize: 10, opacity: 0.75 }

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
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
  flex: '0 0 84px',
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
  background: 'rgba(127,127,127,0.13)',
  overflow: 'hidden',
}
const BAR_FILL_STYLE: CSSProperties = { display: 'block', height: '100%', borderRadius: 4 }
const NUM_STYLE: CSSProperties = {
  flex: '0 0 32px',
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 600,
}
const DROP_STYLE: CSSProperties = {
  flex: '0 0 34px',
  textAlign: 'right',
  fontSize: 10,
  opacity: 0.5,
  fontVariantNumeric: 'tabular-nums',
}

const STACK_TRACK_STYLE: CSSProperties = {
  display: 'flex',
  gap: 1,
  width: '100%',
  height: 11,
  borderRadius: 5,
  background: 'rgba(127,127,127,0.10)',
  overflow: 'hidden',
}
const SEGMENT_STYLE: CSSProperties = {
  height: '100%',
  minWidth: 2,
  border: 'none',
  padding: 0,
  borderRadius: 3,
  cursor: 'pointer',
}
const LEGEND_GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '1px 10px',
  marginTop: 5,
}
const LEGEND_ITEM_STYLE: CSSProperties = {
  ...ROW_STYLE,
  gap: 4,
  padding: '1px 0',
  fontSize: 10.5,
  minWidth: 0,
}
const LEGEND_WIDE_STYLE: CSSProperties = { width: '100%' }
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
  opacity: 0.8,
}
const LEGEND_VALUE_STYLE: CSSProperties = {
  flex: '0 0 auto',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 11,
}
const LEGEND_PCT_STYLE: CSSProperties = {
  flex: '0 0 30px',
  textAlign: 'right',
  fontSize: 10,
  opacity: 0.55,
  fontVariantNumeric: 'tabular-nums',
}

const DONUT_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
}
const DONUT_LEGEND_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  flex: '1 1 auto',
  minWidth: 0,
}

const METRIC_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}
const METRIC_DIVIDER_STYLE: CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  margin: '2px 2px',
  background: 'rgba(127,127,127,0.16)',
}
const METRIC_FACTS_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  flex: '1 1 auto',
  minWidth: 0,
}
const RING_WRAP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 1,
  flex: '0 0 auto',
}
const RING_LABEL_STYLE: CSSProperties = { fontSize: 10, opacity: 0.72, whiteSpace: 'nowrap' }
const KPI_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
}
const KPI_LABEL_STYLE: CSSProperties = {
  fontSize: 10.5,
  opacity: 0.72,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const KPI_VALUE_STYLE: CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  lineHeight: 1.2,
  fontVariantNumeric: 'tabular-nums',
}

const SHARE_HEAD_STYLE: CSSProperties = {
  ...ROW_STYLE,
  padding: '0 0 2px',
  fontSize: 9.5,
  opacity: 0.58,
  cursor: 'default',
}
const SHARE_HEAD_TRACK_STYLE: CSSProperties = { flex: '1 1 auto', minWidth: 20 }
const SHARE_CELL_HEAD_STYLE: CSSProperties = { textAlign: 'right', flex: '0 0 auto' }
const SHARE_CELL_STYLE: CSSProperties = {
  flex: '0 0 auto',
  textAlign: 'right',
  fontSize: 10.5,
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 600,
}

const TREND_WRAP_STYLE: CSSProperties = { width: '100%' }
const SVG_STYLE: CSSProperties = { display: 'block', overflow: 'visible' }

const RANK_GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '1px 12px',
}
const RANK_ITEM_STYLE: CSSProperties = {
  ...ROW_STYLE,
  gap: 5,
  padding: '1.5px 0',
}
const RANK_NO_STYLE: CSSProperties = {
  flex: '0 0 10px',
  fontSize: 9,
  opacity: 0.4,
  fontVariantNumeric: 'tabular-nums',
}
const RANK_LABEL_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  opacity: 0.85,
}
const RANK_VALUE_STYLE: CSSProperties = {
  flex: '0 0 auto',
  fontSize: 10.5,
  fontVariantNumeric: 'tabular-nums',
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
