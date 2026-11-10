import test from 'node:test'
import assert from 'node:assert/strict'

import {
  adaptQuery,
  stripFieldTags,
  toArxivQuery,
  toPlainText,
} from '../src/search/query-adapter.ts'

test('perSource overrides apply only to their own source', () => {
  const block = {
    text: 'crispr [tiab]',
    perSource: { pubmed: 'CRISPR[Title] AND gene[tiab]' },
  }
  assert.equal(adaptQuery('pubmed', block), 'CRISPR[Title] AND gene[tiab]')
  assert.equal(adaptQuery('openalex', block), 'crispr')
})

test('blank overrides fall back to the main query', () => {
  const block = { text: 'graph learning', perSource: { arxiv: '   ' } }
  assert.equal(adaptQuery('arxiv', block), 'all:"graph learning"')
})

test('field tags and wildcards are stripped for natural-language sources', () => {
  assert.equal(stripFieldTags('cancer* [tiab] AND "gene therapy"'), 'cancer AND "gene therapy"')
})

test('arxiv gets field prefixes while existing prefixes are preserved', () => {
  assert.equal(toArxivQuery('graph neural networks'), 'all:"graph neural networks"')
  assert.equal(toArxivQuery('graph AND network'), 'all:graph AND all:network')
  assert.equal(toArxivQuery('ti:attention'), 'ti:attention')
})

test('pubtator drops boolean operators', () => {
  assert.equal(toPlainText('crispr AND (gene OR editing) NOT cancer'), 'crispr (gene editing) cancer')
})
