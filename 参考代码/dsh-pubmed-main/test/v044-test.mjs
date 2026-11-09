// v044-test.mjs — v0.4.4 P1 (endpoint configurability) + P3 (S2 429 fast-fail).
// P1 (03 分册 §1): the two v0.4.x-added sources must follow the P3.8b
//   *_BASE_URL pattern — defaults behave exactly like v0.4.3, injected
//   openalexBaseUrl/s2BaseUrl re-point EVERY OpenAlex/S2 request (unified
//   search, fetch_pdf_oa's works/doi:, S2 tools) with zero leakage to the
//   official hosts, and trailing slashes are normalized.
// P3 (03 分册 §3): the S2 retry budget is 2 — a shared-pool 429 fails in
//   ~3s (1s+2s backoff) instead of stalling 60-90s, while NCBI keeps its
//   full 1+6 attempt budget and a recovering endpoint still succeeds.
// All with a mocked httpGet, zero network. P1 mocks key off the CONFIGURED
// host (not the api.openalex.org literal), so a passing assertion proves the
// wiring.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../lib/pubmed-core.js', import.meta.url)), 'utf8')
const registerPubmedTools = new Function(source + '\n; return registerPubmedTools')()

const checks = []
const add = (name, ok) => checks.push([name, ok])
const S = (id) => ({ agent: { id }, signal: AbortSignal.timeout(30000) })

const OA_EMPTY = JSON.stringify({ meta: { count: 0 }, results: [] })
const DOI = '10.1038/nature12373'
// fetch_pdf_oa's works/doi: response (no OA → short path, no location parsing).
const OA_DOI_EMPTY = JSON.stringify({ id: 'W1', open_access: { is_oa: false }, best_oa_location: null, locations: [] })
const UNPAYWALL_NONE = JSON.stringify({ doi: DOI, is_oa: false, oa_locations: [] })
const EPMC_NONE = JSON.stringify({ resultList: { result: [] } })
const S2_PAPER = JSON.stringify({ paperId: 'S2x', title: 'T', externalIds: { DOI: '10.1/aaa' } })

function makeTools(httpGet, extraDeps) {
  const tools = {}
  const urls = []
  const sleeps = []
  registerPubmedTools({ get: () => undefined }, {
    defineTool: (o) => o,
    register: (d) => { tools[d.name] = d },
    httpGet: async (url) => { urls.push(String(url)); return httpGet(String(url)) },
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve() },
    ...extraDeps,
  })
  return { tools, urls, sleeps }
}

// ---- 1) defaults: official endpoints — behavior identical to v0.4.3 ----
{
  const { tools, urls } = makeTools((u) => {
    if (u.includes('api.openalex.org')) return { status: 200, body: OA_EMPTY }
    if (u.includes('api.semanticscholar.org')) return { status: 200, body: S2_PAPER }
    return { status: 200, body: '{}' }
  })
  const r = await tools.pubmed_search_papers.execute({ query: 'metformin', sources: ['openalex'] }, S('p1'))
  add('default openalex base: unified search hits api.openalex.org/works?', urls.some((u) => u.startsWith('https://api.openalex.org/works?')))
  add('default openalex base: unified search source OK', r.perSource.some((p) => p.source === 'openalex' && !p.error))
  await tools.pubmed_get_s2_detail.execute({ paperId: 'DOI:10.1/aaa' }, S('p1'))
  add('default s2 base: detail hits api.semanticscholar.org/graph/v1/', urls.some((u) => u.startsWith('https://api.semanticscholar.org/graph/v1/')))
}

// ---- 2) injected bases: every OpenAlex/S2 request re-pointed, zero leaks ----
{
  const seen = []
  const { tools } = makeTools((u) => {
    seen.push(String(u))
    if (u.includes('oa-proxy.test/works?')) return { status: 200, body: OA_EMPTY }
    if (u.includes('oa-proxy.test/works/doi:')) return { status: 200, body: OA_DOI_EMPTY }
    if (u.includes('s2-proxy.test')) return { status: 200, body: S2_PAPER }
    if (u.includes('api.unpaywall.org')) return { status: 200, body: UNPAYWALL_NONE }
    if (u.includes('europepmc') || u.includes('ebi.ac.uk')) return { status: 200, body: EPMC_NONE }
    return { status: 200, body: '{}' }
  }, { openalexBaseUrl: 'https://oa-proxy.test', s2BaseUrl: 'https://s2-proxy.test' })
  await tools.pubmed_search_papers.execute({ query: 'metformin', sources: ['openalex'] }, S('p2'))
  await tools.pubmed_fetch_pdf_oa.execute({ doi: DOI }, S('p2'))
  await tools.pubmed_get_s2_detail.execute({ paperId: 'DOI:10.1/aaa' }, S('p2'))
  add('proxy openalex: unified search re-pointed', seen.some((u) => u.startsWith('https://oa-proxy.test/works?')))
  add('proxy openalex: fetch_pdf_oa works/doi: re-pointed', seen.some((u) => u.startsWith('https://oa-proxy.test/works/doi:')))
  add('proxy s2: get_s2_detail re-pointed', seen.some((u) => u.startsWith('https://s2-proxy.test/graph/v1/')))
  add('zero leak to the official OpenAlex/S2 hosts', !seen.some((u) => u.includes('api.openalex.org') || u.includes('api.semanticscholar.org')))
  const leakFreeOa = seen.filter((u) => u.includes('oa-proxy.test/works'))
  add('both OpenAlex call sites proxied (unified + works/doi:)', leakFreeOa.some((u) => u.includes('/works?')) && leakFreeOa.some((u) => u.includes('/works/doi:')))
}

