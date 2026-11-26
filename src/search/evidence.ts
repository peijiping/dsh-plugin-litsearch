import type { PaperIds, PaperRecord, PaperState, SearchRound, SourceId } from './types.js'

type Instant = string
type RecordId = string // 任务内不可变的来源题录快照；同一来源 ID 的内容发生变化时分配新快照。
type PaperId = string // 沿用 makePaperId 及现有 paperId。下面两种 ID 不互换。
export type SafeRequest = {
  sentAt: Instant
  operation: 'search' | 'fetchDetails'
  endpoint: string // 无查询串、无身份凭据
  params: Record<string, string> // 逐来源白名单；游标单独保存，仅 Host 可读
}
export type ResumePosition = { kind: 'cursor'; value: string } | { kind: 'offset'; value: number }
export type Attempt = {
  startedAt: Instant
  endedAt?: Instant // 缺省只表示已开始，进程重启时可识别未完成尝试
  requests: SafeRequest[]
  outcome:
    | 'started'
    | 'committed'
    | 'timeout'
    | 'rateLimited'
    | 'canceled'
    | 'cursorExpired'
    | 'duplicatePage'
    | 'error'
  detail?: string
  retryAfter?: Instant
}
export type Hit = {
  position: number // 1 起算的本页位置
  sourceRank: number // 同一来源、同一检索块跨页位置。旧源只能观测交回顺序时，由 rankBasis 标记。
} & (
  | { status: 'invalid'; sourceId?: string; reason: string }
  | { status: 'filtered'; recordId: RecordId; reasons: string[] }
  | { status: 'kept'; recordId: RecordId; rank: number } // 跨页累计的过滤后排位，供已有 RankedHit / RRF 使用
)
export type Page = {
  pageNo: number
  input: ResumePosition | null // null 表示首页；重复请求同一位置归到同一个逻辑页
  attempts: Attempt[]
  committed?: {
    // 仅成功采纳的一份响应有此字段；未提交页贡献零条
    at: Instant
    reportedTotal: number | null
    returned: number | null
    normalized: number | null // 旧源观察不到完整规范化阶段时保留 null
    kept: number
    observedEntries: number // 实际可枚举的命中位置数；采集完整时等于 returned
    contentFingerprint: string // 基于一页的来源记录标识，不含请求时间和游标
    hits: Hit[]
    next: ResumePosition | null
  }
}
export type SourceRun = {
  queryId: string
  source: SourceId
  conditionFingerprint: string
  pageSize: number
  rankBasis: 'upstream' | 'providerOutput'
  capability: 'pageable' | 'firstPageOnly'
  adaptedQuery: string
  adaptation: { kind: 'sourceOverride' | 'removedFieldTag' | 'removedOperator' | 'other'; detail: string }[]
  progress: {
    lastCommittedPage: number
    next: ResumePosition | null
    stopReason:
      | 'ready'
      | 'exhausted'
      | 'taskLimit'
      | 'firstPageOnly'
      | 'timeout'
      | 'rateLimited'
      | 'canceled'
      | 'cursorExpired'
      | 'duplicatePage'
      | 'error'
    retryAfter?: Instant
  }
  pages: Page[]
}
export type MatchEvidence = {
  left: RecordId
  right: RecordId
  field: keyof PaperIds | 'sourceId' | 'title'
  value: string
}
export type PaperGroup = {
  paperId: PaperId
  members: RecordId[]
  matches: MatchEvidence[]
  disposition: 'saved' | 'filteredAfterMerge' | 'overLimit'
  reasons: string[]
}
export type Review = {
  id: string
  reason:
    | 'manualSplit'
    | 'sameTitleDifferentDoi'
    | 'strongIdConflict'
    | 'possibleVersion'
    | 'screeningConflict'
  paperIds: PaperId[]
  recordIds: RecordId[]
  evidence: string[]
  stateCandidates?: { originalPaperId: PaperId; state: PaperState }[]
  decisions: {
    at: Instant
    action: 'keepSeparate' | 'linkVersions' | 'split' | 'resolveScreening'
    note: string
    recordGroups?: RecordId[][]
    originalPaperId?: PaperId
    anchorRecordId?: RecordId
    chosenState?: PaperState
  }[] // 关联成员集合与理由；空数组表示待处理
}
export type Evidence = {
  taskMaxPapers: number
  mergePolicyVersion: number
  runs: SourceRun[]
  groups: PaperGroup[] // 含通过去重、但在合并后过滤或超过任务上限的组
  reviews: Review[]
  savedPaperIds: PaperId[] // 本轮在线检索最终顺序；手工补录另计
  counts: { merged: number; afterMergeFilter: number; savedFromSearch: number }
}
export type Alias = { from: PaperId; to: PaperId; sinceRound: string; recordIds: RecordId[]; reason: string }

export interface ProviderPage {
  entries: ({ record: PaperRecord } | { sourceId: string; reason: string })[]
  reportedTotal: number | null
  returned: number | null
  normalized: number | null
  next: ResumePosition | null
}

/** 只在明确请求执行明细时返回；所有 input/next 均已移除私有值。 */
export interface RoundReport {
  taskId: string
  rev: number
  isCurrent: boolean
  canContinue: boolean
  round: SearchRound
  records: Record<string, PaperRecord>
  aliases: Alias[]
}
