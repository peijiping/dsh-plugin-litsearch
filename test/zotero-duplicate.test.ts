import test from 'node:test'
import assert from 'node:assert/strict'

import {
  collectionPaths,
  indexFromItems,
  localApiBase,
  matchCollectionKey,
  matchExisting,
  normalizeArxiv,
  normalizeDoi,
  parseCollections,
  resolveTargetPath,
} from '../src/host/zotero/local.ts'
import type { Paper, ZoteroTarget } from '../src/search/types.ts'

function target(id: string, name: string, level: number): ZoteroTarget {
  return { id, name, level }
}

const TARGETS: ZoteroTarget[] = [
  target('L1', '我的文库', 0),
  // 同级兄弟目录：不能因为排在前面就被算进后续目标的祖先链。
  target('C0', '减脂', 1),
  target('C1', '综述', 1),
  target('C2', '深度学习', 2),
  target('C3', '综述（待读）', 2),
  target('L2', '实验室', 0),
  target('C9', '综述', 1),
]

function paper(overrides: Partial<Paper> = {}): Paper {
  return {
    paperId: 'p1',
    source: 'openalex',
    sourceId: 'x',
    ids: { doi: '', pmid: '', pmcid: '', arxivId: '' },
    title: 'Title',
    authors: [],
    year: 2024,
    venue: '',
    doi: '',
    url: '',
    abstract: '',
    citedBy: null,
    openAccess: false,
    pdfUrl: '',
    type: '',
    matchedQueries: [],
    hitSources: [],
    ...overrides,
  }
}

test('resolveTargetPath：按 level 栈还原库与名称路径', () => {
  const nested = resolveTargetPath(TARGETS, 'C2')
  assert.equal(nested?.library.id, 'L1')
  assert.deepEqual(nested?.path, ['综述', '深度学习'])

  const root = resolveTargetPath(TARGETS, 'L1')
  assert.equal(root?.library.id, 'L1')
  assert.deepEqual(root?.path, [])

  const group = resolveTargetPath(TARGETS, 'C9')
  assert.equal(group?.library.id, 'L2')
  assert.deepEqual(group?.path, ['综述'])

  assert.equal(resolveTargetPath(TARGETS, 'C404'), undefined)
})

test('collectionPaths / matchCollectionKey：父链还原、名称归一化、唯一命中', () => {
  const nodes = parseCollections([
    { data: { key: 'A', name: '综述', parentCollection: false } },
    { key: 'B', data: { key: 'B', name: '深度学习', parentCollection: 'A' } },
    { data: { key: 'C', name: '综述', parentCollection: false } },
    // 同名集合挂在不同父级下：完整路径才是唯一依据。
    { data: { key: 'D', name: '综述', parentCollection: 'B' } },
  ])
  const paths = collectionPaths(nodes)

  const deep = matchCollectionKey(paths, ['综述', '深度学习'])
  assert.equal(deep, 'B')

  const ambiguousRoot = matchCollectionKey(paths, ['综述'])
  assert.equal(ambiguousRoot, undefined)

  const nestedSameName = matchCollectionKey(paths, ['综述', '深度学习', '综述'])
  assert.equal(nestedSameName, 'D')

  const spaced = matchCollectionKey(paths, [' 综述 ', '深度学习'])
  assert.equal(spaced, 'B')

  assert.equal(matchCollectionKey(paths, ['不存在']), undefined)
})

const ITEMS = [
  {
    data: {
      key: 'A',
      itemType: 'journalArticle',
      title: 'Deep Learning',
      DOI: 'https://doi.org/10.1000/ABC',
      date: '2023-05-01',
      extra: 'dsh-litsearch:p1\nPMID: 12345\narXiv: 2401.0001v2',
    },
  },
  {
    data: {
      key: 'B',
      itemType: 'attachment',
      title: 'Full Text PDF',
      DOI: '10.1000/attachment-only',
    },
  },
  { data: { key: 'C', itemType: 'journalArticle', title: 'Attention: Is All You Need?', date: '2017' } },
]

test('indexFromItems / matchExisting：按 id、DOI、PMID、arXiv、标题+年份匹配', () => {
  const index = indexFromItems(ITEMS)

  assert.equal(matchExisting(paper({ paperId: 'p1' }), index), 'id')
  assert.equal(
    matchExisting(paper({ paperId: 'p2', doi: 'https://doi.org/10.1000/abc' }), index),
    'doi',
  )
  assert.equal(
    matchExisting(
      paper({ paperId: 'p3', ids: { doi: '', pmid: '12345', pmcid: '', arxivId: '' } }),
      index,
    ),
    'pmid',
  )
  assert.equal(
    matchExisting(
      paper({
        paperId: 'p4',
        ids: { doi: '', pmid: '', pmcid: '', arxivId: 'arXiv:2401.0001' },
      }),
      index,
    ),
    'arxiv',
  )
  assert.equal(
    matchExisting(
      paper({ paperId: 'p5', title: 'attention - is all you need', year: 2017 }),
      index,
    ),
    'title',
  )

  // 附件不参与匹配；年份不同时标题兜底不命中。
  assert.equal(matchExisting(paper({ paperId: 'p6', doi: '10.1000/attachment-only' }), index), undefined)
  assert.equal(
    matchExisting(paper({ paperId: 'p7', title: 'attention is all you need', year: 2024 }), index),
    undefined,
  )
})

test('localApiBase / normalizeDoi / normalizeArxiv：地址与前缀归一化', () => {
  assert.equal(localApiBase('http://127.0.0.1:23119/'), 'http://127.0.0.1:23119/api')
  assert.equal(localApiBase('http://127.0.0.1:23119/api/'), 'http://127.0.0.1:23119/api')
  assert.equal(normalizeDoi(' DOI: 10.1000/ABC '), '10.1000/abc')
  assert.equal(normalizeDoi('http://dx.doi.org/10.1000/ABC'), '10.1000/abc')
  assert.equal(normalizeArxiv('arXiv:2401.0001v3'), '2401.0001')
})
