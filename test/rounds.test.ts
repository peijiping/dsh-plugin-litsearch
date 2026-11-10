/**
 * 任务内检索轮次的回归测试。
 *
 * 只 import `rounds.ts` 的纯逻辑（type-only 依赖），不依赖 lib/ 构建产物，
 * 因此 `node --test` 可以直接跑源码。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import type { SearchTask } from '../src/search/types.ts'
import {
  cloneConditions,
  cloneRound,
  finishRound,
  roundsOf,
  startRound,
  trimRoundList,
} from '../src/host/tasks/rounds.ts'

function makeTask(): SearchTask {
  return {
    id: 't1',
    title: '口臭治疗方案文献',
    conditions: {
      queries: [
        {
          id: 'q1',
          name: '检索式 1',
          text: 'halitosis treatment',
          enabled: true,
          perSource: { pubmed: 'halitosis[MeSH]' },
        },
      ],
      sources: ['pubmed', 'openalex'],
      openAccessOnly: false,
      language: 'any',
      sort: 'relevance',
      pageSize: 20,
      types: ['review'],
    },
    status: 'draft',
    origin: 'model',
    rev: 1,
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
    pinned: false,
    notes: '',
    groups: [],
    stats: {
      perQuery: {},
      rawHits: 0,
      deduped: 0,
      screening: { unread: 0, read: 0, included: 0, excluded: 0 },
    },
    result: { papers: [], sources: [] },
    rounds: [],
    states: {},
  }
}

test('旧版本任务没有 rounds 时按空数组兼容', () => {
  const legacy = makeTask() as unknown as { rounds?: unknown }
  delete legacy.rounds
  assert.deepEqual(roundsOf(legacy as unknown as SearchTask), [])
})

test('条件快照是深拷贝：改原条件不会污染历史轮次', () => {
  const task = makeTask()
  const round = startRound(task, 'model', 30, '2026-11-10T10:00:01.000Z')

  task.conditions.queries[0].text = 'oral malodor management'
  task.conditions.queries[0].perSource!.pubmed = 'changed'
  task.conditions.sources.push('arxiv')
  task.conditions.types!.push('preprint')

  assert.equal(round.conditions.queries[0].text, 'halitosis treatment')
  assert.equal(round.conditions.queries[0].perSource?.pubmed, 'halitosis[MeSH]')
  assert.deepEqual(round.conditions.sources, ['pubmed', 'openalex'])
  assert.deepEqual(round.conditions.types, ['review'])

  const copy = cloneConditions(task.conditions)
  copy.queries[0].text = 'again'
  assert.equal(task.conditions.queries[0].text, 'oral malodor management')
})

test('多轮序号递增，超出上限只留最近 N 轮且不复用旧号', () => {
  const task = makeTask()
  for (let index = 0; index < 5; index += 1) {
    startRound(task, index % 2 === 0 ? 'model' : 'panel', 3, `2026-11-10T10:0${index}:00.000Z`)
  }
  const rounds = roundsOf(task)
  assert.equal(rounds.length, 3)
  assert.deepEqual(
    rounds.map((round) => round.index),
    [3, 4, 5],
  )
  assert.deepEqual(
    rounds.map((round) => round.origin),
    ['model', 'panel', 'model'],
  )
  assert.equal(startRound(task, 'model', 3).index, 6)
  assert.deepEqual(
    trimRoundList(roundsOf(task), 2).map((round) => round.index),
    [5, 6],
  )
})

test('finishRound 回填状态、命中统计与源级摘要', () => {
  const task = makeTask()
  const round = startRound(task, 'model', 30, '2026-11-10T10:00:00.000Z')
  task.status = 'partial'
  task.stats = {
    perQuery: { q1: 42 },
    rawHits: 42,
    deduped: 30,
    screening: { unread: 30, read: 0, included: 0, excluded: 0 },
  }
  task.result.papers = [{ paperId: 'p1' }] as unknown as SearchTask['result']['papers']
  task.result.sources = [
    { id: 'pubmed', ok: true, count: 20 },
    { id: 'arxiv', ok: true, count: 0, skipped: true, note: '按限流跳过' },
    { id: 'openalex', ok: false, count: 0, error: '超时' },
  ]
  task.error = '部分数据源不可用'

  finishRound(round, task, '2026-11-10T10:00:25.000Z')

  assert.equal(round.finishedAt, '2026-11-10T10:00:25.000Z')
  assert.equal(round.status, 'partial')
  assert.deepEqual(round.stats, {
    rawHits: 42,
    deduped: 30,
    loaded: 1,
    perQuery: { q1: 42 },
  })
  assert.equal(round.skippedSources, 1)
  assert.equal(round.failedSources, 1)
  assert.equal(round.error, '部分数据源不可用')
})

test('cloneRound 不与内存轮次共享条件与统计引用', () => {
  const task = makeTask()
  const round = startRound(task, 'panel', 30)
  finishRound(round, task)
  const copy = cloneRound(round)
  copy.conditions.queries[0].text = 'changed'
  if (copy.stats !== undefined) copy.stats.perQuery.q1 = 999
  assert.equal(round.conditions.queries[0].text, 'halitosis treatment')
  assert.equal(round.stats?.perQuery.q1 ?? 0, 0)
})
