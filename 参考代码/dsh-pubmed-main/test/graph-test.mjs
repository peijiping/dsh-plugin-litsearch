// graph-test.mjs — P1 knowledge-graph engine test with SYNTHETIC article data
// (no network needed — the graph engine is pure in-memory + storage).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../lib/pubmed-core.js', import.meta.url)), 'utf8')
const factory = new Function(source + '\n; return registerPubmedTools')
const registerPubmedTools = factory()

const tools = {}
let userGraph = null
const storage = {
  loadUserGraph: () => (userGraph ? JSON.parse(JSON.stringify(userGraph)) : null),
  saveUserGraph: (g) => { userGraph = JSON.parse(JSON.stringify(g)); return true },
  clearUserGraph: () => { userGraph = null; return true },
}
registerPubmedTools({ get: () => undefined }, {
  defineTool: (opts) => opts,
  register: (def) => { tools[def.name] = def },
  httpGet: async () => { throw new Error('network not used in this test') },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  storage,
})

const S = (id) => ({ agent: { id }, signal: AbortSignal.timeout(5000) })

// synthetic articles (share some keywords so co-occurrence forms)
const a1 = {
  pmid: '11111111', doi: '10.1/a', title: 'Gut microbiota metabolism and bile acids in metabolic disease',
  abstractText: 'The gut microbiome regulates bile acid metabolism and interacts with host metabolic pathways. Microbiota derived metabolites shape disease risk.',
  meshTerms: [{ descriptorName: 'Gastrointestinal Microbiome' }, { descriptorName: 'Bile Acids and Salts' }, { descriptorName: 'Metabolic Diseases' }],
}
const a2 = {
  pmid: '22222222', doi: '10.2/b', title: 'Short chain fatty acids and gut microbiota cross feeding',
  abstractText: 'Cross feeding between gut microbes produces short chain fatty acids. Microbiota metabolism influences host immunity and metabolic health.',
  meshTerms: [{ descriptorName: 'Fatty Acids, Volatile' }, { descriptorName: 'Gastrointestinal Microbiome' }, { descriptorName: 'Host Microbial Interactions' }],
}
const a3 = {
  pmid: '33333333', doi: '10.3/c', title: 'Bile acids in liver disease and the microbiome',
  abstractText: 'Bile acid signaling and gut microbiota alterations drive liver disease progression and metabolic dysfunction.',
  meshTerms: [{ descriptorName: 'Bile Acids and Salts' }, { descriptorName: 'Liver Diseases' }, { descriptorName: 'Gastrointestinal Microbiome' }],
}

// 1) incremental session build in session A
const add1 = await tools.pubmed_graph_add.execute({ articles: [a1] }, S('sA'))
console.log('add[a1] -> nodes=' + add1.stats.nodeCount + ' edges=' + add1.stats.edgeCount)
const add2 = await tools.pubmed_graph_add.execute({ articles: [a2] }, S('sA'))
console.log('add[a2] -> nodes=' + add2.stats.nodeCount + ' edges=' + add2.stats.edgeCount + ' (incremental)')
const add3 = await tools.pubmed_graph_add.execute({ articles: [a3] }, S('sA'))
console.log('add[a3] -> nodes=' + add3.stats.nodeCount + ' edges=' + add3.stats.edgeCount)
if (!(add3.stats.nodeCount > add2.stats.nodeCount && add2.stats.nodeCount > add1.stats.nodeCount)) { console.log('INCREMENT FAIL'); process.exit(1) }

// 2b) dryRun previews without mutating the session graph
const nodesBefore = (await tools.pubmed_graph_get.execute({ scope: 'session' }, S('sA'))).session.stats.nodeCount
const dr = await tools.pubmed_graph_add.execute({ articles: [{ pmid: '99999999', title: 'Dry run synthetic article about proteomics biomarkers', abstractText: 'Proteomics biomarkers drive discovery.' }], dryRun: true }, S('sA'))
const nodesAfter = (await tools.pubmed_graph_get.execute({ scope: 'session' }, S('sA'))).session.stats.nodeCount
console.log('dryRun -> wouldAddNodes=' + dr.wouldAddNodes + ' wouldAddEdges=' + dr.wouldAddEdges + ' nodes ' + nodesBefore + '->' + nodesAfter)
if (!(dr.dryRun === true && dr.wouldAddNodes > 0 && nodesAfter === nodesBefore)) { console.log('DRYRUN FAIL'); process.exit(1) }

