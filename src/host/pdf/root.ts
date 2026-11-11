/**
 * PDF 下载目录的纯路径计算。
 *
 * 优先级：显式配置 `pdfRoot` → 会话工作目录下的 `dsh-litsearch/` →
 * 历史默认 `~/Downloads/dsh-litsearch`。保持无相对导入，便于单测直接加载。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

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
