import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DOWNLOAD_WINDOW_MS,
  isCommandFor,
  isFreshDownload,
  markConsumed,
  peekPendingDownloads,
  publishDownloadCommands,
} from '../src/client/downloadCommandStore.ts'
import type { DownloadCommand } from '../src/search/types.ts'

let seq = 0

function command(overrides: Partial<DownloadCommand> = {}): DownloadCommand {
  seq += 1
  return {
    commandId: `store-${seq}`,
    taskId: 't1',
    at: Date.now(),
    origin: 'model',
    reason: '测试',
    scopeLabel: '测试范围 · 共 1 篇',
    paperIds: ['p1'],
    items: [{ paperId: 'p1', title: 'Title', source: 'openalex' }],
    ...overrides,
  }
}

function drain(): void {
  for (const item of peekPendingDownloads()) markConsumed(item.commandId)
}

test('isFreshDownload 只接受 10 分钟窗口内的指令', () => {
  const now = 1_700_000_000_000
  const fresh = command({ at: now })
  assert.equal(isFreshDownload(fresh, now), true)
  assert.equal(isFreshDownload(fresh, now + DOWNLOAD_WINDOW_MS - 1), true)
  assert.equal(isFreshDownload(fresh, now + DOWNLOAD_WINDOW_MS + 1), false)
  // 客户端时钟明显快于 Host 时也不接受。
  assert.equal(isFreshDownload(command({ at: now + 120_000 }), now), false)
})

test('isCommandFor 按任务与会话隔离', () => {
  const anySession = command()
  assert.equal(isCommandFor(anySession, 't1', 's1'), true)
  assert.equal(isCommandFor(anySession, 't2', 's1'), false)

  const scoped = command({ sessionId: 's1' })
  assert.equal(isCommandFor(scoped, 't1', 's1'), true)
  assert.equal(isCommandFor(scoped, 't1', 's2'), false)
  // 拿不到当前会话 id 时不额外拦截。
  assert.equal(isCommandFor(scoped, 't1', undefined), true)
})

test('publishDownloadCommands 过滤过期 / 别的会话，并按 commandId 幂等', () => {
  drain()
  const fresh = command()
  const stale = command({ at: Date.now() - DOWNLOAD_WINDOW_MS - 1000 })
  const otherSession = command({ sessionId: 'other-session' })

  publishDownloadCommands([fresh, stale, otherSession], 'screen-session')
  const ids = peekPendingDownloads().map((item) => item.commandId)
  assert.ok(ids.includes(fresh.commandId))
  assert.equal(ids.includes(stale.commandId), false)
  assert.equal(ids.includes(otherSession.commandId), false)

  // 同一条指令被重复轮询送到时只入队一次。
  publishDownloadCommands([fresh], 'screen-session')
  assert.equal(
    peekPendingDownloads().filter((item) => item.commandId === fresh.commandId).length,
    1,
  )

  markConsumed(fresh.commandId)
  assert.equal(peekPendingDownloads().some((item) => item.commandId === fresh.commandId), false)
})

test('队列按到达顺序保留，供未挂载的任务 tab 后续消费', () => {
  drain()
  const first = command()
  const second = command()
  publishDownloadCommands([first, second])
  assert.deepEqual(
    peekPendingDownloads().map((item) => item.commandId),
    [first.commandId, second.commandId],
  )
})
