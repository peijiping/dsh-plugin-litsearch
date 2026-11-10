import test from 'node:test'
import assert from 'node:assert/strict'

import type { Paper } from '../src/search/types.ts'
import { epmcXmlUrl, fullTextHtml, jatsToHtml, pdfCandidates } from '../src/search/oa.ts'

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
  assert.deepEqual(candidates, [
    'https://example.org/a.pdf',
    'https://europepmc.org/articles/PMC123?pdf=render',
    'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/pdf/',
    'https://arxiv.org/pdf/2401.00001',
  ])
})

test('already prefixed PMCID is not prefixed twice', () => {
  assert.deepEqual(pdfCandidates(paper({ ids: { doi: '', pmid: '', pmcid: 'PMC99', arxivId: '' } })), [
    'https://europepmc.org/articles/PMC99?pdf=render',
    'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC99/pdf/',
  ])
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
