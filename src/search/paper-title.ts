import { decodeEntities } from './xml.js'

/** Europe PMC core responses can contain literal or escaped JATS/HTML formatting. */
export function europePmcTitle(value: string): string {
  return decodeEntities(value)
    .replace(
      /<\/?(?:[a-z]+:)?(?:i|b|em|strong|sub|sup|italic|bold|monospace|small|sc|underline)\b(?:\s+[^<>]*)?\s*\/?>/giu,
      '',
    )
    .replace(/\s+/gu, ' ')
    .trim()
}