// 3) session isolation (session B empty)
const isoB = await tools.pubmed_graph_get.execute({ scope: 'session' }, S('sB'))
console.log('session B nodes -> ' + isoB.session.stats.nodeCount + ' (expect 0)')
if (isoB.session.stats.nodeCount !== 0) { console.log('ISOLATION FAIL'); process.exit(1) }

// 4) get session A: directed article->keyword + undirected co-occur present
const gA = await tools.pubmed_graph_get.execute({ scope: 'session' }, S('sA'))
const kinds = new Set(gA.session.edges.map((e) => e.kind))
console.log('session A -> nodes=' + gA.session.stats.nodeCount + ' edges=' + gA.session.stats.edgeCount + ' kinds=' + [...kinds].join(','))
if (!kinds.has('article-keyword') || !kinds.has('co-occur')) { console.log('EDGE KINDS FAIL'); process.exit(1) }
const kwNode = gA.session.nodes.find((n) => n.type === 'keyword' && n.label === 'microbiota')
console.log('kw "microbiota" -> count=' + (kwNode && kwNode.count) + ' sources=' + (kwNode && kwNode.sources.length))
if (!kwNode || kwNode.count < 3) { console.log('KEYWORD MERGE FAIL'); process.exit(1) }

// 5) commit session A -> user graph (persisted via in-memory storage)
const commit = await tools.pubmed_graph_commit.execute({ confirm: true }, S('sA'))
console.log('commit -> committed=' + commit.committed + ' user.nodes=' + commit.stats.nodeCount)
if (!commit.committed) { console.log('COMMIT FAIL'); process.exit(1) }
// user graph visible from another session
const gU = await tools.pubmed_graph_get.execute({ scope: 'user' }, S('sB'))
console.log('user graph -> nodes=' + gU.user.stats.nodeCount + ' articles=' + gU.user.stats.articles + ' keywords=' + gU.user.stats.keywords)
if (!gU.user.nodes.length) { console.log('USER PERSIST FAIL'); process.exit(1) }

// 6) double commit is idempotent-ish (merges, doesn't corrupt)
const commit2 = await tools.pubmed_graph_commit.execute({ confirm: true }, S('sA'))
console.log('commit(2nd) -> user.nodes=' + commit2.stats.nodeCount + ' addedNodes=' + commit2.addedNodes)

// 7) reset session A
await tools.pubmed_graph_reset.execute({ scope: 'session' }, S('sA'))
const afterReset = await tools.pubmed_graph_get.execute({ scope: 'session' }, S('sA'))
console.log('reset session A -> nodes=' + afterReset.session.stats.nodeCount + ' (expect 0)')
if (afterReset.session.stats.nodeCount !== 0) { console.log('RESET FAIL'); process.exit(1) }

// 8) reset user graph
await tools.pubmed_graph_reset.execute({ scope: 'user' }, S('any'))
const gU2 = await tools.pubmed_graph_get.execute({ scope: 'user' }, S('any'))
console.log('reset user -> nodes=' + gU2.user.stats.nodeCount + ' (expect 0)')
if (gU2.user.stats.nodeCount !== 0) { console.log('USER RESET FAIL'); process.exit(1) }

// 9) v0.4.4 P2 — user-graph schema migration + structure normalization (03 分册 §2)
console.log('--- P2: user-graph migration hook ---')
// 9a) 无 version 字段的旧文件：graph_get 读点直接迁移（R1：读点之一）
userGraph = { nodes: { kw1: { id: 'kw1', type: 'keyword', label: 'microbiota', count: 2, sources: ['11111111'] } }, edges: {} }
const migGet = await tools.pubmed_graph_get.execute({ scope: 'user' }, S('sM'))
console.log('graph_get(user) migrated version -> ' + migGet.user.stats.version + ' (expect 1)')
if (migGet.user.stats.version !== 1) { console.log('MIGRATE READ FAIL'); process.exit(1) }
if (migGet.user.stats.nodeCount !== 1) { console.log('MIGRATE DATA LOSS FAIL'); process.exit(1) }

