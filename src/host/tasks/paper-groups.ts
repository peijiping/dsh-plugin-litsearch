import {
  buildPaper,
  comparePapers,
  identityKey,
  makePaperId,
  normalizeTitle,
  type RankedHit,
} from '../../search/identity.js'
import type { MatchEvidence, PaperGroup, Review } from '../../search/evidence.js'
import type { Paper, PaperRecord, SearchRound, SearchTask, SourceStatus } from '../../search/types.js'
import { applySupplements } from './supplements.js'
import { digest, filterReasons } from './page-evidence.js'
import { reportRecord } from './task-migration.js'

const idFields = ['doi', 'pmid', 'pmcid', 'arxivId'] as const
type IdentityRecord = NonNullable<SearchTask['legacyPaperIdentities']>[string]

function keys(r: IdentityRecord): [MatchEvidence['field'], string][] {
  const result: [MatchEvidence['field'], string][] = []
  for (const field of idFields) if (r.ids[field]) result.push([field, r.ids[field].trim().toLowerCase()])
  if (r.sourceId) result.push(['sourceId', nativeId(r)])
  return result
}
function nativeId(r: IdentityRecord): string {
  // Europe PMC 的 MED/PMC/PPR 等子库有独立编号空间，记录的 URL 含子库。
  return r.source + ':' + (r.source === 'europepmc' ? r.url || r.sourceId : r.sourceId)
}

function version(r: PaperRecord): 'preprint' | 'published' | undefined {
  if (r.source === 'arxiv' || /preprint|posted-content/iu.test(r.type)) return 'preprint'
  if (/journal.article|proceedings.article/iu.test(r.type)) return 'published'
  return undefined
}

function conflicts(members: string[], records: Record<string, PaperRecord>): string[] {
  return idFields.flatMap((field) => {
    const values = [...new Set(members.map((id) => records[id].ids[field].toLowerCase()).filter(Boolean))]
    return values.length > 1 ? [field + ': ' + values.join(' / ')] : []
  })
}

function components(ids: string[], records: Record<string, PaperRecord>) {
  const parents = new Map(ids.map((id) => [id, id]))
  function root(id: string): string {
    let parent = parents.get(id)!
    while (parent !== id) {
      parents.set(id, parents.get(parent)!)
      id = parent
      parent = parents.get(id)!
    }
    return id
  }
  const first = new Map<string, string>()
  const edges: MatchEvidence[] = []
  for (const id of ids) {
    const record = records[id]
    const identifiers = keys(record)
    const fallback = identityKey(record)
    if (fallback.startsWith('title:')) identifiers.push(['title', fallback])
    for (const [field, value] of identifiers) {
      const key = field + ':' + value
      const peer = first.get(key)
      if (!peer) first.set(key, id)
      else if (root(id) !== root(peer)) {
        parents.set(root(id), root(peer))
        edges.push({ left: peer, right: id, field, value })
      }
    }
  }
  const sets = new Map<string, string[]>()
  for (const id of ids) {
    const key = root(id)
    const members = sets.get(key) ?? []
    members.push(id)
    sets.set(key, members)
  }
  return { sets: [...sets.values()], edges }
}

export function resolvePaperId(task: SearchTask, id: string): string {
  if (task.result.papers.some((paper) => paper.paperId === id)) return id
  return task.paperAliases?.find((a) => a.from === id)?.to ?? id
}