// ---- 3) trailing slashes collapse to a single separator ----
{
  const { tools, urls } = makeTools((u) => {
    if (u.includes('oa-proxy.test/works?')) return { status: 200, body: OA_EMPTY }
    if (u.includes('s2-proxy.test')) return { status: 200, body: S2_PAPER }
    return { status: 200, body: '{}' }
  }, { openalexBaseUrl: 'https://oa-proxy.test/', s2BaseUrl: 'https://s2-proxy.test/' })
  await tools.pubmed_search_papers.execute({ query: 'x', sources: ['openalex'] }, S('p3'))
  await tools.pubmed_get_s2_detail.execute({ paperId: 'DOI:10.1/aaa' }, S('p3'))
  add('openalex trailing slash: single separator before path', urls.some((u) => u.startsWith('https://oa-proxy.test/works?')) && !urls.some((u) => u.includes('oa-proxy.test//works')))
  add('s2 trailing slash: single separator before path', urls.some((u) => u.startsWith('https://s2-proxy.test/graph/v1/')) && !urls.some((u) => u.includes('s2-proxy.test//graph')))
}

// ---- 4) P3: S2 429 fails fast; other sources keep the full 6-retry budget ----
{
  const calls = { s2: 0, eutils: 0 }
  const { tools, sleeps } = makeTools((u) => {
    if (u.includes('s2-proxy.test')) { calls.s2++; throw new Error('HTTP 429 from s2-proxy.test: too many requests') }
    if (u.includes('esearch.fcgi')) { calls.eutils++; throw new Error('HTTP 429 from eutils: too many requests') }
    return { status: 200, body: '{}' }
  }, { s2BaseUrl: 'https://s2-proxy.test' })
  let s2msg = ''
  try { await tools.pubmed_get_s2_detail.execute({ paperId: 'DOI:10.1/aaa' }, S('p4')) } catch (e) { s2msg = String(e.message) }
  add('S2 429: exactly 3 attempts (1 + 2 retries), then error', calls.s2 === 3 && /HTTP 429/.test(s2msg))
  const retrySleeps = sleeps.filter((ms) => ms >= 500)
  add('S2 429 backoff is 1s+2s (±25% jitter), not the 61s full ladder', retrySleeps.length === 2 && retrySleeps[0] >= 750 && retrySleeps[0] <= 1250 && retrySleeps[1] >= 1500 && retrySleeps[1] <= 2500)

  // 多源合并：pubmed 与 s2 双双 429 → perSource 各自报错、互不拖垮
  const r = await tools.pubmed_search_papers.execute({ query: 'x', sources: ['pubmed', 's2'] }, S('p4'))
  const psP = r.perSource.find((p) => p.source === 'pubmed')
  const psS = r.perSource.find((p) => p.source === 's2')
  add('unified 429: perSource reports pubmed + s2 errors', psP != null && /HTTP 429/.test(psP.error || '') && psS != null && /HTTP 429/.test(psS.error || ''))
  add('NCBI 429: still the full 7 attempts (1 + 6 retries)', calls.eutils === 7)
}

// ---- 5) P3: budget does not break the normal path (recovers on attempt 3) ----
{
  let n = 0
  const { tools } = makeTools((u) => {
    if (u.includes('s2-proxy.test')) { n++; if (n <= 2) throw new Error('HTTP 429 from s2-proxy.test: slow down'); return { status: 200, body: S2_PAPER } }
    return { status: 200, body: '{}' }
  }, { s2BaseUrl: 'https://s2-proxy.test' })
  const r = await tools.pubmed_get_s2_detail.execute({ paperId: 'DOI:10.1/aaa' }, S('p5'))
  add('S2 429×2 then 200: succeeds on attempt 3', n === 3 && r.paper != null && r.paper.s2Id === 'S2x')
}

