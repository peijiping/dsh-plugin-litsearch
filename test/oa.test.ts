import test from 'node:test'
import assert from 'node:assert/strict'

import { isManualPdfFailure } from '../src/search/types.ts'
import type { Paper } from '../src/search/types.ts'
import {
  arxivHtmlUrl,
  epmcFullTextLocations,
  epmcXmlUrl,
  fullTextHtml,
  htmlToFragment,
  isPdfRenderUrl,
  jatsToHtml,
  landingLinks,
  mergeOaLocations,
  oaUrlKey,
  pdfCandidates,
  pdfLinksOf,
  rankOaLocations,
} from '../src/search/oa.ts'

function paper(overrides: Partial<Paper> = {}): Paper {
  return {
    source: 'openalex',
    sourceId: 'w1',
    ids: { doi: '', pmid: '', pmcid: '', arxivId: '' },
    title: 'A <title> & more',
    authors: ['Ada Lovelace'],
    year: 2024,
    venue: 'Journal',
    doi: '',
    url: 'https://example.org/?a=1&b=2',
    abstract: '',
    citedBy: null,
    openAccess: true,
    pdfUrl: '',
    type: 'journal-article',
    paperId: 'p1',
    hitSources: [{ source: 'openalex', rank: 1 }],
    matchedQueries: ['q1'],
    ...overrides,
  }
}

test('pdfCandidates keeps priority and removes duplicates', () => {
  const candidates = pdfCandidates(
    paper({
      pdfUrl: 'https://example.org/a.pdf',
      ids: { doi: '', pmid: '', pmcid: '123', arxivId: '2401.00001' },
    }),
  )
  // 静态直链（含 arXiv）在前，仓储渲染页永远排最后。
  assert.deepEqual(candidates, [
    'https://example.org/a.pdf',
    'https://arxiv.org/pdf/2401.00001',
    'https://europepmc.org/articles/PMC123?pdf=render',
    'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/pdf/',
  ])
})

test('already prefixed PMCID is not prefixed twice', () => {
  assert.deepEqual(pdfCandidates(paper({ ids: { doi: '', pmid: '', pmcid: 'PMC99', arxivId: '' } })), [
    'https://europepmc.org/articles/PMC99?pdf=render',
    'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC99/pdf/',
  ])
})

test('isPdfRenderUrl only marks repository render pages', () => {
  assert.equal(isPdfRenderUrl('https://europepmc.org/articles/PMC123?pdf=render'), true)
  assert.equal(isPdfRenderUrl('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/pdf/'), true)
  assert.equal(isPdfRenderUrl('https://example.org/a.pdf'), false)
  assert.equal(isPdfRenderUrl('https://journals.plos.org/plosone/article/file?id=x&type=printable'), false)
  assert.equal(isPdfRenderUrl('https://arxiv.org/pdf/2401.00001'), false)
})

test('isManualPdfFailure separates browser-only failures from real errors', () => {
  assert.equal(isManualPdfFailure('no-candidate'), true)
  assert.equal(isManualPdfFailure('blocked'), true)
  assert.equal(isManualPdfFailure('paywalled'), true)
  assert.equal(isManualPdfFailure('not-pdf'), true)
  assert.equal(isManualPdfFailure('failed'), false)
  assert.equal(isManualPdfFailure(undefined), false)
})

test('epmcXmlUrl requires a PMCID', () => {
  assert.equal(epmcXmlUrl(paper()), null)
  assert.equal(
    epmcXmlUrl(paper({ ids: { doi: '', pmid: '', pmcid: '456', arxivId: '' } })),
    'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC456/fullTextXML',
  )
})

test('jatsToHtml keeps structure and drops references', () => {
  const html = jatsToHtml(
    '<article><body><sec><title>Intro</title><p>Hello <italic>world</italic>.</p>' +
      '<list><list-item>one</list-item></list></sec>' +
      '<ref-list><ref>hidden</ref></ref-list><back>tail</back></body></article>',
  )
  assert.match(html, /<h3>Intro<\/h3>/u)
  assert.match(html, /<p>Hello world \.<\/p>/u)
  assert.match(html, /<ul><li>one<\/li><\/ul>/u)
  assert.ok(!html.includes('hidden'))
  assert.ok(!html.includes('tail'))
})

test('jatsToHtml strips tags from untrusted markup', () => {
  const html = jatsToHtml('<p>safe<img src="x" onerror="alert(1)"> text</p>')
  assert.ok(!html.includes('<img'))
  assert.ok(!html.includes('onerror'))
  assert.match(html, /safe/)
})

test('fullTextHtml escapes the title and source link', () => {
  const html = fullTextHtml(paper(), '<p>body</p>', 'Europe PMC')
  assert.match(html, /<title>A &lt;title&gt; &amp; more<\/title>/u)
  assert.match(html, /href="https:\/\/example\.org\/\?a=1&amp;b=2"/u)
  assert.match(html, /<p>body<\/p>/u)
})