export function rebuildRound(task: SearchTask, round: SearchRound): void {
  const ev = round.evidence!
  const records = task.records ?? {}
  const hitsByRecord = new Map<string, RankedHit[]>()
  const sources = new Map<SourceStatus['id'], SourceStatus>()
  const perQuery: Record<string, number> = {}
  for (const run of ev.runs) {
    const source = sources.get(run.source) ?? { id: run.source, count: 0, ok: true }
    const stop = run.progress.stopReason
    if (stop === 'rateLimited') {
      source.skipped = true
      source.note = '上游限流'
    } else if (['error', 'timeout', 'cursorExpired', 'duplicatePage'].includes(stop)) {
      source.ok = false
      source.error = run.pages.at(-1)?.attempts.at(-1)?.detail ?? stop
    }
    sources.set(run.source, source)
    for (const page of run.pages) {
      const committed = page.committed
      if (!committed) continue
      perQuery[run.queryId] = (perQuery[run.queryId] ?? 0) + committed.kept
      source.count += committed.kept
      if (committed.hits.some((h) => h.status === 'filtered')) source.filtered = true
      for (const hit of committed.hits) {
        if (hit.status !== 'kept') continue
        const list = hitsByRecord.get(hit.recordId) ?? []
        list.push({
          record: reportRecord(records[hit.recordId]),
          queryId: run.queryId,
          source: run.source,
          rank: hit.rank,
        })
        hitsByRecord.set(hit.recordId, list)
      }
    }
  }
  // 先找完整的强标识连通组，再判断一致性；遍历先后不能决定桥接记录归属。
  const ids = [...hitsByRecord.keys()].sort()
  const { sets, edges } = components(ids, records)
  const oldReviews = new Map(task.rounds.flatMap((r) => r.evidence?.reviews ?? []).map((r) => [r.id, r]))
  const reviews = new Map<string, Review>()
  const memberPaper = new Map<string, string>()
  const review = (reason: Review['reason'], members: string[], evidence: string[]): Review => {
    const recordIds = [...members].sort()
    const id = digest([reason, recordIds])
    const item: Review = {
      id,
      reason,
      recordIds,
      paperIds: [],
      evidence,
      decisions: oldReviews.get(id)?.decisions ?? [],
    }
    reviews.set(id, item)
    return item
  }
  const partitions: string[][] = []
  for (const members of sets) {
    const disagreements = conflicts(members, records)
    const versions = new Set(members.map((id) => version(records[id])).filter(Boolean))
    const split = [...oldReviews.values()].find(
      (item) =>
        item.reason === 'manualSplit' && item.recordIds.filter((id) => members.includes(id)).length > 1,
    )
    if (split)
      reviews.set(split.id, { ...split, recordIds: split.recordIds.filter((id) => members.includes(id)) })
    if (disagreements.length || versions.size > 1) {
      review(
        disagreements.length ? 'strongIdConflict' : 'possibleVersion',
        members,
        disagreements.length ? disagreements : ['预印本 / 正式发表版本'],
      )
      for (const id of members) partitions.push([id])
    } else if (split?.decisions.at(-1)?.action === 'split') {
      for (const id of members) partitions.push([id])
    } else partitions.push(members)
  }
  const baseKeys = partitions.map((members) => {
    for (const field of idFields) {
      const value = members.map((id) => records[id].ids[field]).find(Boolean)
      if (value) return (field === 'arxivId' ? 'arxiv' : field) + ':' + value
    }
    return identityKey(records[members[0]])
  })
  const history = new Map<string, Set<string>>()
  for (const previous of task.rounds) {
    if (previous.id === round.id) continue
    for (const group of previous.evidence?.groups ?? []) {
      for (const id of group.members) {
        const old = records[id]
        if (!old) continue
        for (const key of keys(old).map(([field, value]) => field + ':' + value)) {
          const ids = history.get(key) ?? new Set<string>()
          ids.add(group.paperId)
          history.set(key, ids)
        }
      }
    }
  }
  // v1/v2 缺少来源成员。用保存过的题录强标识，或相同来源记录加相同题名，衔接旧 ID。
  const legacyByKey = new Map<string, Set<string>>()
  const legacyRecords = task.legacyPaperIdentities ?? {}
  for (const [paperId, record] of Object.entries(legacyRecords)) {
    for (const [field, value] of keys(record)) {
      const key = field + ':' + value
      const ids = legacyByKey.get(key) ?? new Set<string>()
      ids.add(paperId)
      legacyByKey.set(key, ids)
    }
  }
  const agreesWithLegacy = (paperId: string, members: string[]): boolean => {
    const old = legacyRecords[paperId]
    return (
      !old ||
      members.every((id) =>
        idFields.every(
          (field) =>
            !old.ids[field] ||
            !records[id].ids[field] ||
            old.ids[field].toLowerCase() === records[id].ids[field].toLowerCase(),
        ),
      )
    )
  }
  const legacyTargets = new Map<string, number[]>()
  partitions.forEach((members, index) => {
    const matches = new Set<string>()
    for (const id of members) {
      const current = records[id]
      for (const [field, value] of keys(current)) {
        for (const paperId of legacyByKey.get(field + ':' + value) ?? []) {
          if (
            field === 'sourceId' &&
            normalizeTitle(legacyRecords[paperId].title) !== normalizeTitle(current.title)
          )
            continue
          matches.add(paperId)
        }
      }
    }
    for (const paperId of matches) {
      if (!agreesWithLegacy(paperId, members)) continue
      const targets = legacyTargets.get(paperId) ?? []
      targets.push(index)
      legacyTargets.set(paperId, targets)
    }
  })
  const legacyIds = new Map<number, string[]>()
  for (const [paperId, targets] of legacyTargets) {
    if (targets.length !== 1) continue
    const list = legacyIds.get(targets[0]) ?? []
    list.push(paperId)
    legacyIds.set(targets[0], list)
  }
  const candidateIds = partitions.map((members, index) => {
    const candidates = new Set(
      members.flatMap((id) =>
        keys(records[id]).flatMap(([field, value]) => [...(history.get(field + ':' + value) ?? [])]),
      ),
    )
    for (const paperId of legacyIds.get(index) ?? []) candidates.add(paperId)
    let canonical = makePaperId(baseKeys[index])
    if (!agreesWithLegacy(canonical, members)) {
      canonical = makePaperId(baseKeys[index] + ':' + JSON.stringify(records[members[0]].ids))
    }
    if (candidates.has(canonical)) return canonical
    return candidates.size === 1 ? [...candidates][0] : canonical
  })
  const occurrences = new Map<string, number>()
  for (const id of candidateIds) occurrences.set(id, (occurrences.get(id) ?? 0) + 1)
  const splitOwners = new Map<string, string>()
  for (const item of reviews.values()) {
    if (item.reason !== 'manualSplit') continue
    const decision = item.decisions.at(-1)
    if (decision?.originalPaperId && decision.anchorRecordId) {
      splitOwners.set(decision.anchorRecordId, decision.originalPaperId)
    }
  }
  const assigned = new Set(splitOwners.values())
  const paperGroups = new Map<string, PaperGroup>()
  const papers: Paper[] = []
  const possibleAliases = new Map<string, Set<string>>()
  partitions.forEach((members, index) => {
    const key = baseKeys[index]
    const candidate = candidateIds[index]
    const record = records[members[0]]
    const owner = members.map((id) => splitOwners.get(id)).find(Boolean)
    let paperId =
      owner ??
      (occurrences.get(candidate) === 1
        ? candidate
        : makePaperId(key + ':' + nativeId(record) + ':' + JSON.stringify(record.ids)))
    if (!owner && assigned.has(paperId)) paperId = makePaperId(paperId + ':' + members[0])
    assigned.add(paperId)
    const hits = members
      .flatMap((id) => hitsByRecord.get(id)!)
      .sort(
        (a, b) =>
          ev.runs.findIndex((r) => r.source === a.source && r.queryId === a.queryId) -
            ev.runs.findIndex((r) => r.source === b.source && r.queryId === b.queryId) || a.rank - b.rank,
      )
    const paper = buildPaper(paperId, hits)
    papers.push(paper)
    paperGroups.set(paperId, { paperId, members, matches: [], disposition: 'saved', reasons: [] })
    for (const oldId of legacyIds.get(index) ?? []) {
      const targets = possibleAliases.get(oldId) ?? new Set<string>()
      targets.add(paperId)
      possibleAliases.set(oldId, targets)
    }
    for (const id of members) {
      memberPaper.set(id, paperId)
      const record = records[id]
      const previousKeys = [
        identityKey(record),
        ...idFields
          .filter((f) => record.ids[f])
          .map((f) => (f === 'arxivId' ? 'arxiv' : f) + ':' + record.ids[f]),
      ]
      for (const oldKey of previousKeys) {
        const oldId = makePaperId(oldKey)
        if (legacyRecords[oldId] && !legacyIds.get(index)?.includes(oldId)) continue
        const targets = possibleAliases.get(oldId) ?? new Set<string>()
        targets.add(paperId)
        possibleAliases.set(oldId, targets)
      }
    }
  })
  for (const edge of edges) {
    const paperId = memberPaper.get(edge.left)!
    if (paperId === memberPaper.get(edge.right)) paperGroups.get(paperId)!.matches.push(edge)
  }
  const titles = new Map<string, string[]>()
  for (const id of ids) {
    const title = normalizeTitle(records[id].title)
    if (title.length < 12) continue
    const list = titles.get(title) ?? []
    list.push(id)
    titles.set(title, list)
  }
  for (const [title, members] of titles) {
    if (new Set(members.map((id) => memberPaper.get(id))).size < 2) continue
    const evidence = conflicts(members, records)
    if (evidence.length || new Set(members.map((id) => version(records[id])).filter(Boolean)).size > 1) {
      review(
        evidence.some((msg) => msg.startsWith('doi:')) ? 'sameTitleDifferentDoi' : 'possibleVersion',
        members,
        [title, ...evidence],
      )
    }
  }

  // 人工状态原件始终按原 ID 保留。兼容投影仅在唯一可归属时继承。
  const aliases = task.paperAliases ?? []
  for (const alias of aliases) {
    if (paperGroups.has(alias.to)) continue
    const targets = possibleAliases.get(alias.to)
    if (targets?.size === 1) alias.to = [...targets][0]
  }
  for (const [oldId, targets] of possibleAliases) {
    if (targets.size !== 1 || paperGroups.has(oldId)) continue
    const to = [...targets][0]
    if (!aliases.some((a) => a.from === oldId && a.to === to))
      aliases.push({
        from: oldId,
        to,
        sinceRound: round.id,
        reason: 'sharedIdentifier',
        recordIds: paperGroups.get(to)!.members,
      })
  }
  task.paperAliases = aliases.filter(
    (a) =>
      !paperGroups.has(a.from) &&
      (!possibleAliases.has(a.from) ||
        (possibleAliases.get(a.from)!.size === 1 && possibleAliases.get(a.from)!.has(a.to))),
  )
  for (const group of paperGroups.values()) {
    const states = [
      group.paperId,
      ...task.paperAliases.filter((a) => a.to === group.paperId).map((a) => a.from),
    ]
      .filter((id) => task.states[id])
      .map((originalPaperId) => ({ originalPaperId, state: task.states[originalPaperId] }))
    if (new Set(states.map((c) => c.state.screening)).size > 1) {
      const item = review('screeningConflict', group.members, ['来源成员的筛读结论不同'])
      item.stateCandidates = oldReviews.get(item.id)?.stateCandidates ?? structuredClone(states)
    }
    if (states.length && !task.states[group.paperId])
      task.states[group.paperId] = structuredClone(states[0].state)
  }
  for (const item of reviews.values())
    item.paperIds = [...new Set(item.recordIds.map((id) => memberPaper.get(id)!))]
  papers.sort((a, b) => comparePapers(a, b) || a.paperId.localeCompare(b.paperId))
  const saved: Paper[] = []
  let afterMergeFilter = 0
  for (const paper of papers) {
    const group = paperGroups.get(paper.paperId)!
    group.reasons = filterReasons(paper, round.conditions)
    if (group.reasons.length) group.disposition = 'filteredAfterMerge'
    else {
      afterMergeFilter++
      if (saved.length < ev.taskMaxPapers) saved.push(paper)
      else group.disposition = 'overLimit'
    }
  }
  ev.groups = papers.map((p) => paperGroups.get(p.paperId)!)
  ev.savedPaperIds = saved.map((p) => p.paperId)
  ev.reviews = [...reviews.values()]
  ev.counts = { merged: papers.length, afterMergeFilter, savedFromSearch: saved.length }
  task.stats.perQuery = perQuery
  task.stats.rawHits = Object.values(perQuery).reduce((a, b) => a + b, 0)
  task.stats.deduped = papers.length
  task.result.sources = [...sources.values()]
  applySupplements(task, saved)
  // 手工补录题录占用自己的稳定 ID；搜索结果被其覆盖时，旧链接也要能定位。
  for (const paper of saved) {
    if (task.result.papers.some((entry) => entry.paperId === paper.paperId)) continue
    const supplement = task.result.papers.find(
      (entry) =>
        entry.supplement &&
        (!entry.ids.doi || !paper.ids.doi || entry.ids.doi === paper.ids.doi) &&
        ((entry.ids.doi && entry.ids.doi === paper.ids.doi) ||
          (entry.ids.pmid && entry.ids.pmid === paper.ids.pmid) ||
          (entry.ids.arxivId && entry.ids.arxivId === paper.ids.arxivId)),
    )
    if (!supplement) continue
    task.paperAliases = task.paperAliases.map((alias) =>
      alias.to === paper.paperId ? { ...alias, to: supplement.paperId } : alias,
    )
    task.paperAliases.push({
      from: paper.paperId,
      to: supplement.paperId,
      sinceRound: round.id,
      recordIds: paperGroups.get(paper.paperId)!.members,
      reason: 'manualSupplement',
    })
  }
}
