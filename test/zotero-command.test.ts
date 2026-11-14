import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ZOTERO_WINDOW_MS,
  isFreshZotero,
  markZoteroConsumed,
  peekPendingZotero,
  publishZoteroCommands,
} from '../src/client/zoteroCommandStore.ts'
import { TaskEvents } from '../src/host/events.ts'
import { describeZoteroTargets, matchZoteroTarget } from '../src/host/zotero/match.ts'
import type { TaskSummary, ZoteroCommand, ZoteroTarget } from '../src/search/types.ts'

function target(id: string, name: string, overrides: Partial<ZoteroTarget> = {}): ZoteroTarget {
  return { id, name, level: 0, ...overrides }
}

const TARGETS: ZoteroTarget[] = [
  target('lib', '我的文库', { level: 0 }),
  target('c1', '综述', { level: 1 }),
  target('c2', '深度学习', { level: 1 }),
  target('c3', '综述（待读）', { level: 1, filesEditable: false }),
  target('c4', 'Deep Learning', { level: 2, recent: true }),
]

let seq = 0

function command(overrides: Partial<ZoteroCommand> = {}): ZoteroCommand {
  seq += 1
  return {
    commandId: `zotero-${seq}`,
    taskId: 't1',
    at: Date.now(),
    origin: 'model',
    reason: '把这批存到综述目录',
    scopeLabel: '分组「综述」 · 共 1 篇',
    paperIds: ['p1'],
    items: [{ paperId: 'p1', title: 'Title', source: 'openalex' }],
    autoStart: false,
    ...overrides,
  }
}

function drain(): void {
  for (const item of peekPendingZotero()) markZoteroConsumed(item.commandId)
}

function summary(id: string): TaskSummary {
  return {
    id,
    title: id,
    status: 'done',
    origin: 'panel',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 1,
    pinned: false,
    stats: {
      perQuery: {},
      rawHits: 0,
      deduped: 0,
      screening: { unread: 0, read: 0, included: 0, excluded: 0 },
    },
    roundCount: 0,
  }
}

test('matchZoteroTarget：id 精确、名称忽略大小写与空白、唯一包含才命中', () => {
  const byId = matchZoteroTarget(TARGETS, 'C1')
  assert.equal(byId.kind, 'matched')
  if (byId.kind === 'matched') assert.equal(byId.target.id, 'c1')

  const byName = matchZoteroTarget(TARGETS, '  DEEP   learning  ')
  assert.equal(byName.kind, 'matched')
  if (byName.kind === 'matched') assert.equal(byName.target.id, 'c4')

  const partial = matchZoteroTarget(TARGETS, '待读')
  assert.equal(partial.kind, 'matched')
  if (partial.kind === 'matched') assert.equal(partial.target.id, 'c3')
})

test('matchZoteroTarget：歧义与找不到都返回候选，绝不猜一个目录', () => {
  const ambiguous = matchZoteroTarget(
    [target('a', '综述 A', { level: 1 }), target('b', '综述 B', { level: 1 })],
    '综述',
  )
  assert.equal(ambiguous.kind, 'ambiguous')
  if (ambiguous.kind === 'ambiguous') {
    assert.deepEqual(
      ambiguous.candidates.map((item) => item.id),
      ['a', 'b'],
    )
  }

  const none = matchZoteroTarget(TARGETS, '不存在的目录')
  assert.equal(none.kind, 'none')
  if (none.kind === 'none') {
    // 候选里最近使用的排前面，方便模型向用户确认。
    assert.equal(none.candidates[0]?.id, 'c4')
  }
  assert.equal(matchZoteroTarget(TARGETS, '   ').kind, 'none')
})

test('describeZoteroTargets 给出层级、只读标记与条数上限', () => {
  const text = describeZoteroTargets(
    [target('a', '一级'), target('b', '二级', { level: 1, filesEditable: false })],
    2,
  )
  assert.match(text, /- 一级/)
  assert.match(text, /- {3}二级（不可写附件）/)
  assert.match(text, /id: b/)

  const many = Array.from({ length: 15 }, (_, index) => target(`x${index}`, `目录${index}`))
  assert.match(describeZoteroTargets(many, 3), /还有 12 个目录/)
  assert.equal(describeZoteroTargets([]), '（Zotero 里没有可用目录）')
})

