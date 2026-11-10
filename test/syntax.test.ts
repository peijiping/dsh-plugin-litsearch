import test from 'node:test'
import assert from 'node:assert/strict'

import { hasFieldSyntax, naturalOnlySelected } from '../src/client/syntax.ts'

test('hasFieldSyntax recognizes field tags and boolean operators', () => {
  assert.equal(hasFieldSyntax('cancer[tiab] AND therapy'), true)
  assert.equal(hasFieldSyntax('AU: Smith'), true)
  assert.equal(hasFieldSyntax('graph neural networks'), false)
  assert.equal(hasFieldSyntax('"deep learning"'), false)
})

test('naturalOnlySelected keeps only natural-language sources', () => {
  assert.deepEqual(
    naturalOnlySelected(['pubmed', 'semanticscholar', 'pubtator']),
    ['semanticscholar', 'pubtator'],
  )
  assert.deepEqual(naturalOnlySelected(['pubmed', 'arxiv']), [])
})
