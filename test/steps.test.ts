/**
 * 检索步骤进度的回归测试。
 *
 * 只 import 纯逻辑（steps.ts，仅依赖 type-only import），不依赖 lib 产物、
 * 网络或带 .js 后缀的运行时模块，`node --test` 可直接跑源码。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSteps, finalizeSteps } from '../src/host/tasks/steps.ts'

const QUERIES = [
  { name: '疗效', text: 'halitosis treatment' },
  { name: '', text: 'periodontitis' },
]

test('buildSteps 生成 N×(1+S)+1 个稳定 id 的步骤', () => {
  const steps = buildSteps(QUERIES, ['pubmed', 'openalex'])
  // 2 式 × (1 分组 + 2 源) + 1 去重 = 7
  assert.equal(steps.length, 7)
  assert.deepEqual(
    steps.map((step) => step.id),
    [
      'q1', 'q1:pubmed', 'q1:openalex',
      'q2', 'q2:pubmed', 'q2:openalex',
      'dedup',
    ],
  )
  assert.ok(steps.every((step) => step.status === 'pending'))
  assert.equal(steps[0].label, '疗效')
  assert.equal(steps[3].label, 'periodontitis') // 无 name 回退 text
  assert.equal(steps[6].kind, 'dedup')
  assert.deepEqual(steps[1].source, 'pubmed')
})

test('buildSteps 空源时只剩分组与去重', () => {
  const steps = buildSteps([QUERIES[0]], [])
  assert.deepEqual(steps.map((step) => step.id), ['q1', 'dedup'])
})

test('finalizeSteps 取消时把所有未完步骤标为 skipped', () => {
  const steps = buildSteps([QUERIES[0]], ['pubmed', 'openalex'])
  steps[0].status = 'done'
  steps[1].status = 'running'
  steps[2].status = 'done'

  finalizeSteps(steps, 'canceled', '检索已取消')

  assert.equal(steps[0].status, 'done') // 已完成的不回退
  assert.equal(steps[1].status, 'skipped')
  assert.equal(steps[1].error, '检索已取消')
  assert.equal(steps[2].status, 'done')
  assert.equal(steps[3].status, 'skipped') // dedup
})

test('finalizeSteps 异常时 running 标 failed、pending 标 skipped', () => {
  const steps = buildSteps([QUERIES[0]], ['pubmed'])
  steps[1].status = 'running'

  finalizeSteps(steps, 'error', '上游超时')

  assert.equal(steps[1].status, 'failed')
  assert.equal(steps[1].error, '上游超时')
  assert.equal(steps[0].status, 'skipped') // 分组步骤仍 pending
  assert.equal(steps[2].status, 'skipped')
})

test('步骤状态流转：源查询中 → 完成，去重中 → 完成', () => {
  const steps = buildSteps([QUERIES[0]], ['pubmed', 'openalex'])

  steps[0].status = 'running'
  steps[1].status = 'running'
  assert.equal(steps.filter((step) => step.status === 'running').length, 2)

  steps[1].status = 'done'
  steps[1].count = 12
  steps[2].status = 'skipped'
  steps[0].status = 'done'
  steps[0].count = 12
  steps[3].status = 'running'
  assert.equal(steps[3].id, 'dedup')

  steps[3].status = 'done'
  steps[3].count = 9
  assert.deepEqual(
    steps.map((step) => step.status),
    ['done', 'done', 'skipped', 'done'],
  )
  assert.equal(steps[3].count, 9)
})
