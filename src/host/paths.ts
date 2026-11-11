/**
 * 插件数据目录解析与旧版数据迁移。
 *
 * 平台约定：插件私有数据统一放在 `$DSH_HOME/storages/<plugin-id>/`，
 * `DSH_HOME` 由宿主注入，未设置时回落 `~/.dsh`。本插件历史版本把数据直接
 * 写在 `~/.dsh/dsh-litsearch/`，这里负责一次性搬迁到统一存储区：
 *
 * - 只复制、不删除，旧目录原样保留作备份；
 * - 不覆盖新目录里已有的文件，重复启动不会反复迁移；
 * - 复制失败或校验不通过时回退到旧目录读取，保证任务标注不丢。
 *
 * PDF 的可读文件由设置项 `pdfRoot` 决定（默认 `~/Downloads/dsh-litsearch`），
 * 不受本模块影响；只有插件内部的去重缓存 `<root>/pdfs` 随数据目录一起搬迁。
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const PLUGIN_ID = 'dsh-plugin-litsearch'

/** 历史版本使用的目录名（`$DSH_HOME` 下的一级目录）。 */
export const LEGACY_DIR = 'dsh-litsearch'

/** 允许搬迁的条目：任务正文与索引、导出文件、PDF 去重缓存、当前任务快照。 */
const MIGRATABLE_ENTRIES = ['tasks', 'out', 'pdfs', 'current.json'] as const

/** 解析宿主数据根目录；支持绝对路径、`~/...` 与空值回落。 */
export function dshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME?.trim() ?? ''
  if (raw === '') return join(home, '.dsh')
  if (raw === '~') return home
  if (raw.startsWith('~/')) return join(home, raw.slice(2))
  // 绝对路径原样规范化，相对路径按进程工作目录解析（与宿主 path.resolve 一致）。
  return resolve(raw)
}

/** 当前数据根目录：平台统一存储区下的插件域。 */
export function storageRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(dshHome(env, home), 'storages', PLUGIN_ID)
}

/** 旧数据根目录候选，按优先级排列，已排除新根目录。 */
export function legacyRoots(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const current = storageRoot(env, home)
  const candidates = [
    join(dshHome(env, home), LEGACY_DIR), // 过渡形态：$DSH_HOME/dsh-litsearch
    join(home, '.dsh', LEGACY_DIR), // 历史硬编码：~/.dsh/dsh-litsearch
  ]
  return [...new Set(candidates)].filter((path) => path !== current)
}

/** 目录里是否存在至少一个任务正文文件（索引与快照不算）。 */
export async function hasTaskFiles(root: string): Promise<boolean> {
  const names = await readdir(join(root, 'tasks')).catch(() => [])
  return names.some((name) => name.endsWith('.json') && name !== 'index.json')
}

export interface StorageResolution {
  /** 最终使用的数据根目录。 */
  root: string
  /** 本次复制的文件数。 */
  copied: number
  /** 从该旧目录迁移成功。 */
  migratedFrom?: string
  /** 迁移失败，暂时回退到该旧目录读取。 */
  fallbackFrom?: string
}

/**
 * 决定最终数据根目录，并在必要时做一次性迁移：
 *
 * 1. 新目录已有任务 → 直接使用，绝不碰旧数据；
 * 2. 新目录为空且旧目录有任务 → 复制缺失文件到新目录，旧目录保留；
 * 3. 复制失败或复制后仍无任务 → 回滚本次副本并回退到旧目录读取。
 */
export async function resolveStorageRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<StorageResolution> {
  const root = storageRoot(env, home)
  if (await hasTaskFiles(root)) return { root, copied: 0 }

  for (const legacy of legacyRoots(env, home)) {
    if (!(await hasTaskFiles(legacy))) continue
    const copied: string[] = []
    try {
      await copyLegacyStorage(legacy, root, copied)
      if (await hasTaskFiles(root)) {
        console.info(
          `[dsh-plugin-litsearch] 任务数据已迁移：${legacy} → ${root}（${copied.length} 个文件，原目录保留）`,
        )
        return { root, migratedFrom: legacy, copied: copied.length }
      }
      await rollback(copied)
    } catch (error) {
      await rollback(copied)
      console.warn('[dsh-plugin-litsearch] 任务数据迁移失败：', error)
    }
    console.warn(`[dsh-plugin-litsearch] 暂时沿用旧任务目录：${legacy}`)
    return { root: legacy, fallbackFrom: legacy, copied: 0 }
  }
  return { root, copied: 0 }
}

/** 复制旧目录里的已知条目；目标已存在则跳过，复制路径写入 `copied` 供回滚。 */
async function copyLegacyStorage(from: string, to: string, copied: string[]): Promise<void> {
  for (const entry of MIGRATABLE_ENTRIES) {
    const source = join(from, entry)
    const target = join(to, entry)
    const info = await stat(source).catch(() => null)
    if (info === null) continue
    if (info.isFile()) {
      await copyFileIfAbsent(source, target, copied)
    } else if (info.isDirectory()) {
      await copyDirIfAbsent(source, target, copied)
    }
  }
}

async function copyDirIfAbsent(source: string, target: string, copied: string[]): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    // 跳过原子写残留的临时文件与系统杂项。
    if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      await copyDirIfAbsent(from, to, copied)
    } else if (entry.isFile()) {
      await copyFileIfAbsent(from, to, copied)
    }
  }
}

async function copyFileIfAbsent(source: string, target: string, copied: string[]): Promise<void> {
  if ((await stat(target).catch(() => null)) !== null) return
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  copied.push(target)
}

/** 迁移未完成时清掉本次副本，让下次启动可以重新迁移（源文件始终不动）。 */
async function rollback(files: readonly string[]): Promise<void> {
  for (const file of files) await rm(file, { force: true }).catch(() => {})
}
