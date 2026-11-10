import test from 'node:test'
import assert from 'node:assert/strict'

import {
  asArray,
  asNumber,
  asRecord,
  asString,
  doiUrl,
  firstString,
  normalizeDoi,
  stripTags,
} from '../src/search/normalize.ts'

test('normalizeDoi strips URL and doi prefixes and lowercases', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1000/ABC'), '10.1000/abc')
  assert.equal(normalizeDoi('http://dx.doi.org/10.5555/XyZ'), '10.5555/xyz')
  assert.equal(normalizeDoi(' doi: 10.1/One '), '10.1/one')
  assert.equal(normalizeDoi(42), '')
})

test('doiUrl only builds a link for non-empty values', () => {
  assert.equal(doiUrl(''), '')
  assert.equal(doiUrl('10.1/x'), 'https://doi.org/10.1/x')
})

test('firstString reads the first array item as a string', () => {
  assert.equal(firstString(['A title', 'other']), 'A title')
  assert.equal(firstString([42, 'later']), '')
  assert.equal(firstString('not-an-array'), '')
})

test('stripTags removes markup and decodes common entities', () => {
  assert.equal(
    stripTags('<jats:p>Tom &amp; Jerry &lt;3</jats:p>'),
    'Tom & Jerry <3',
  )
  assert.equal(stripTags('  a \n\t b  '), 'a b')
  assert.equal(stripTags(undefined), '')
})

test('narrowing helpers never throw on wrong shapes', () => {
  assert.deepEqual(asRecord(null), {})
  assert.deepEqual(asRecord([1]), {})
  assert.deepEqual(asArray('x'), [])
  assert.equal(asString(7), '')
  assert.equal(asNumber(Number.NaN), null)
  assert.equal(asNumber(3.5), 3.5)
})
