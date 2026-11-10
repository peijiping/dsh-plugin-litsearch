/** PubTator BioC JSON 的纯解析部分（不依赖网络与限流，便于单测）。 */

import type { PaperEntity } from './types.js'

const MAX_ENTITIES = 300

export function parsePubtatorEntities(payload: unknown): PaperEntity[] {
  const docs = asArray(asRecord(payload)['PubTator3'])
  const seen = new Map<string, PaperEntity>()
  for (const doc of docs) {
    for (const passage of asArray(asRecord(doc)['passages'])) {
      for (const raw of asArray(asRecord(passage)['annotations'])) {
        const annotation = asRecord(raw)
        const infons = asRecord(annotation['infons'])
        const text = asString(annotation['text']).trim()
        if (text === '') continue
        const type = asString(infons['type']) || 'Entity'
        const identifier = asString(infons['identifier'])
        const database = asString(infons['database'])
        const name = asString(infons['name'])
        const key = `${type}\u0000${identifier}\u0000${text.toLowerCase()}`
        const existing = seen.get(key)
        if (existing !== undefined) {
          existing.count += 1
          continue
        }
        if (seen.size >= MAX_ENTITIES) continue
        seen.set(key, { text, type, identifier, database, name, count: 1 })
      }
    }
  }
  return [...seen.values()]
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
