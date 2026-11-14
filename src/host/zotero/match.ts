/**
 * 把模型从对话里听到的「存到 xx 目录」匹配到 Zotero connector 的真实目标。
 *
 * 纯函数、只做类型导入：`src` 源码可被 `node --test` 直接加载，Host 构建
 * 产物仍走 `.js`。匹配失败或歧义时绝不猜一个目录就写入数据 —— 同步会真的
 * 往 Zotero 里建条目，猜错代价太高。
 */

import type { ZoteroTarget } from '../../search/types.js'

const MAX_CANDIDATES = 8

export type ZoteroMatch =
  | { kind: 'matched'; target: ZoteroTarget }
  | { kind: 'ambiguous'; candidates: ZoteroTarget[] }
  | { kind: 'none'; candidates: ZoteroTarget[] }

/** 归一化：去首尾空白、合并连续空白（含全角空格）、忽略大小写。 */
function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase()
}

function candidatesOf(targets: readonly ZoteroTarget[]): ZoteroTarget[] {
  // 目录多时优先给用户常看的：最近使用过的排前面，其余保持 connector 原序。
  return [
    ...targets.filter((target) => target.recent === true),
    ...targets.filter((target) => target.recent !== true),
  ].slice(0, MAX_CANDIDATES)
}

/**
 * 匹配顺序：id 精确 → 名称精确（忽略大小写与空白）→ 名称包含。
 *
 * 任何一步命中多个都算歧义，返回候选让模型在对话里向用户确认；只有唯一
 * 命中才返回 `matched`，由工具带上 `autoStart` 让右侧栏直接开跑。
 */
export function matchZoteroTarget(
  targets: readonly ZoteroTarget[],
  query: string,
): ZoteroMatch {
  const needle = normalize(query)
  if (needle === '') return { kind: 'none', candidates: candidatesOf(targets) }

  const byId = targets.filter((target) => target.id.toLowerCase() === needle)
  if (byId.length === 1) return { kind: 'matched', target: byId[0] as ZoteroTarget }
  if (byId.length > 1) return { kind: 'ambiguous', candidates: candidatesOf(byId) }

  const byName = targets.filter((target) => normalize(target.name) === needle)
  if (byName.length === 1) return { kind: 'matched', target: byName[0] as ZoteroTarget }
  if (byName.length > 1) return { kind: 'ambiguous', candidates: candidatesOf(byName) }

  const partial = targets.filter((target) => normalize(target.name).includes(needle))
  if (partial.length === 1) return { kind: 'matched', target: partial[0] as ZoteroTarget }
  if (partial.length > 1) return { kind: 'ambiguous', candidates: candidatesOf(partial) }

  return { kind: 'none', candidates: candidatesOf(targets) }
}

/** 给模型的可用目录清单（工具返回文本里让用户/模型确认用）。 */
export function describeZoteroTargets(
  targets: readonly ZoteroTarget[],
  limit = 12,
): string {
  if (targets.length === 0) return '（Zotero 里没有可用目录）'
  const lines = targets.slice(0, limit).map((target) => {
    const indent = '  '.repeat(Math.max(0, target.level))
    const suffix = target.filesEditable === false ? '（不可写附件）' : ''
    return `- ${indent}${target.name}${suffix}（id: ${target.id}）`
  })
  if (targets.length > limit) lines.push(`- ……还有 ${targets.length - limit} 个目录`)
  return lines.join('\n')
}
