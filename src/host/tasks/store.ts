/**
 * 任务持久化：`<root>/tasks/<id>.json` + `tasks/index.json`。
 *
 * - 数据根目录为 `$DSH_HOME/storages/dsh-plugin-litsearch`（见 `host/paths.ts`），
 *   加载时若新目录为空而旧目录有任务，会一次性复制过来；显式传入 root 时不迁移；
 * - 写盘全部串行执行，先写临时文件再 rename，避免半截 JSON；
 * - 内存里只保留摘要，任务正文按需从磁盘读；
 * - 落盘保留已获取的完整论文摘要，任务数按保留策略裁剪。
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { SearchError } from '../../search/errors.js'
import type { Paper, SearchTask, TaskSummary } from '../../search/types.js'
import { resolveStorageRoot, storageRoot } from '../paths.js'
import { roundsOf, toSummary, trimRounds } from './summary.js'
import { clearInvalidSupplementOrigins } from './supplements.js'

const INDEX_VERSION = 1
const TASK_FILE_VERSION = 2
// 旧版会取前 800 个 UTF-16 码元，再追加一个省略号。
const LEGACY_ABSTRACT_LIMIT = 800

interface IndexFile {
  version: number
  tasks: TaskSummary[]
}

export interface RetentionOptions {
  retentionDays: number
  retentionCount: number
}

/** 「当前任务」快照：最近一次使用或打开的任务。 */
export interface CurrentTaskSnapshot {
  version: number
  current?: { taskId: string; at: number }
}

export class TaskStore {
  root: string

  private tasksDir: string

  private indexFile: string

  private currentFile: string

  private readonly summaries = new Map<string, TaskSummary>()

  private readonly cache = new Map<string, SearchTask>()

  private chain: Promise<void> = Promise.resolve()

  private retention: RetentionOptions = { retentionDays: 90, retentionCount: 120 }

  /** 只有使用默认（平台统一）目录时才做旧数据迁移；显式 root 多用于测试。 */
  private readonly migrateOnLoad: boolean

  /** 迁移过来的任务文件必须重建索引，避免沿用旧目录里那份空 index.json。 */
  private forceRebuildIndex = false

  constructor(root?: string) {
    this.migrateOnLoad = root === undefined
    this.root = root ?? storageRoot()
    this.tasksDir = join(this.root, 'tasks')
    this.indexFile = join(this.tasksDir, 'index.json')
    this.currentFile = join(this.root, 'current.json')
  }

  async load(retention: RetentionOptions): Promise<void> {
    this.retention = retention
    if (this.migrateOnLoad) {
      try {
        const resolution = await resolveStorageRoot()
        this.rebind(resolution.root)
        // 复制过来的 index.json 可能不含新任务，强制按任务文件重建一次。
        this.forceRebuildIndex = resolution.migratedFrom !== undefined
      } catch (error) {
        // 目录解析失败不应阻断任务系统启动，继续用构造时的默认目录。
        console.warn('[dsh-plugin-litsearch] 数据目录解析失败，沿用默认目录：', error)
      }
    }
    await mkdir(this.tasksDir, { recursive: true })
    const index = this.forceRebuildIndex ? null : await this.readIndex()
    if (index === null) {
      await this.rebuildIndex()
    } else {
      for (const summary of index.tasks) this.summaries.set(summary.id, summary)
    }
    await this.prune()
  }

