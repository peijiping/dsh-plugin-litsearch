/**
 * PubTator3 实体标注读取。
 *
 * 搜索接口只给命中，标注需要按 PMID 单独取 BioC JSON。解析见
 * {@link parsePubtatorEntities}，这里只负责请求与限流。
 */

import { parsePubtatorEntities } from './pubtator-parse.js'
import { limitedJson } from './rate-limit.js'
import type { PaperEntity } from './types.js'

const ENDPOINT = 'https://www.ncbi.nlm.nih.gov/research/pubtator3-api/publications/export/biocjson'

/** 按 PMID 读取实体标注；请求走 PubTator 的共享限流队列。 */
export async function fetchPubtatorEntities(
  pmid: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PaperEntity[]> {
  const url = `${ENDPOINT}?pmids=${encodeURIComponent(pmid)}`
  const payload = await limitedJson('pubtator', url, {
    timeoutMs,
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
  return parsePubtatorEntities(payload)
}
