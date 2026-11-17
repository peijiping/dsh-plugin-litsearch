import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizePmcid, parsePmcidFromElink } from '../src/search/pmc-parse.ts'

test('normalizePmcid accepts bare and prefixed forms', () => {
  assert.equal(normalizePmcid('8005924'), 'PMC8005924')
  assert.equal(normalizePmcid('pmc8005924'), 'PMC8005924')
  assert.equal(normalizePmcid(' PMC8005924 '), 'PMC8005924')
  assert.equal(normalizePmcid(''), '')
})

test('parsePmcidFromElink reads only the pubmed_pmc link set', () => {
  const payload = {
    linksets: [
      {
        linksetdbs: [
          { linkname: 'pubmed_pmc_refs', links: ['999'] },
          { linkname: 'pubmed_pmc', links: ['8005924'] },
        ],
      },
    ],
  }
  assert.equal(parsePmcidFromElink(payload), 'PMC8005924')
})

test('parsePmcidFromElink returns empty when the paper is not in PMC', () => {
  const payload = { linksets: [{ linksetdbs: [{ linkname: 'pubmed_pmc', links: [] }] }] }
  assert.equal(parsePmcidFromElink(payload), '')
  assert.equal(parsePmcidFromElink({ error: 'API rate limit exceeded' }), '')
  assert.equal(parsePmcidFromElink(null), '')
})