  list(): TaskSummary[] {
    return [...this.summaries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  summary(id: string): TaskSummary | undefined {
    return this.summaries.get(id)
  }

  /** 同步取已缓存任务；未加载时返回 undefined。 */
  cached(id: string): SearchTask | undefined {
    return this.cache.get(id)
  }

  async loadTask(id: string): Promise<SearchTask | undefined> {
    const cached = this.cache.get(id)
    if (cached !== undefined) return cached
    if (this.summaries.get(id) === undefined) return undefined
    try {
      const text = await readFile(this.taskFile(id), 'utf8')
      const parsed = JSON.parse(text) as { version?: number; task?: SearchTask }
      if (parsed.task === undefined) throw new Error('缺少任务正文')
      // 旧版本任务文件没有 rounds；统一补齐并裁掉超限轮次，避免历史无限增长。
      parsed.task.rounds = trimRounds(roundsOf(parsed.task))
      if (parsed.version === undefined || parsed.version === 1) {
        for (const paper of parsed.task.result.papers) {
          if (mayHaveLegacyTruncation(paper)) paper.abstractCompleteness = 'unknown'
        }
      }
      const loaded = this.cache.get(id)
      if (loaded !== undefined) return loaded
      if (!this.summaries.has(id)) return undefined
      if (clearInvalidSupplementOrigins(parsed.task)) {
        this.put(parsed.task)
      } else {
        this.cache.set(id, parsed.task)
      }
      return parsed.task
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        await this.remove(id)
        return undefined
      }
      throw new SearchError('upstream_error', '无法读取任务文件，原文件已保留，请检查数据目录')
    }
  }

  put(task: SearchTask): void {
    this.cache.set(task.id, task)
    this.summaries.set(task.id, toSummary(task))
  }

  async save(task: SearchTask, requirePersistence = false): Promise<void> {
    // 运行中的任务可能被用户删除：删除后的迟到落盘会重建文件与索引，这里直接丢弃。
    if (!this.summaries.has(task.id)) {
      if (requirePersistence) throw new Error('任务已删除，无法保存')
      return
    }
    this.put(task)
    const file = this.taskFile(task.id)
    const body = JSON.stringify({
      version: TASK_FILE_VERSION,
      task: { ...task, rounds: trimRounds(roundsOf(task)) },
    })
    await this.enqueue(async () => {
      await atomicWrite(file, body)
      await this.writeIndex()
    }, requirePersistence)
  }

  async remove(id: string): Promise<void> {
    this.cache.delete(id)
    this.summaries.delete(id)
    await this.enqueue(async () => {
      await rm(this.taskFile(id), { force: true })
      await this.writeIndex()
    })
  }

  async flush(): Promise<void> {
    await this.chain
  }

  /** 读取「当前任务」快照；文件缺失或损坏时返回 null（由调用方自举）。 */
  async loadCurrent(): Promise<CurrentTaskSnapshot | null> {
    try {
      const parsed = JSON.parse(await readFile(this.currentFile, 'utf8')) as Partial<CurrentTaskSnapshot>
      const current = readBinding(parsed.current)
      return { version: INDEX_VERSION, ...(current === undefined ? {} : { current }) }
    } catch {
      return null
    }
  }

  async saveCurrent(snapshot: CurrentTaskSnapshot): Promise<void> {
    const body = JSON.stringify(snapshot)
    await this.enqueue(async () => {
      await atomicWrite(this.currentFile, body)
    })
  }

  /** 手动清理：删除所有未保留任务，返回条数与释放的字节数。 */
  async cleanupUnpinned(): Promise<{ removed: number; freedBytes: number }> {
    const targets = this.list().filter((summary) => !summary.pinned)
    let freedBytes = 0
    for (const summary of targets) {
      try {
        freedBytes += (await stat(this.taskFile(summary.id))).size
      } catch {
        // 文件已丢失时仍继续移除索引项。
      }
      await this.remove(summary.id)
    }
    return { removed: targets.length, freedBytes }
  }

  /** 迁移回退时切回旧目录读取，所有派生路径（含设置页展示）同步更新。 */
  private rebind(root: string): void {
    if (root === this.root) return
    this.root = root
    this.tasksDir = join(root, 'tasks')
    this.indexFile = join(this.tasksDir, 'index.json')
    this.currentFile = join(root, 'current.json')
  }

  private taskFile(id: string): string {
    return join(this.tasksDir, `${id}.json`)
  }

  private async readIndex(): Promise<IndexFile | null> {
    try {
      const parsed = JSON.parse(await readFile(this.indexFile, 'utf8')) as Partial<IndexFile>
      if (!Array.isArray(parsed.tasks)) return null
      return { version: INDEX_VERSION, tasks: parsed.tasks }
    } catch {
      return null
    }
  }

  /** 索引缺失/损坏时按任务文件重建（只读头部，不长期占内存）。 */
  private async rebuildIndex(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.tasksDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') continue
      const id = name.slice(0, -'.json'.length)
      if (this.summaries.has(id)) continue
      try {
        const parsed = JSON.parse(await readFile(join(this.tasksDir, name), 'utf8')) as {
          task?: SearchTask
        }
        if (parsed.task !== undefined) this.summaries.set(parsed.task.id, toSummary(parsed.task))
      } catch {
        // 损坏的任务文件直接跳过，索引里不再保留它。
      }
    }
    await this.writeIndex()
  }

  private async prune(): Promise<void> {
    const now = Date.now()
    let kept = 0
    const expire: string[] = []
    for (const summary of this.list()) {
      if (summary.pinned) continue
      const ageDays = (now - Date.parse(summary.updatedAt)) / 86_400_000
      if (kept >= this.retention.retentionCount || ageDays > this.retention.retentionDays) {
        expire.push(summary.id)
      } else {
        kept += 1
      }
    }
    for (const id of expire) await this.remove(id)
  }

  private async writeIndex(): Promise<void> {
    const index: IndexFile = { version: INDEX_VERSION, tasks: this.list() }
    await atomicWrite(this.indexFile, JSON.stringify(index))
  }

  private enqueue(operation: () => Promise<void>, requirePersistence = false): Promise<void> {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch((error: unknown) => {
      console.warn('[dsh-plugin-litsearch] 任务写盘失败：', error)
    })
    return requirePersistence ? next : this.chain
  }
}

async function atomicWrite(file: string, body: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, body, 'utf8')
  await rename(temp, file)
}

function readBinding(value: unknown): { taskId: string; at: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as { taskId?: unknown; at?: unknown }
  if (typeof record.taskId !== 'string' || record.taskId === '') return undefined
  return { taskId: record.taskId, at: typeof record.at === 'number' ? record.at : 0 }
}

function mayHaveLegacyTruncation(paper: Paper): boolean {
  return paper.abstract.length === LEGACY_ABSTRACT_LIMIT + 1 && paper.abstract.endsWith('…')
}
