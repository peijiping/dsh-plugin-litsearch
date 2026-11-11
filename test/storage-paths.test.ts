/**
 * 数据目录解析与旧版数据迁移的回归测试。
 *
 * 只 import `paths.ts` 的纯 Node 逻辑（不依赖 lib/ 构建产物），
 * 全部在临时目录里进行，不触碰真实 `~/.dsh`。
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LEGACY_DIR,
  PLUGIN_ID,
  dshHome,
  hasTaskFiles,
  legacyRoots,
  resolveStorageRoot,
  storageRoot,
} from '../src/host/paths.ts'

const HOME = '/tmp/litsearch-fake-home'

async function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'litsearch-paths-'))
}

/** 屏蔽迁移日志，保持测试输出干净。 */
async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const info = console.info
  const warn = console.warn
  console.info = (): void => {}
  console.warn = (): void => {}
  try {
    return await run()
  } finally {
    console.info = info
    console.warn = warn
  }
}

/** 造一个完整的旧目录：任务、索引、快照、导出、PDF 缓存。 */
async function seedLegacy(legacy: string): Promise<void> {
  await mkdir(join(legacy, 'tasks'), { recursive: true })
  await mkdir(join(legacy, 'out', 't1'), { recursive: true })
  await mkdir(join(legacy, 'pdfs'), { recursive: true })
  await writeFile(join(legacy, 'tasks', 't1.json'), JSON.stringify({ version: 1, task: { id: 't1' } }))
  await writeFile(join(legacy, 'tasks', 'index.json'), JSON.stringify({ version: 1, tasks: [] }))
  await writeFile(join(legacy, 'current.json'), JSON.stringify({ version: 1, current: { taskId: 't1', at: 1 } }))
  await writeFile(join(legacy, 'out', 't1', 'result.csv'), 'title,doi\n')
  await writeFile(join(legacy, 'pdfs', 'abc.pdf'), '%PDF-1.4')
}

test('dshHome：未设置回落 ~/.dsh，支持绝对路径与 ~ 展开', () => {
  assert.equal(dshHome({}, HOME), join(HOME, '.dsh'))
  assert.equal(dshHome({ DSH_HOME: '   ' }, HOME), join(HOME, '.dsh'))
  assert.equal(dshHome({ DSH_HOME: '/var/dsh-home' }, HOME), '/var/dsh-home')
  assert.equal(dshHome({ DSH_HOME: '~/custom' }, HOME), join(HOME, 'custom'))
  assert.equal(dshHome({ DSH_HOME: '~' }, HOME), HOME)
})

test('storageRoot：跟随 DSH_HOME 且落在 storages/<plugin-id>', () => {
  assert.equal(storageRoot({}, HOME), join(HOME, '.dsh', 'storages', PLUGIN_ID))
  const custom = '/var/dsh-home'
  assert.equal(storageRoot({ DSH_HOME: custom }, HOME), join(custom, 'storages', PLUGIN_ID))
})

test('legacyRoots：去重、排除新目录、自定义 home 时保留两个候选', () => {
  assert.deepEqual(legacyRoots({}, HOME), [join(HOME, '.dsh', LEGACY_DIR)])
  const custom = join(HOME, 'custom-home')
  assert.deepEqual(legacyRoots({ DSH_HOME: custom }, HOME), [
    join(custom, LEGACY_DIR),
    join(HOME, '.dsh', LEGACY_DIR),
  ])
})

test('hasTaskFiles：只认任务正文，不把 index.json 当任务', async () => {
  const home = await makeHome()
  try {
    const root = join(home, 'root')
    await mkdir(join(root, 'tasks'), { recursive: true })
    await writeFile(join(root, 'tasks', 'index.json'), '{"version":1,"tasks":[]}')
    assert.equal(await hasTaskFiles(root), false)
    await writeFile(join(root, 'tasks', 't1.json'), '{}')
    assert.equal(await hasTaskFiles(root), true)
    assert.equal(await hasTaskFiles(join(home, 'missing')), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('首次启动：复制旧目录全部已知条目，源目录保留，再次启动不再迁移', async () => {
  const home = await makeHome()
  try {
    const env: NodeJS.ProcessEnv = { DSH_HOME: join(home, 'custom-home') }
    const legacy = join(home, '.dsh', LEGACY_DIR)
    await seedLegacy(legacy)
    const target = storageRoot(env, home)

    const first = await quiet(() => resolveStorageRoot(env, home))
    assert.equal(first.root, target)
    assert.equal(first.migratedFrom, legacy)
    assert.equal(first.copied, 5)
    assert.equal(await hasTaskFiles(target), true)

    const files = [
      ['tasks', 't1.json'],
      ['tasks', 'index.json'],
      ['current.json'],
      ['out', 't1', 'result.csv'],
      ['pdfs', 'abc.pdf'],
    ]
    for (const parts of files) {
      const from = join(legacy, ...parts)
      const to = join(target, ...parts)
      assert.deepEqual(await readFile(to), await readFile(from), `应复制 ${parts.join('/')}`)
      // 源目录必须原样保留作备份（大小一致且仍可读）。
      assert.equal((await stat(from)).size, (await stat(to)).size)
    }

    const second = await quiet(() => resolveStorageRoot(env, home))
    assert.equal(second.root, target)
    assert.equal(second.copied, 0)
    assert.equal(second.migratedFrom, undefined)
    assert.equal(second.fallbackFrom, undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('新目录已有任务时不迁移，也不把旧任务补进来', async () => {
  const home = await makeHome()
  try {
    const env: NodeJS.ProcessEnv = { DSH_HOME: join(home, 'custom-home') }
    const target = storageRoot(env, home)
    const legacy = legacyRoots(env, home)[0]
    await mkdir(join(target, 'tasks'), { recursive: true })
    await writeFile(join(target, 'tasks', 'fresh.json'), '{"version":1}')
    await seedLegacy(legacy)

    const resolution = await quiet(() => resolveStorageRoot(env, home))
    assert.equal(resolution.root, target)
    assert.equal(resolution.copied, 0)
    assert.equal(resolution.migratedFrom, undefined)
    const names = await readdir(join(target, 'tasks'))
    assert.deepEqual(names.sort(), ['fresh.json'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('新旧目录都为空时直接使用新目录', async () => {
  const home = await makeHome()
  try {
    const env: NodeJS.ProcessEnv = { DSH_HOME: join(home, 'custom-home') }
    const resolution = await quiet(() => resolveStorageRoot(env, home))
    assert.equal(resolution.root, storageRoot(env, home))
    assert.equal(resolution.copied, 0)
    assert.equal(resolution.fallbackFrom, undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('迁移失败：回滚副本并回退到旧目录读取', async () => {
  const home = await makeHome()
  try {
    const custom = join(home, 'custom-home')
    const env: NodeJS.ProcessEnv = { DSH_HOME: custom }
    const legacy = join(custom, LEGACY_DIR)
    await seedLegacy(legacy)
    // 让 storages 变成一个文件，复制目标路径必然无法创建。
    await writeFile(join(custom, 'storages'), 'blocked')

    const resolution = await quiet(() => resolveStorageRoot(env, home))
    assert.equal(resolution.root, legacy)
    assert.equal(resolution.fallbackFrom, legacy)
    assert.equal(resolution.copied, 0)
    assert.equal(await hasTaskFiles(legacy), true)
    assert.equal(await readFile(join(legacy, 'tasks', 't1.json'), 'utf8'), '{"version":1,"task":{"id":"t1"}}')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
