/**
 * 任务持久化：`<root>/tasks/<id>.json` + `tasks/index.json`。
 *
 * - 写盘全部串行执行，先写临时文件再 rename，避免半截 JSON；
 * - 内存里只保留摘要，任务正文按需从磁盘读；
 * - 落盘时摘要截到 {@link MAX_ABSTRACT_CHARS} 字符，任务数按保留策略裁剪。
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { MAX_ABSTRACT_CHARS } from '../../search/config.js'
import type { Paper, SearchTask, TaskSummary } from '../../search/types.js'
import { toSummary } from './summary.js'

const INDEX_VERSION = 1

interface IndexFile {
  version: number
  tasks: TaskSummary[]
}

export interface RetentionOptions {
  retentionDays: number
  retentionCount: number
}

export class TaskStore {
  readonly root: string

  private readonly tasksDir: string

  private readonly indexFile: string

  private readonly summaries = new Map<string, TaskSummary>()

  private readonly cache = new Map<string, SearchTask>()

  private chain: Promise<void> = Promise.resolve()

  private retention: RetentionOptions = { retentionDays: 90, retentionCount: 120 }

  constructor(root = join(homedir(), '.dsh', 'dsh-litsearch')) {
    this.root = root
    this.tasksDir = join(root, 'tasks')
    this.indexFile = join(this.tasksDir, 'index.json')
  }

  async load(retention: RetentionOptions): Promise<void> {
    this.retention = retention
    await mkdir(this.tasksDir, { recursive: true })
    const index = await this.readIndex()
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
      const parsed = JSON.parse(text) as { task?: SearchTask }
      if (parsed.task === undefined) {
        await this.remove(id)
        return undefined
      }
      this.cache.set(id, parsed.task)
      return parsed.task
    } catch {
      await this.remove(id)
      return undefined
    }
  }

  put(task: SearchTask): void {
    this.cache.set(task.id, task)
    this.summaries.set(task.id, toSummary(task))
  }

  async save(task: SearchTask): Promise<void> {
    this.put(task)
    const file = this.taskFile(task.id)
    const body = JSON.stringify({ version: INDEX_VERSION, task: truncateForDisk(task) })
    await this.enqueue(async () => {
      await atomicWrite(file, body)
      await this.writeIndex()
    })
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

  /** 手动清理：删除所有未置顶任务，返回条数与释放的字节数。 */
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

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch((error: unknown) => {
      console.warn('[dsh-plugin-litsearch] 任务写盘失败：', error)
    })
    return this.chain
  }
}

async function atomicWrite(file: string, body: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, body, 'utf8')
  await rename(temp, file)
}

function truncateForDisk(task: SearchTask): SearchTask {
  return {
    ...task,
    conditions: {
      ...task.conditions,
      queries: task.conditions.queries.map((query) => ({ ...query })),
      sources: [...task.conditions.sources],
    },
    groups: task.groups.map((group) => ({ ...group })),
    stats: {
      perQuery: { ...task.stats.perQuery },
      rawHits: task.stats.rawHits,
      deduped: task.stats.deduped,
      screening: { ...task.stats.screening },
    },
    states: { ...task.states },
    result: {
      ...task.result,
      sources: task.result.sources.map((source) => ({ ...source })),
      papers: task.result.papers.map(truncatePaper),
    },
  }
}

function truncatePaper(paper: Paper): Paper {
  return {
    ...paper,
    abstract:
      paper.abstract.length <= MAX_ABSTRACT_CHARS
        ? paper.abstract
        : `${paper.abstract.slice(0, MAX_ABSTRACT_CHARS)}…`,
    hitSources: paper.hitSources.map((hit) => ({ ...hit })),
    matchedQueries: [...paper.matchedQueries],
  }
}
