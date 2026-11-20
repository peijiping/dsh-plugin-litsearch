/**
 * PDF 下载目录的纯路径计算。
 *
 * 优先级：显式配置 `pdfRoot` → 会话工作目录下的 `dsh-litsearch/` →
 * 历史默认 `~/Downloads/dsh-litsearch`。保持无相对导入，便于单测直接加载。
 */

import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** 工作目录（或 Downloads）下的固定子目录名。 */
export const PDF_SUBDIR = 'dsh-litsearch'

/** 展开 `~` / `~/...`；其它路径原样返回。 */
export function expandHomePath(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

export function resolvePdfRootPath(
  configured: string,
  workspace: string | undefined,
  home: string = homedir(),
): string {
  const custom = configured.trim()
  if (custom !== '') return expandHomePath(custom, home)
  const base = workspace?.trim() ?? ''
  if (base !== '') return join(base, PDF_SUBDIR)
  return join(home, 'Downloads', PDF_SUBDIR)
}

/**
 * 用户/模型显式指定的下载目录：展开 `~` 后必须是绝对路径。
 *
 * 空白或相对路径返回 null，由调用方报 `bad_request`；不在此处静默回落默认值，
 * 避免「用户以为下到了 A 目录，其实落回了默认目录」。
 */
export function resolveDownloadDir(input: string, home: string = homedir()): string | null {
  const raw = input.trim()
  if (raw === '') return null
  const expanded = expandHomePath(raw, home)
  return isAbsolute(expanded) ? expanded : null
}

/** 文件是否直接/间接位于该目录下（用于「已在该目录则跳过下载」）。 */
export function isFileInDir(filePath: string, dir: string): boolean {
  const file = resolve(filePath)
  const base = resolve(dir)
  if (file === base) return false
  const rel = relative(base, file)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