// 9b) 缺失字段的旧节点（无 count / 无 sources）：结构规整后 commit 合并不抛错（R3）
const addM = await tools.pubmed_graph_add.execute({ articles: [a1] }, S('sM'))
if (!addM.stats || addM.stats.nodeCount < 1) { console.log('P2 SESSION BUILD FAIL'); process.exit(1) }
const commitM = await tools.pubmed_graph_commit.execute({ confirm: true }, S('sM'))
console.log('commit(migrated) -> committed=' + commitM.committed + ' nodes=' + commitM.stats.nodeCount + ' edges=' + commitM.stats.edgeCount)
if (!commitM.committed) { console.log('MIGRATE COMMIT FAIL'); process.exit(1) }
// 持久化文件带 version:1 且所有节点字段规整（sources 数组 / count 数字）
if (userGraph.version !== 1) { console.log('VERSION STAMP FAIL'); process.exit(1) }
for (const n of Object.values(userGraph.nodes)) {
  if (!Array.isArray(n.sources) || typeof n.count !== 'number') { console.log('NORMALIZE FAIL: ' + n.id); process.exit(1) }
}
console.log('normalized persisted graph -> nodes=' + Object.keys(userGraph.nodes).length + ' all fields sane, version=1')

// 9c) 未来版本透传：version:2 的文件不降级、不臆测
userGraph = { version: 2, nodes: { f1: { id: 'f1', type: 'keyword', label: 'future', count: 1, sources: ['x'] } }, edges: {} }
const gF = await tools.pubmed_graph_get.execute({ scope: 'user' }, S('sM'))
console.log('future version passthrough -> ' + gF.user.stats.version + ' (expect 2, no downgrade)')
if (gF.user.stats.version !== 2) { console.log('FUTURE VERSION FAIL'); process.exit(1) }

// 9d) 缺步骤不盖戳（R2）：把 GRAPH_SCHEMA_VERSION 文本替换为 2 且不提供 MIGRATIONS[2]
{
  const v2Source = source.replace('const GRAPH_SCHEMA_VERSION = 1', 'const GRAPH_SCHEMA_VERSION = 2')
  if (v2Source === source) { console.log('V2 PATCH FAIL (anchor not found)'); process.exit(1) }
  const registerV2 = new Function(v2Source + '\n; return registerPubmedTools')()
  let stored2 = { version: 1, nodes: { q1: { id: 'q1', type: 'keyword', label: 'q', count: 1, sources: ['x'] } }, edges: {} }
  const toolsV2 = {}
  registerV2({ get: () => undefined }, {
    defineTool: (o) => o,
    register: (d) => { toolsV2[d.name] = d },
    httpGet: async () => { throw new Error('network not used in this test') },
    sleep: () => Promise.resolve(),
    storage: {
      loadUserGraph: () => (stored2 ? JSON.parse(JSON.stringify(stored2)) : null),
      saveUserGraph: (g) => { stored2 = JSON.parse(JSON.stringify(g)); return true },
      clearUserGraph: () => { stored2 = null; return true },
    },
  })
  const gV2 = await toolsV2.pubmed_graph_get.execute({ scope: 'user' }, S('v2'))
  console.log('missing step: version stays ' + gV2.user.stats.version + ' (expect 1, never rubber-stamped to 2)')
  if (gV2.user.stats.version !== 1) { console.log('RUBBER STAMP FAIL'); process.exit(1) }
}

// P2 收尾：清空用户图，保持与后续断言（如有）无关
await tools.pubmed_graph_reset.execute({ scope: 'user' }, S('any'))

console.log('GRAPH TEST OK — extract/increment/isolation/commit/persist/reset/migration all pass')
