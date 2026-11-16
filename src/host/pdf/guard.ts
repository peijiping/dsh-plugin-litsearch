/**
 * PDF 字节级校验：不信任 URL 后缀，也不信任 Content-Type。
 *
 * 全部为纯函数，便于单测；判断依据只有字节本身与响应头。
 */

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** 跳过 BOM 与前导空白后必须以 `%PDF-` 开头。 */
export function looksLikePdf(head: Buffer): boolean {
  let start = 0
  if (head.length >= 3 && head.subarray(0, 3).equals(BOM)) start = 3
  while (start < head.length) {
    const byte = head[start]
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      start += 1
      continue
    }
    break
  }
  return head.subarray(start, start + 5).toString('latin1') === '%PDF-'
}

/** 尾部必须同时出现 `%%EOF` 与 `startxref`，否则视为被截断。 */
export function hasPdfTrailer(tail: Buffer): boolean {
  const text = tail.toString('latin1')
  return text.includes('%%EOF') && text.includes('startxref')
}

export type InterstitialKind = 'blocked' | 'paywalled' | 'not_pdf'

const BLOCKED_MARKERS = [
  'just a moment',
  'cf-mitigated',
  'cf-chl',
  'challenge-platform',
  'enable javascript and cookies',
  'checking your browser',
  'verify you are human',
]

const PAYWALL_MARKERS = [
  'sign in',
  'signin',
  'log in',
  'login',
  'purchase',
  'subscribe',
  'subscription',
  'access denied',
  'institutional access',
  'get access',
  'rent this article',
]

/**
 * 把「返回了 HTML」进一步分类成可行动的原因。
 *
 * 先判订阅/登录，再判人机验证，最后兜底 `not_pdf`——顺序反了会把
 * 付费墙统一报成「机器人拦截」，用户就不知道该去登录。
 */
export function classifyHtmlInterstitial(
  head: string,
  contentType: string,
  headers?: { get(name: string): string | null },
): InterstitialKind {
  const text = head.toLowerCase()
  const ctype = contentType.toLowerCase()
  const looksHtml = /^\s*(?:<!doctype|<html|<\?xml)/iu.test(head) || ctype.includes('text/html')
  if (!looksHtml) return 'not_pdf'

  if (PAYWALL_MARKERS.some((marker) => text.includes(marker))) return 'paywalled'

  const server = (headers?.get('server') ?? '').toLowerCase()
  const hasCfRay = (headers?.get('cf-ray') ?? '') !== ''
  if (hasCfRay || server.includes('cloudflare')) return 'blocked'
  if (BLOCKED_MARKERS.some((marker) => text.includes(marker))) return 'blocked'
  return 'not_pdf'
}

const LOGIN_HOST_PREFIXES = ['login.', 'idp.', 'sso.', 'auth.', 'shibboleth.']
const LOGIN_PATH_PATTERN = /(?:^|\/)(?:login|signin|sign-in|sso|shibboleth|auth)(?:\/|$)/iu

/** 重定向目标是登录/机构认证页时，继续跟只会拿到 HTML，直接判订阅受限。 */
export function isLoginRedirect(target: URL): boolean {
  const host = target.hostname.toLowerCase()
  if (LOGIN_HOST_PREFIXES.some((prefix) => host.startsWith(prefix))) return true
  return LOGIN_PATH_PATTERN.test(target.pathname)
}
