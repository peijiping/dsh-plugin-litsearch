import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyHtmlInterstitial,
  hasPdfTrailer,
  isLoginRedirect,
  looksLikePdf,
} from '../src/host/pdf/guard.ts'

function headers(values: Record<string, string> = {}): { get(name: string): string | null } {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]))
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null }
}

test('looksLikePdf accepts BOM and leading whitespace but rejects HTML', () => {
  assert.equal(looksLikePdf(Buffer.from('%PDF-1.7\n...', 'latin1')), true)
  assert.equal(looksLikePdf(Buffer.from('\uFEFF  \n%PDF-1.4', 'utf8')), true)
  assert.equal(looksLikePdf(Buffer.from('<!doctype html><html>', 'latin1')), false)
  assert.equal(looksLikePdf(Buffer.from('', 'latin1')), false)
})

test('hasPdfTrailer requires both %%EOF and startxref', () => {
  assert.equal(
    hasPdfTrailer(Buffer.from('xxx startxref 1234\n%%EOF\n', 'latin1')),
    true,
  )
  assert.equal(hasPdfTrailer(Buffer.from('xxx %%EOF\n', 'latin1')), false)
  assert.equal(hasPdfTrailer(Buffer.from('truncated content', 'latin1')), false)
})

test('classifyHtmlInterstitial separates cloudflare, paywall and plain HTML', () => {
  assert.equal(
    classifyHtmlInterstitial('<!DOCTYPE html><html>Just a moment...</html>', 'text/html', headers({ 'cf-ray': '1' })),
    'blocked',
  )
  assert.equal(
    classifyHtmlInterstitial('<html><body>Please sign in to access</body></html>', 'text/html'),
    'paywalled',
  )
  assert.equal(
    classifyHtmlInterstitial('<html><body>Abstract only</body></html>', 'text/html'),
    'not_pdf',
  )
  // XML 不是 HTML：直接判 not_pdf，不要误报成人机验证。
  assert.equal(classifyHtmlInterstitial('<?xml version="1.0"?><root/>', 'application/xml'), 'not_pdf')
})

test('isLoginRedirect detects identity providers and login paths', () => {
  assert.equal(isLoginRedirect(new URL('https://idp.university.edu/saml')), true)
  assert.equal(isLoginRedirect(new URL('https://www.example.org/login?next=/a.pdf')), true)
  assert.equal(isLoginRedirect(new URL('https://www.example.org/articles/1.pdf')), false)
})