// ---- 6) P4: sessionGraphs LRU cap — 40 sessions → size 32, oldest evicted,
// write chains cleaned, current session never evicted, data loss observable
// as an empty re-created graph (documented in D4). White-box via source patch:
// the factory exposes its private Maps on globalThis when patched in. ----
{
  const P4_ANCHOR_GRAPH = 'function getSessionGraph(key) {'
  const P4_ANCHOR_SKOF = 'function sessionKeyOf(exec) {'
  const p4Source = source
    .replace(P4_ANCHOR_GRAPH, 'globalThis.__P4_WATCH = { sessionGraphs, graphWriteChains }\n  ' + P4_ANCHOR_GRAPH)
    .replace(P4_ANCHOR_SKOF, 'globalThis.__P4_SKOF = sessionKeyOf\n  ' + P4_ANCHOR_SKOF)
  if (!p4Source.includes('globalThis.__P4_WATCH') || !p4Source.includes('globalThis.__P4_SKOF')) {
    console.log('P4 PATCH FAIL (anchor not found)')
    process.exit(1)
  }
  const ARTICLE = {
    pmid: '99900001', doi: '10.99/p4', title: 'LRU eviction synthetic article about hippocampal biomarkers',
    abstractText: 'Hippocampal biomarkers drive memory consolidation research.',
    meshTerms: [{ descriptorName: 'Hippocampus' }],
  }
  const S4 = (id) => ({ agent: { id }, signal: AbortSignal.timeout(30000) })
  const registerP4 = new Function(p4Source + '\n; return registerPubmedTools')()
  const p4tools = {}
  registerP4({ get: () => undefined }, {
    defineTool: (o) => o,
    register: (d) => { p4tools[d.name] = d },
    // enrichment is best-effort: hard network errors are tolerated and the
    // article still lands in the graph (same behavior graph-test.mjs relies on)
    httpGet: async () => { throw new Error('network not used in this test') },
    sleep: () => Promise.resolve(),
    storage: {
      loadUserGraph: () => null,
      saveUserGraph: () => true,
      clearUserGraph: () => true,
    },
  })
  const W = () => globalThis.__P4_WATCH
  const get = (id) => p4tools.pubmed_graph_get.execute({ scope: 'session' }, S4(id))

  // a. seed sessions 0..5, give session 'evo-5' data + a write-chain entry
  for (let i = 0; i <= 5; i++) await get('evo-' + i)
  await p4tools.pubmed_graph_add.execute({ articles: [ARTICLE] }, S4('evo-5'))
  await p4tools.pubmed_graph_commit.execute({ confirm: true }, S4('evo-5'))   // empty-session commit still registers a write chain
  // b. create sessions 6..39 → evictions kick in at 33 total; evicted: evo-0..7
  for (let i = 6; i <= 39; i++) await get('evo-' + i)
  // c. touch a survivor and give it data
  await p4tools.pubmed_graph_add.execute({ articles: [ARTICLE] }, S4('evo-30'))
  const W1 = W()
  add('P4: sessionGraphs capped at 32', W1.sessionGraphs.size === 32)
  const evicted = ['evo-0', 'evo-1', 'evo-2', 'evo-3', 'evo-4', 'evo-5', 'evo-6', 'evo-7']
  add('P4: oldest 8 sessions evicted from the Map', evicted.every((k) => !W1.sessionGraphs.has(k)))
  add('P4: sessions 8..39 survive', Array.from({ length: 32 }, (_, i) => 'evo-' + (i + 8)).every((k) => W1.sessionGraphs.has(k)))
  add('P4: evicted session write chain cleaned', !W1.graphWriteChains.has('evo-5'))
  // graph_add 走 withGraphLock → 幸存者的写链条目在后续淘汰后仍在（此处无后续淘汰，验证条目存在）
  add('P4: survivor write chain entry intact', W1.graphWriteChains.has('evo-30'))
  // d. black box: evicted session's data is gone (empty re-created graph)…
  const evictedGet = await p4tools.pubmed_graph_get.execute({ scope: 'session' }, S4('evo-5'))
  add('P4: evicted session graph re-created empty (nodeCount 0)', evictedGet.session.stats.nodeCount === 0)
  // …while a survivor keeps its data
  const survivorGet = await p4tools.pubmed_graph_get.execute({ scope: 'session' }, S4('evo-30'))
  add('P4: survivor session keeps its data', survivorGet.session.stats.nodeCount > 0)
}

// ---- 7) P4: sessionKeyOf hardened fallback chain ----
{
  const skof = globalThis.__P4_SKOF
  add('sessionKeyOf: agent.id wins', skof({ agent: { id: 'a1' }, sessionId: 's1', requestId: 'r1' }) === 'a1')
  add('sessionKeyOf: sessionId fallback', skof({ sessionId: 's1', requestId: 'r1' }) === 's1')
  add('sessionKeyOf: requestId fallback', skof({ requestId: 'r1' }) === 'r1')
  add('sessionKeyOf: all missing → shared default', skof(undefined) === 'default' && skof({}) === 'default' && skof({ agent: {} }) === 'default')
}

for (const [name, ok] of checks) console.log((ok ? 'PASS' : 'FAIL') + '  ' + name)
const fails = checks.filter(([, ok]) => !ok).length
console.log(fails ? `V044 TEST FAIL (${fails})` : 'V044 TEST OK')
process.exit(fails ? 1 : 0)