test('isFreshZotero 与下载指令一致：10 分钟窗口', () => {
  const now = 1_700_000_000_000
  const fresh = command({ at: now })
  assert.equal(isFreshZotero(fresh, now), true)
  assert.equal(isFreshZotero(fresh, now + ZOTERO_WINDOW_MS - 1), true)
  assert.equal(isFreshZotero(fresh, now + ZOTERO_WINDOW_MS + 1), false)
  assert.equal(isFreshZotero(command({ at: now + 120_000 }), now), false)
})

test('publishZoteroCommands 过滤过期 / 别的会话，并按 commandId 幂等', () => {
  drain()
  const fresh = command()
  const stale = command({ at: Date.now() - ZOTERO_WINDOW_MS - 1000 })
  const otherSession = command({ sessionId: 'other-session' })

  publishZoteroCommands([fresh, stale, otherSession], 'screen-session')
  const ids = peekPendingZotero().map((item) => item.commandId)
  assert.ok(ids.includes(fresh.commandId))
  assert.equal(ids.includes(stale.commandId), false)
  assert.equal(ids.includes(otherSession.commandId), false)

  publishZoteroCommands([fresh], 'screen-session')
  assert.equal(
    peekPendingZotero().filter((item) => item.commandId === fresh.commandId).length,
    1,
  )
  markZoteroConsumed(fresh.commandId)
  assert.equal(peekPendingZotero().some((item) => item.commandId === fresh.commandId), false)
})

test('Zotero 指令队列按到达顺序保留，供未挂载的任务 tab 后续消费', () => {
  drain()
  const first = command({ autoStart: true, target: target('c1', '综述') })
  const second = command()
  publishZoteroCommands([first, second])
  assert.deepEqual(
    peekPendingZotero().map((item) => item.commandId),
    [first.commandId, second.commandId],
  )
  assert.equal(peekPendingZotero()[0]?.autoStart, true)
  assert.equal(peekPendingZotero()[0]?.target?.id, 'c1')
})

test('/events 的 sinceRev 只返回增量 Zotero 指令，与下载指令互不覆盖', () => {
  const events = new TaskEvents()
  events.publishZotero(command({ commandId: 'z1' }))
  events.publish(summary('t1'))
  events.publishDownload({
    commandId: 'd1',
    taskId: 't1',
    at: Date.now(),
    origin: 'model',
    reason: '下载',
    scopeLabel: '范围',
    paperIds: ['p1'],
    items: [{ paperId: 'p1', title: 'Title', source: 'openalex' }],
  })
  events.publishZotero(command({ commandId: 'z2' }))

  const page = events.since(0)
  assert.equal(page.rev, 4)
  assert.deepEqual(
    page.zotero?.map((item) => item.commandId),
    ['z1', 'z2'],
  )
  assert.deepEqual(
    page.downloads?.map((item) => item.commandId),
    ['d1'],
  )
  assert.deepEqual(events.since(4).zotero, [])

  events.publishZotero(command({ commandId: 'z3' }))
  assert.deepEqual(
    events.since(4).zotero?.map((item) => item.commandId),
    ['z3'],
  )
})

test('宿主重启（reset）不重放历史 Zotero 指令；日志按上限裁剪且按任务清理', () => {
  const events = new TaskEvents()
  for (let index = 0; index < 55; index += 1) {
    events.publishZotero(
      command({ commandId: `z${index}`, taskId: index % 2 === 0 ? 't1' : 't2' }),
    )
  }
  const before = events.since(0)
  assert.equal(before.zotero?.length, 50)
  assert.equal(before.zotero?.[0].commandId, 'z5')

  events.remove('t1')
  const after = events.since(0)
  assert.equal(after.zotero?.some((item) => item.taskId === 't1'), false)
  assert.ok((after.zotero?.length ?? 0) > 0)

  const reset = events.since(999)
  assert.equal(reset.reset, true)
  assert.deepEqual(reset.zotero, [])
  assert.deepEqual(reset.downloads, [])
})
