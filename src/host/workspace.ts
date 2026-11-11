/**
 * 会话工作目录解析。
 *
 * DSH 为每个会话保存一个绝对工作目录（SessionHeader.cwd）。PDF 默认落在
 * 该目录下的 `dsh-litsearch/`，让下载物跟随项目而不是散落到 `~/Downloads`。
 * 会话服务由宿主注入；未装配或读不到时返回 undefined，由调用方回落到旧默认。
 */

import { isAbsolute, resolve } from 'node:path'

/** `ctx.sessionPersistence` 中本插件用到的最小结构。 */
export interface SessionStoreLike {
  stat(id: string): Promise<{ header: { cwd?: string } } | undefined>
}

let sessionStore: SessionStoreLike | undefined

export function setSessionStore(store: SessionStoreLike | undefined): void {
  sessionStore = store
}

/** 读取某个会话的工作目录；只接受绝对路径。 */
export async function resolveSessionWorkspace(
  sessionId: string | undefined,
): Promise<string | undefined> {
  const id = sessionId?.trim() ?? ''
  if (id === '' || sessionStore === undefined) return undefined
  try {
    const snapshot = await sessionStore.stat(id)
    return normalizeWorkspace(snapshot?.header.cwd)
  } catch {
    return undefined
  }
}

/** 规范化工作目录：去空白、去尾斜杠，只接受绝对路径。 */
export function normalizeWorkspace(value: string | undefined): string | undefined {
  const path = value?.trim() ?? ''
  if (path === '' || !isAbsolute(path)) return undefined
  return resolve(path)
}
