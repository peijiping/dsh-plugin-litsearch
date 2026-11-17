/**
 * NCBI E-utilities 公共层：请求参数与错误识别。
 *
 * ESearch / EFetch / ELink 共用同一套 tool/email/api_key 与限流响应格式。
 */

import { NCBI_CONTACT_EMAIL } from './config.js'
import { SearchError } from './errors.js'
import { asRecord, asString } from './normalize.js'

export const NCBI_EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
export const NCBI_TOOL = 'dsh-plugin-litsearch'

export interface EutilsAuth {
  contactEmail: string
  ncbiApiKey?: string | undefined
}

export function eutilsParams(auth: EutilsAuth): URLSearchParams {
  const params = new URLSearchParams({ tool: NCBI_TOOL })
  params.set('email', auth.contactEmail !== '' ? auth.contactEmail : NCBI_CONTACT_EMAIL)
  if (auth.ncbiApiKey !== undefined && auth.ncbiApiKey !== '') {
    params.set('api_key', auth.ncbiApiKey)
  }
  return params
}

/**
 * E-utilities 超限时可能返回 HTTP 200 + `{"error":"API rate limit exceeded"}`。
 * 必须识别成 429，交给限流队列冷却与退避，避免被当成「0 条结果」。
 */
export function throwIfUpstreamError(payload: unknown, service = 'PubMed'): void {
  const message = asString(asRecord(payload)['error'])
  if (message === '') return
  if (/rate limit/iu.test(message)) {
    throw new SearchError('upstream_error', `${service} 触发 E-utilities 限流：${message}`, {
      status: 429,
    })
  }
  throw new SearchError('upstream_error', `${service} 返回错误：${message}`)
}

/** EFetch 正常返回 XML；只有错误响应才会是 JSON 对象。 */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}