test('oaUrlKey drops the fragment but keeps the query', () => {
  assert.equal(
    oaUrlKey('http://Example.ORG/a.pdf?pdf=render#page=3'),
    'https://example.org/a.pdf?pdf=render',
  )
  assert.equal(oaUrlKey('https://example.org/a.pdf'), 'https://example.org/a.pdf')
  assert.equal(oaUrlKey('not a url'), 'not a url')
})

test('mergeOaLocations unions by canonical URL and records alsoIn', () => {
  const merged = mergeOaLocations([
    [{ url: 'https://a.org/x.pdf#top', kind: 'pdf', source: 'openalex', oa: true, best: true }],
    [{ url: 'https://a.org/x.pdf', kind: 'pdf', source: 'unpaywall', oa: false, license: 'cc-by' }],
    [{ url: 'https://b.org/y', kind: 'landing', source: 'doi', oa: false }],
  ])
  assert.equal(merged.length, 2)
  const pdf = merged[0]
  assert.equal(pdf.url, 'https://a.org/x.pdf#top')
  assert.equal(pdf.oa, true)
  assert.equal(pdf.best, true)
  assert.equal(pdf.license, 'cc-by')
  assert.deepEqual(pdf.alsoIn, ['unpaywall'])
  assert.equal(merged[1].oa, false)
})

test('rankOaLocations puts confirmed direct PDFs first and render pages last', () => {
  const ranked = rankOaLocations([
    { url: 'https://europepmc.org/articles/PMC1?pdf=render', kind: 'pdf', source: 'europepmc', oa: true },
    { url: 'https://doi.org/10.1/x', kind: 'landing', source: 'doi', oa: false },
    { url: 'https://pub.example/x.pdf', kind: 'pdf', source: 'publisher-rule', oa: false },
    { url: 'https://oa.example/x.pdf', kind: 'pdf', source: 'openalex', oa: true },
  ])
  assert.deepEqual(
    ranked.map((location) => location.url),
    [
      'https://oa.example/x.pdf',
      'https://pub.example/x.pdf',
      'https://europepmc.org/articles/PMC1?pdf=render',
      'https://doi.org/10.1/x',
    ],
  )
})

test('pdfLinksOf excludes text-mining-only links and landing pages', () => {
  const links = pdfLinksOf([
    { url: 'https://api.example/tdm.pdf', kind: 'pdf', source: 'metadata', oa: false, textMining: true },
    { url: 'https://oa.example/x.pdf', kind: 'pdf', source: 'openalex', oa: true },
    { url: 'https://doi.org/10.1/x', kind: 'landing', source: 'doi', oa: false },
  ])
  assert.deepEqual(links, ['https://oa.example/x.pdf'])
})

test('subscription landing pages are never marked as open access', () => {
  const links = landingLinks({ doi: '10.1000/x', url: 'https://doi.org/10.1000/x' })
  assert.equal(links.length, 1)
  assert.equal(links[0].oa, false)
  assert.equal(links[0].kind, 'landing')
})

test('epmcFullTextLocations separates OA PDFs from subscription landing pages', () => {
  const locations = epmcFullTextLocations({
    fullTextUrl: [
      { availabilityCode: 'OA', documentStyle: 'pdf', url: 'https://europepmc.org/articles/PMC1?pdf=render' },
      { availabilityCode: 'S', documentStyle: 'doi', url: 'https://doi.org/10.1/sub' },
      { availabilityCode: 'F', documentStyle: 'html', url: 'https://europepmc.org/article/PMC1' },
    ],
  })
  const byUrl = new Map(locations.map((location) => [location.url, location]))
  assert.equal(byUrl.get('https://europepmc.org/articles/PMC1?pdf=render')?.oa, true)
  assert.equal(byUrl.get('https://europepmc.org/articles/PMC1?pdf=render')?.kind, 'pdf')
  assert.equal(byUrl.get('https://doi.org/10.1/sub')?.oa, false)
  assert.equal(byUrl.get('https://doi.org/10.1/sub')?.kind, 'landing')
  assert.equal(byUrl.get('https://europepmc.org/article/PMC1')?.oa, true)
  assert.equal(byUrl.get('https://europepmc.org/article/PMC1')?.kind, 'html')
})

test('arxivHtmlUrl maps the id to the readable HTML view', () => {
  assert.equal(arxivHtmlUrl(paper()), null)
  assert.equal(
    arxivHtmlUrl(paper({ ids: { doi: '', pmid: '', pmcid: '', arxivId: '2401.00001v2' } })),
    'https://arxiv.org/html/2401.00001v2',
  )
})

test('htmlToFragment keeps paragraphs, drops scripts and escapes text', () => {
  const fragment = htmlToFragment(
    '<html><body><script>alert(1)</script><h2>Intro</h2><p>safe <b>bold</b></p>' +
      '<figure><img src="x" onerror="alert(2)"></figure></body></html>',
  )
  assert.match(fragment, /<h2>Intro<\/h2>/u)
  assert.match(fragment, /<p>safe bold<\/p>/u)
  assert.ok(!fragment.includes('<script'))
  assert.ok(!fragment.includes('alert(1)'))
  assert.ok(!fragment.includes('onerror'))
})
