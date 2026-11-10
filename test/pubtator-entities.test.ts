import test from 'node:test'
import assert from 'node:assert/strict'

import { parsePubtatorEntities } from '../src/search/pubtator-parse.ts'

function payload(): unknown {
  return {
    PubTator3: [
      {
        id: '123',
        passages: [
          {
            annotations: [
              {
                text: 'Neoplasms',
                infons: {
                  type: 'Disease',
                  identifier: 'MESH:D009369',
                  database: 'ncbi_mesh',
                  name: 'Neoplasms',
                },
              },
              {
                text: 'Neoplasms',
                infons: {
                  type: 'Disease',
                  identifier: 'MESH:D009369',
                  database: 'ncbi_mesh',
                  name: 'Neoplasms',
                },
              },
              {
                text: 'TP53',
                infons: {
                  type: 'Gene',
                  identifier: '7157',
                  database: 'ncbi_gene',
                  name: 'TP53',
                },
              },
            ],
          },
        ],
      },
    ],
  }
}

test('parsePubtatorEntities flattens passages and counts duplicates', () => {
  const entities = parsePubtatorEntities(payload())
  assert.equal(entities.length, 2)
  const disease = entities.find((entity) => entity.type === 'Disease')
  assert.equal(disease?.text, 'Neoplasms')
  assert.equal(disease?.identifier, 'MESH:D009369')
  assert.equal(disease?.count, 2)
  const gene = entities.find((entity) => entity.type === 'Gene')
  assert.equal(gene?.database, 'ncbi_gene')
  assert.equal(gene?.count, 1)
})

test('parsePubtatorEntities tolerates malformed payloads', () => {
  assert.deepEqual(parsePubtatorEntities(null), [])
  assert.deepEqual(parsePubtatorEntities({ PubTator3: 'nope' }), [])
  assert.deepEqual(parsePubtatorEntities({ PubTator3: [{ passages: [{ annotations: [{}] }] }] }), [])
})
