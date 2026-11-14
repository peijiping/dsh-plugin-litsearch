import test from 'node:test'
import assert from 'node:assert/strict'

import { TaskEvents } from '../src/host/events.ts'
import type { DownloadCommand, TaskSummary } from '../src/search/types.ts'

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

function command(commandId: string, taskId = 't1'): DownloadCommand {
  return {
    commandId,
    taskId,
    at: Date.now(),
    origin: 'model',
    reason: '下载测试',
    scopeLabel: '测试范围 · 共 1 篇',
    paperIds: ['p1'],
    items: [{ paperId: 'p1', title: 'Title', source: 'openalex' }],
  }
}

test('/events 的 sinceRev 只返回增量下载指令，且按到达顺序排列', () => {
  const events = new TaskEvents()
  events.publishDownload(command('c1'))
  events.publish(summary('t1'))
  events.publishDownload(command('c2'))

  const first = events.since(0)
  assert.equal(first.rev, 3)
  assert.deepEqual(
    first.downloads?.map((item) => item.commandId),
    ['c1', 'c2'],
  )
  assert.deepEqual(
    first.tasks.map((item) => item.id),
    ['t1'],
  )

  assert.deepEqual(events.since(3).downloads, [])
  events.publishDownload(command('c3'))
  assert.deepEqual(
    events.since(3).downloads?.map((item) => item.commandId),
    ['c3'],
  )
})

test('连发两条下载指令不会像 focus 那样互相覆盖', () => {
  const events = new TaskEvents()
  events.publishDownload(command('c1'))
  events.publishDownload(command('c2'))
  assert.equal(events.since(0).downloads?.length, 2)
})

test('宿主重启（reset）时不重放历史下载指令', () => {
  const events = new TaskEvents()
  events.publishDownload(command('c1'))
  const page = events.since(999)
  assert.equal(page.reset, true)
  assert.deepEqual(page.downloads, [])
})

test('日志按上限裁剪最旧指令，remove(taskId) 清掉该任务的指令', () => {
  const events = new TaskEvents()
  for (let index = 0; index < 55; index += 1) {
    events.publishDownload(command(`c${index}`, index % 2 === 0 ? 't1' : 't2'))
  }
  const before = events.since(0)
  assert.equal(before.downloads?.length, 50)
  assert.equal(before.downloads?.[0].commandId, 'c5')

  events.remove('t1')
  const after = events.since(0)
  assert.equal(after.downloads?.some((item) => item.taskId === 't1'), false)
  assert.ok((after.downloads?.length ?? 0) > 0)
})
