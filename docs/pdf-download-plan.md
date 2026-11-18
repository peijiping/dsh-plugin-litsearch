# 「点击下载即得到 PDF」技术实现方案（v2）

> **版本**：v2 · 2026-11-15，替代 2026-11-14 的 v1。
> **调研对象**：当前工作区 `dsh-plugin-litsearch`（README v0.4.0），以及用户指定的 `参考代码/` 下四个项目。
> **方式**：只读源码与测试，未改任何代码。文中「当前项目」的位置可点击跳转；「参考代码」的位置统一用 `参考代码/<项目>/<文件>:<行号>` 标注，完整路径见附录 D。
> **一句话结论**：四个参考项目里，两个根本不下载 PDF（只给链接 + 浏览器打开），两个下载但只落盘并返回本地路径；**没有任何一个做「扫描用户下载目录、按标题/DOI 打分自动认领」**。v1 里最复杂、风险最高的那一块应当删除，改为「同源交付字节 + 失败给可点击链接 + 用户主动选文件导入」。

---

## 0. v1 → v2 修订说明

| # | v1 的做法 | v2 改为 | 依据 |
| --- | --- | --- | --- |
| 1 | 失败后登记 `awaiting-claim`、扫描 `~/Downloads`、按 DOI/标题打分、自动或确认入库、24h 超时回退 | **全部删除**。失败给可点击链接；需要入库时由用户点「我已下载，导入」选文件，Host 校验后直接 `downloaded` | 四个项目无一实现此闭环；浏览器下载目录不可控，猜测必然带来误认领与隐私争议（详见第 9 章） |
| 2 | 新增 `PdfStatus` 枚举值 `awaiting-claim`、`PdfClaim`/`PdfClaimCandidate` 结构、5 个认领端点、3 个新设置项 | **不新增状态、不新增持久化字段、不改两处 `PDF_STATUSES`**，只新增 2 个端点 | 参考项目都把状态面压到最小；少一份状态就少一处不一致与回归 |
| 3 | 解析层做 `PdfCandidate` 评分模型、版本枚举、7 种解析器、7 天缓存 + 500 条 LRU | **收敛为三源并发聚合 + 固定优先级 + URL 级去重 + 首个成功即返回**，缓存只做可选负缓存 | `dsh-pubmed` 的 `mergeOaLocations` / `downloadBestPdf`、`paper-search-mcp` 的 `download_with_fallback` 都证明「优先级 + first-success」够用 |
| 4 | 只校验 `%PDF-` 开头、直接 `writeFile` 覆盖 | **补** HTML 拦截页体签名、`%%EOF` 尾部完整性、`.part` + `rename` 原子写、导入时的 DOI 弱身份校验 | `dsh-pubmed/lib/index.js:137-149`、`paper-search-mcp/.../public_pdf.py:20-53` |
| 5 | 只讲「浏览器打开候选直链」 | **升级为链接清单**：OA 直链 / DOI 落地页 / EPMC JATS 网页全文 / arXiv HTML 全文，全部一次给出 | `paper-search-pro` 把「给一个稳定链接 + 自动打开」当作全文交付本身；`dsh-web-search` 的 arXiv PDF→HTML 改写 |
| 6 | 合规写成原则条款 | **写进数据结构**：订阅链接不算 OA、受限源 `url=null`、高风险源默认关闭、能力矩阵如实标注 | `paper-search-pro/scripts/search_export/deeplink.py:180-205`、`dsh-pubmed` 的 `isOaLocation` |
| 7 | 5 个阶段 + 流式代理 + 目录监听 | **3 个阶段**，流式代理与目录监听移入「明确不做」 | 参考项目都刻意收敛功能面（`dsh-pubmed/docs/00_roadmap.md:199-201`） |

**保留不变的 v1 结论**：① 现在的「下载」是 Host 代下并落盘，浏览器从没收到字节；② 「浏览器能开、插件下不了」的根因是身份与反爬，不是链接错；③ 同源 `attachment` 端点 + `Content-Disposition` 是正确的交付方式；④ 提升成功率靠解析层而非请求头；⑤ 不复用 Cookie、不绕 Cloudflare/付费墙、不碰 Sci-Hub。

---

## 1. 四个参考项目是怎么解决 PDF 的

### 1.1 总览

| 项目 | 形态 | 下 PDF 吗 | 交付给用户的东西 | 对付费墙 | 对我们的价值 |
| --- | --- | --- | --- | --- | --- |
| `dsh-pubmed-main` | DSH 纯模型工具插件（JS，无 router） | **下**，但由模型显式 `download:true` 触发，Host `writeFileSync` 落盘 | 本地路径字符串 + 一张去重后的 OA 链接清单 | 只把订阅 DOI 落地页当信息展示，不下载 | **同为 DSH 插件，解析层与候选链几乎可以照搬思路** |
| `paper-search-mcp-main` | Python MCP + CLI（20+ 数据源） | **下**，`download_*` 工具写 `./downloads` | 本地路径字符串；`read_*` 返回抽取文本 | 不绕；Sci-Hub 是默认关闭的 opt-in 兜底 | **下载校验强度、原子落盘、能力边界声明** |
| `dsh-web-search-main` | DSH 网页抓取插件 | **不下**，明确把二进制判为 `SEARCH_UNSUPPORTED` | 网页 → Markdown/纯文本 | README 直说「抓取没有你的登录态」 | **抓取加固、错误分类、按 host 限流、信任栅栏** |
| `paper-search-pro-main` | Claude/Codex Skill（检索报告） | **完全不下**，frontmatter 把 PDF 下载列为能力边界 | DOI 落地页链接 + 自包含 HTML 报告 + BibTeX/RIS/CSV；报告写完自动 `open` | 付费/受限平台 `url=None`、只给可粘贴检索式 | **把「拿到全文」重新定义为链接交付，是简化 v1 的直接依据** |

### 1.2 `dsh-pubmed-main`：同为 DSH 插件，最值得抄解析层

- **发现与落盘分两步**：`pubmed_fetch_pdf_oa` 的 `download` 默认 `false`，首次只返回 `locations[]`（含 `source/version/license/isBest/alsoIn`）与 `bestPdfUrl`，渲染器提示「Call again with `download:true`」；`参考代码/dsh-pubmed-main/lib/pubmed-core.js:2552-2562, 2633, 2661`。这是刻意不「点击即下载」的确认闸门。
- **三源并发聚合**：Unpaywall + Europe PMC `fullTextUrlList` + OpenAlex `best_oa_location/locations`，`Promise.allSettled` 并发、单源失败写 `sourceErrors` 不拖垮整次调用；`lib/pubmed-core.js:2438-2458`。
- **去重键保留 query string**：`lib/pubmed-core.js:2402-2428`，注释明确 `?pdf=render` 与不带 query 是不同资源；排序只做「PDF 直链优先 → isBest → 其余」两档，不做打分。
- **候选链状态机**：逐个尝试 `pdfUrl`，失败记入 `attempts[]` 换下一个，全失败时给出可行动文案「用浏览器打开 `locations`，或走 `fetch_fulltext`」；`lib/pubmed-core.js:2522-2550`。
- **字节层校验**：`fetch` → `Buffer` → 前 1KB 找 `%PDF`，否则按 `<!doctype|<html|<?xml` / `text/html` 判为「consent wall / paywall / Cloudflare challenge」并抛错；`lib/index.js:125-149`。文件名用 PMID/DOI hint，默认落 `~/.dsh/dsh-pubmed-pdfs/`。
- **不做什么**：不解析 PDF 内容（保持纯 JS 免构建，`docs/00_roadmap.md:201`）、不引付费代理（`:199`）、不做 Web UI 卡片/下载按钮（`docs/03_v0.4.4-plan.md:328`）、订阅链接不算 OA（`lib/pubmed-core.js:2501-2503`）。
- **明确不能抄**：它没有 router、没有 `Content-Disposition`、没有 `localFileAddress` 预览、没有把字节交给浏览器；甚至**没有 SSRF 校验**（第三方 API 返回的 URL 直接 `fetch`、`redirect:'follow'`）。我们要做同源交付，必须自己补端点与信任栅栏。

### 1.3 `paper-search-mcp-main`：下载派的工程强度

- **契约**：所有 `download_*` 工具签名 `(paper_id, save_path) -> str`，返回**本地路径**；`read_*` 返回 `pypdf` 抽取文本。全库没有 `@mcp.resource`、没有 base64、没有附件下载端点（`paper_search_mcp/server.py:861-926`、`tool_cli.py:78-97`）。它隐含「client 与 server 同机同文件系统」。
- **统一降级链**：`download_with_fallback` 顺序为「源生下载 → OA 仓库（arxiv→openaire→core→europepmc→pmc）→ Unpaywall → 可选 Sci-Hub」，固定优先级 + 首次成功即返回，用 `attempted_urls` 集合去重；`server.py:479-574, 1165-1280`。
- **三级内容校验**（最值得抄）：`%PDF-` magic（`server.py:366-368`）、`%%EOF` 落在尾部 2KB + `PdfReader` 可解析 + 首页标题匹配（`academic_platforms/public_pdf.py:20-53`）、降级链下载后用前 3 页文本核 DOI/标题（token F1 ≥ 0.6，`server.py:425-476`）。
- **原子落盘**：`.part` 临时文件 + `os.replace`，失败不覆盖已有好文件；`public_pdf.py:42-53`、`server.py:342-354`。大小上限分级（公共源 50 MiB、arXiv 100 MiB）。
- **合规与凭据**：机构连接器只是「用户自备 API key 放 header、调用时从环境读、不落盘、不跟随重定向、错误脱敏带稳定 `[code]`」，`docs/INSTITUTIONAL_CONNECTORS.md:27-39`；**没有** Cookie/EZproxy/Shibboleth 代登录。Sci-Hub 默认关闭（`use_scihub: bool = False`，测试 `tests/test_fallback.py:30-60` 断言不会被调用），README `:242-250` 明确「不由我们推荐、法务风险因辖区而异、用户自负」。
- **不要抄**：`sci_hub.py` 的 `verify=False`、浏览器 UA 伪装、爬 `embed/iframe` 解析；`europepmc.py:283-299` / `pmc.py:310-325` 仅凭 Content-Type 就写盘的弱校验；真实站点在线测试。整个「绕过付费墙」路径在我们的方案里不做。

### 1.4 `dsh-web-search-main`：抓取加固，二进制是明确边界

- **四级 ladder + 单一总预算**：direct → tunnel → Playwright render → extract，每级取 `Math.min(超时, 剩余预算)`，预算按每次请求起算；`src/fetch.ts:147-162, 534-750`。
- **二进制判为不支持**：`BINARY_TYPE` 含 `application/pdf`，`finalize()` 直接抛 `SEARCH_UNSUPPORTED`；`FetchOutcome.body.content` 类型是 `string`，接口层就不支持字节；`src/fetch.ts:60-74, 165-174, 480-487`。
- **PDF 场景唯一可直接借的一招**：`src/arxiv-url.ts:30-71` 把 `arxiv.org/pdf/<id>` 改写成 `arxiv.org/html/<id>` 读 HTML 全文，注释写明「arXiv PDF 是二进制，否则会被拒绝」。
- **工程做法**：`classifyFailure()` 统一错误码 + `Retry-After`（`src/errors.ts:51-85`）、按 host 的进程级信号量且 permit 覆盖整个重试（`src/semaphore.ts:93-99`、`src/transport.ts:249-281`）、冷却与永久错误区分（`src/health.ts:102-111`）、信任栅栏「loopback + `sec-fetch-site != cross-site` + Origin/Host 一致 + `no-store`/`no-referrer`」（`src/bridge.ts:59-82`）、有界流式读入站请求体（`:35, 85-100`）。
- **不能抄**：它**没有** SSRF 校验（只校验 scheme，重定向不复查目标 IP）、体积上限是「先读全文再截断」、没有响应体空闲超时、没有 `Content-Disposition`/`stream.pipe` 回传字节、客户端无 `window.open`/`<a download>`。这几块都要自己写。

### 1.5 `paper-search-pro-main`：不下载，反而把体验做完整了

- **边界写进 frontmatter 且有测试锁死**：`SKILL.md:3, 26-28`「要按 DOI 下 PDF 请用 `paper-downloader-portable`」，`tests/test_skill_frontmatter.py:21-33` 把这个边界当回归断言。交付物清单里**没有 PDF**（`references/output_files.md:31-62`）。
- **全文交付 = 稳定落地页链接 + 自动打开浏览器**：每篇给 `https://doi.org/<doi>`，HTML 报告里 `window.open(paper.doiUrl, "_blank", "noopener,noreferrer")`（`assets/webartifacts_app/paper-report/src/components/papers/PaperSheet.tsx:87`）；报告生成完立即 `open "$SEARCH_DIR/report.html"`，`SKILL.md:687-698` 写明「不要等用户开口」。用户浏览器自带 Cookie / 校园网身份，天然适配机构订阅。
- **合规是数据结构不是口号**：A/B/C 三档平台，B/C 档 `url: None` + `paste_only` note，`scripts/search_export/deeplink.py:19-23, 180-205`，单元测试 `tests/test_search_export_deeplink.py:148-177` 锁死 CNKI/IEEE 不给可点击 URL；中文库 helper 直接 `NEVER download or cache subscription full text`（`scripts/yiigle_helper.py:41-46`）。
- **稳定标识**：`paper_id` 用 DOI > arXiv > OpenAlex > PMID > `md5(title)` 兜底，跨进程一致（`scripts/types.py:277-296`、`tests/test_stable_ids.py:14-30`）。**可作为文件命名键，但项目里没有「回读下载目录匹配记录」的实现**。
- **不抄**：它内部解析了 `pdf_url`/`oa_locations` 却因「display path 不输出」而完全不进交付物（`scripts/types.py:252-256`、`generate_exports.py:218-236`）——「采而不用」对我们的目标是浪费。我们的产品要「拿到全文」，就必须把**一个最佳 OA 直链**直接做成可点击项。

### 1.6 对 v1 的四个冲击

1. **没有任何参考项目做「扫描下载目录自动认领」**。v1 第 9 章设计的新状态、打分器、确认列表、TTL、隐私边界，在四个项目里连雏形都找不到。这不是「别人没想到」，而是「浏览器下载目录不可控 + 误认领代价高于收益」的一致选择。
2. **两个项目根本不下 PDF，却照样解决了「拿到全文」**：链接 + 浏览器 + Zotero/机构账号。说明「一键拿到文件」可以拆成两个更简单的目标：Host 能拿就交付字节，拿不到就把用户送到能拿的地方。
3. **下载派也只返回本地路径，不把字节交给浏览器**。因此 v1 保留的「同源 `attachment` 端点」是四个项目都没有的**差异化能力**，应作为阶段 1 唯一重点，而不是被认领机制稀释。
4. **共同语言是「严格内容校验 + 原子写 + 如实的能力边界」**。当前项目已有 `%PDF-` 与 SSRF 逐跳校验（比参考项目还严），缺的是尾部完整性、HTML 拦截页体签名、原子写，以及把合规写进数据结构。

---

## 2. 当前项目：读代码得出的事实（v1 已核实，此处压缩）

### 2.1 一次点击的完整链路

```
[客户端] DownloadButton → TaskPane.downloadPaper() / startBatchDownload()（最多 5 并发）
   → POST /tasks/:id/papers/:paperId/download  (x-dsh-litsearch-write + session)
[Host] router → service.downloadPdf()
   → resolvePdf(paper) → pdfCandidates + Unpaywall → fetchPdf(逐候选) → persistPdf(写盘)
   → 返回 JSON 信封 { status, bytes, filename, path, url? }
[客户端] 更新状态 + toast；从不接收二进制，也不触发原生下载
```

| 环节 | 位置 |
| --- | --- |
| 按钮 / 单篇 / 批量 | [DownloadButton.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/DownloadButton.tsx#L84-L92)、[TaskPane.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/TaskPane.tsx#L311-L345) |
| 客户端 API | [api.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/api.ts#L352-L362) |
| Host 路由与服务 | [router.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L750-L757)、[service.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/tasks/service.ts#L802-L844) |
| 候选 / 抓取 / 落盘 | [oa.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/oa.ts#L16-L115)、[store.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts#L82-L233) |

### 2.2 路由与请求层现状

| 事实 | 说明 |
| --- | --- |
| 端点 | `/download`（POST，JSON 信封）、`/fulltext`（GET，EPMC JATS→HTML）、`/recheck`（POST）、`/files/reveal`（POST）、`/export`（GET，**唯一带 `attachment` 的先例**，[router.ts sendFile](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L124-L133)） |
| 没有 | GET 二进制端点、流式转发、PDF 的 `Content-Disposition`、把字节交给浏览器 |
| 信任栅栏 | `isTrusted()` 校验 loopback Host + 拒绝 `sec-fetch-site: cross-site`；写端点另需 `x-dsh-litsearch-write: 1` 且 `content-type` 含 `application/json`；`?session=` 供无法带头的 GET 使用（[router.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L77-L103)） |
| `fetchPdf` 已有 | http/https + DNS 后拒绝私网且**每跳重定向复查**、手动跟随最多 5 跳、20s 总超时、`content-length` + 流式双上限、`%PDF-` 前 5 字节校验、Cloudflare 关键字识别、401/402/403/429 分类（[store.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts#L146-L212)） |
| `fetchPdf` 缺 | `<!doctype\|<html\|<?xml` 这类 HTML 拦截页体签名、`%%EOF` 完整性、`cf-ray`/`server` 头与登录跳转识别、按 chunk 重置的空闲超时、`Retry-After` |
| `persistPdf` | 两次 `writeFile` 直接覆盖（缓存 `<root>/pdfs/<sha256>.pdf` + 可读文件名），**没有原子写**（[store.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts#L215-L233)） |
| 状态机 | `PdfStatus` 8 值 / `PdfFailureReason` 5 值，`isManualPdfFailure()` 已把「浏览器可能能打开」分流（[types.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/types.ts#L211-L232)）；枚举在 `states.ts` 与 `router.ts` **各存一份** |
| 已有兜底 | `/fulltext` 把 JATS 转成只读 HTML；`localFileAddress` 预览已下载 PDF；`reveal` 打开文件管理器；`autoDownloadPdf` 任务完成后串行下最多 10 篇 |

### 2.3 数据源与候选链

| 源 | `pdfUrl` 来源 | 性质 | 备注 |
| --- | --- | --- | --- |
| PubMed / PubTator | 恒空 | 摘要落地页 | 需靠 DOI/PMCID 反查 |
| OpenAlex | `best_oa_location.pdf_url` | 静态直链为主 | **不按 DOI 反查 `locations[]`** |
| Europe PMC | `fullTextUrlList` 中 `documentStyle=pdf` 且 `availabilityCode=OA/F` | 出版商原文 / `?pdf=render` | 只在「该源命中」时解析 |
| Crossref | `link[]` 中 `content-type=application/pdf` | **可能是 TDM 链接** | 未检查 `intended-application`/`license` |
| Semantic Scholar / arXiv / GS | `openAccessPdf.url` / Atom pdf link / `resources[].link` | 多为静态直链 | 相对可靠 |
| Unpaywall | `url_for_pdf` + `oa_locations[]` | OA 直链 | **仅 `contactEmail` 非空时启用**，默认不生效（[oa.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/oa.ts#L75-L115)） |

跨源合并时 `mergeRecord` 是「第一个非空 `pdfUrl` 获胜」（[identity.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/identity.ts#L135-L150)），渲染页可能压过静态直链。`resolvePdf` 已在下载前做了「静态直链 → Unpaywall → 渲染页」重排（[store.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts#L95-L103)），方向正确，但候选池仍太窄。

### 2.4 面向本需求的缺口（按优先级）

| # | 缺口 | 影响 |
| --- | --- | --- |
| G1 | 没有二进制交付端点 | 点完只看到 toast 与路径，浏览器 Downloads 没有文件 |
| G2 | 失败响应不带可点击链接（`url` 仅成功时赋值） | 用户只能自己复制 DOI 再找，v1 的「手动」痛点没解决 |
| G3 | 候选池窄：OpenAlex 不按 DOI 反查、EPMC 解析不复用、Unpaywall 默认关闭 | 大量条目「没有可尝试的 PDF 地址」（11-14 实测） |
| G4 | 内容校验偏弱、落盘非原子 | HTML 拦截页可能被当成功；写失败留下半截 `.pdf` |
| G5 | 文件名可能含中文，裸 `filename="..."` 会乱码 | 原生下载的文件名不可用 |
| G6 | 无按 host 并发 / `Retry-After` / 登录跳转分类 | 批量打同一出版社易 429；失败文案不够可行动 |
| G7 | `download` 是 POST 且要求 JSON 写头 | 不能「点击即导航」；导入 PDF 的 `application/pdf` 请求会被 `hasWriteIntent()` 拒绝 |
| G8 | 无解析结果缓存（含负缓存） | 批量重试反复打上游 |

---

## 3. 目标、非目标与验收

| 项 | 内容 |
| --- | --- |
| **T1** | OA 文献点击「下载」后，浏览器下载管理器**确实收到一个 PDF**，文件名可读 |
| **T2** | 后台拿不到时，**一次动作**即可在浏览器打开可用的替代路径（OA 直链 / DOI 落地页 / 网页全文），不再复制链接 |
| **T3** | 用户愿意把浏览器保存的文件入库时，**一次选文件**即完成，状态与预览/Zotero/统计全部对齐 |
| **T4** | 不回归右侧栏预览、Zotero 附件、批量下载、模型 `literature_download`、全文台账 |
| **T5** | 新增行为可解释、可关闭、可审计，不越过合规边界 |
| **非目标** | 不承诺 100% 自动下载；不做浏览器扩展；不接管系统下载目录；不做 PDF 解析/OCR；不引入 PDF 解析依赖或账号体系；不扫描用户下载目录 |

**验收口径**（比 v1 更可测）：

| 指标 | 口径 | 目标 |
| --- | --- | --- |
| 一键到位率 | 点击后 ≤2 次动作拿到文件（含浏览器打开/保存） | 显著高于现状 |
| 原生交付正确性 | Downloads 中文件名 = `readableFilename`、字节与 `pdfRoot` 一致、`%PDF-` 开头 | 100% |
| 误入库率 | 状态为 `downloaded` 但内容不是目标论文 | **0**（不自动匹配，用户选的文件就是目标） |
| 失败分流正确率 | `blocked`/`paywalled`/`not-pdf`/`no-candidate` 各给出对应动作条 | 100% |
| 回归 | 预览 / Zotero / 批量 / 导出 / 模型指令 | 无退化 |

---

## 4. 总体设计：两条路径 + 一个可选导入

```
                  ┌─────────────────────────────────────────────┐
                  │ 解析层：三源并发聚合 → 去重 → 固定优先级      │
                  │ 产出 links[]（可点击）+ 有序 PDF 候选         │
                  └────────────────┬────────────────────────────┘
                                   │
                  ┌────────────────▼────────────────────────────┐
                  │ 抓取层：逐候选 → 严格校验 → 原子落盘         │
                  └───────┬────────────────────────┬─────────────┘
                       成功│                        │失败（带 reason + links）
                  ┌───────▼──────────┐      ┌──────▼──────────────────────┐
                  │ A 同源 attachment│      │ B 行内动作条：浏览器打开    │
                  │ GET .../file     │      │ 直链/落地页/网页全文/重试   │
                  │ → 原生下载       │      └──────┬──────────────────────┘
                  └──────────────────┘             │用户已保存，想入库
                                            ┌──────▼──────────────────────┐
                                            │ C 手动导入：<input type=file>│
                                            │ → 校验 → persistPdf → 状态  │
                                            └─────────────────────────────┘
```

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 浏览器直接跨域 fetch 出版社 | 否 | CORS 必失败；`dsh-web-search` 也只做服务端抓取 |
| Host 维护 Cookie / 机构会话 | 否 | 四个项目一致不做；`paper-search-mcp` 的「机构连接器」只是用户自备 API key |
| 原生下载的字节来源 | **Host 已落盘的字节**，经同源端点回传 | 零重复抓取、可校验、复用 sha256 缓存；四个项目都没有这层，是我们的增量 |
| 拿不到时 | **给可点击链接，交给用户浏览器** | `paper-search-pro` 验证过的产品形态，天然带用户会话/机构授权 |
| 浏览器保存后入库 | **用户主动选文件导入**，不扫描、不猜测 | 可靠性最高、隐私侵入为零、实现成本最低（§9.4） |
| 是否新增状态枚举 | **否** | 不碰 `states.ts`/`router.ts` 两份 `PDF_STATUSES`，回归面最小 |
| 流式上游代理 | **不做** | 失败发生在响应头之后难以优雅报错；落盘方案的代价只是一次本地读盘 |
| 缓存 | 只做解析结果的内存负缓存（可选） | 字节已有 sha256 去重缓存，避免 v1 的 7 天 TTL + LRU 过度设计 |

**关于「两阶段发现 → 确认」**：`dsh-pubmed` 让模型默认只返回链接清单，是因为模型可能在用户没同意时写磁盘。本插件的下载由用户点按钮或模型明确指令触发，**意图已经明确，不需要再加确认弹窗**。要借鉴的是「把链接清单作为一等公民输出」与「候选链失败后给出可点击替代路径」。

---

## 5. 解析层：三源聚合，不做打分

### 5.1 数据结构

```ts
// src/search/oa.ts
export type PdfLinkKind = 'pdf' | 'landing' | 'html-fulltext' | 'oa-page'
export type PdfLinkSource =
  | 'metadata' | 'publisher-rule' | 'unpaywall' | 'openalex'
  | 'europepmc' | 'arxiv' | 'doi'

export interface PdfLink {
  url: string
  kind: PdfLinkKind
  source: PdfLinkSource
  labelKey: string        // 走 locales，不在服务端拼中文
  oa?: boolean            // 是否确认开放获取；订阅落地页为 false
  license?: string        // 有就带，供 Crossref TDM 过滤与用户判断
}
```

**不做**：`version: published|accepted|submitted` 枚举、`PdfCandidate` 打分、`host_type` 权重。理由：`dsh-pubmed` 与 `paper-search-mcp` 都只按「直链优先 → 渲染页兜底」二档排序 + 首个成功即返回，实测足够；打分带来的代码量与误排序风险不划算。

### 5.2 解析器清单

| 解析器 | 触发 | 产出 | 取舍 |
| --- | --- | --- | --- |
| 记录内链接 | 恒有 | `paper.pdfUrl`、`paper.url`、DOI 落地页 | 零成本，保留 |
| 出版商固定规则 | DOI 前缀白名单命中 | BMC/Springer/Frontiers/PLOS/Nature 直链 | 保留现有 5 类；**不新增「试订阅站」式探测** |
| **Unpaywall** | 有 DOI | `best_oa_location.url_for_pdf` + `oa_locations[]` | `contactEmail` 为空时跳过，但**在设置页/失败提示里明确引导填写**（现状唯一的零代码收益点） |
| **OpenAlex 按 DOI 反查**（新增） | 有 DOI 且记录内无 `pdfUrl` | `best_oa_location` + `locations[].pdf_url` | 免费、无 key；用 `mailto` 进 polite pool；`api.openalex.org/works/https://doi.org/<doi>` |
| **Europe PMC 按 DOI 反查**（新增） | 有 DOI 或 PMCID 且不是该源命中 | `fullTextUrlList` 中 `availabilityCode=OA/F` 且 `documentStyle=pdf` | 抽出 `europepmc.ts` 的 `pickPdfUrl` 复用；`?pdf=render` 降级为最后兜底 |
| arXiv | 有 arXivId | `arxiv.org/pdf/<id>` + **`arxiv.org/html/<id>`（网页全文）** | HTML 改写照搬 `参考代码/dsh-web-search-main/src/arxiv-url.ts:56-71` |
| PMC OA Service / tar.gz | — | — | **不做**（需解包选文件，复杂度高） |
| Crossref `link[]` | 仅该源命中 | 只有 `license` 明确 CC/OA 时才当 PDF 直链 | **必须过滤 `intended-application=text-mining`**（合规红线，§8） |

三源查询用 `Promise.allSettled`，单源失败记入 `sourceErrors` 但不阻塞主流程（照搬 `dsh-pubmed/lib/pubmed-core.js:2438-2458`）。**去重键 = 完整 URL 去掉 `#fragment`、统一 `http→https`，保留 query string**（`lib/pubmed-core.js:2402-2411`），重复项合并 `alsoIn` 来源。排序只做两档：

1. 静态 PDF 直链（含出版商规则、OA 直链）
2. 渲染页/落地页（`?pdf=render`、`/pmc/articles/.../pdf/`、`doi.org`）

同档保持来源顺序：`metadata / publisher-rule → unpaywall → openalex → europepmc → render`。下载时按此顺序逐个尝试，`attempts[]` 记录每次失败，全失败时汇总最优原因（沿用现有 `blocked > paywalled > not-pdf > failed`）。

### 5.3 `links[]` 是一等公民

`PdfDownloadResult` 在**成功和失败时都返回** `links: PdfLink[]`，至少包含：

| kind | URL | 用途 |
| --- | --- | --- |
| `pdf` | 最优 OA 直链（失败时为第一个候选） | 「用浏览器打开 PDF」主按钮 |
| `landing` | `https://doi.org/<doi>` 或 `paper.url` | 机构订阅/登录后人工取全文 |
| `html-fulltext` | 现有 `/tasks/:id/papers/:paperId/fulltext`（EPMC JATS）、arXiv HTML 全文 | 「看网页版全文」 |
| `oa-page` | Unpaywall/OpenAlex 的 `oa_url`（若有） | OA 副本列表 |

这样 T2 不依赖任何新端点：客户端只负责把 Host 给的 URL 用 `window.open(url, '_blank', 'noopener,noreferrer')` 打开（与 `paper-search-pro` 的 `PaperSheet.tsx:87` 一致）。**客户端不自己拼 URL、不回传 URL 给 Host**。

### 5.4 缓存（可选，阶段 2）

按 `doi:<lowercase>` / `pmcid:` 键，进程内 `Map`，只缓存「查过且无结果」的负结果 6 小时 + 成功解析结果 1 小时，上限 200 条。不做落盘、不做 7 天 TTL、不缓存字节（字节已有 sha256 去重缓存）。

---

## 6. 抓取、校验与落盘

### 6.1 严格校验链（新增，参考 `public_pdf.py` / `dsh-pubmed`）

在现有 [fetchPdf](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts#L146-L212) 内集中实现，不散落到候选循环：

```ts
type FetchOutcome =
  | { kind: 'pdf'; buffer: Buffer }
  | { kind: 'paywalled' | 'blocked' | 'not-pdf' | 'too-large' | 'unsafe'; detail: string }
  | { kind: 'failed'; detail: string; retryable: boolean; retryAfterMs?: number }
```

| 校验 | 规则 | 依据 |
| --- | --- | --- |
| 头部 | 前 1024 字节必须含 `%PDF-`（允许前置空白/BOM）；**不信任 URL 后缀与 Content-Type** | `dsh-pubmed/lib/index.js:140-143`、mcp `server.py:366-368` |
| HTML 拦截页体签名 | 头部匹配 `<!doctype\|<html\|<?xml` 或 `content-type: text/html` → `not-pdf`；含 `Just a moment`/`cf-mitigated`/`Enable JavaScript and cookies`/`sign in`/`access denied`/`purchase` → 细分 `blocked`/`paywalled` | `dsh-pubmed/lib/index.js:144-149`；现有实现已有一部分 |
| 尾部完整性 | 尾部 2KB 内必须含 `%%EOF` | mcp `public_pdf.py:32` |
| 体积 | `content-length` + 流式累计双上限（现有 `pdfMaxMb` 默认 30MB） | 现状已正确；`dsh-web-search` 的「先读全文再截断」不可抄 |
| 身份（仅导入时） | 前 64KB 中若出现明确不同的 DOI → 拒绝；否则接受（用户主动选的文件即可信） | mcp `server.py:425-476` 的轻量版，**不引入 PDF 解析依赖** |
| 原子写 | `.part` 临时文件 → `rename`；失败清理临时文件，绝不覆盖已有好文件 | mcp `public_pdf.py:42-53`、`dsh-pubmed` 无此项（要补） |

> 不引入 `pypdf`/`pdfjs`：本插件是纯 TS ESM、无构建依赖（项目约束），且 mcp 的 `PdfReader` 级校验对「用户点下载」场景收益有限。`%%EOF` + 头部签名已能挡住 HTML 拦截页与截断文件。

### 6.2 信号 → 分类 → 动作（沿用现有状态机，不新增枚举）

| 信号 | `status` / `reason` | 动作 |
| --- | --- | --- |
| 200 + `%PDF-` + `%%EOF` | `downloaded` | 落盘 + 原生下载 |
| 200 + HTML 且含 Cloudflare 关键字 / `server: cloudflare` / `cf-ray` | `blocked` | 浏览器打开 PDF 直链 |
| 200 + HTML 且含 `sign in`/`login`/`purchase`/`subscribe` | `paywalled` | 浏览器打开落地页 |
| 302/303 跳到 `login.`/`idp.`/`sso.`/`shibboleth` 域 | `paywalled` | 浏览器打开落地页 |
| 401 / 402 | `paywalled` | 同上 |
| 403 / 429（含 `Retry-After`） | `blocked` | 稍后重试提示；批量降并发 |
| 200 + 其它 HTML / 非 PDF 二进制 | `failed` / `not-pdf` | 浏览器打开 + 网页全文 |
| 5xx / 网络错误 / 超时 | `failed` | 重试一次（500ms 退避） |
| 超限 / 私网地址 | `failed` | 超限提示浏览器打开；私网不重试、不给浏览器 |

实现顺序：先按体签名/响应头/重定向目标细分 `blocked` 与 `paywalled`，再兜底 `not-pdf`；不要把「HTML 落地页」一律当成程序失败。`resolvePdf` 汇总规则保持现状（按「用户可行动性」而非「最后一个错误」）。**不新增 `PdfStatus` 值**，因此 `states.ts` 与 `router.ts` 两份枚举、`reconcilePdfFiles`、筛选接口、注解接口都不用改。

### 6.3 请求头、超时、并发

| 项 | v2 | 说明 |
| --- | --- | --- |
| UA | 保留现有浏览器 UA；配置 `contactEmail` 时追加 `(+mailto:...)` | 可识别身份，参考 `dsh-pubmed` 的 `dsh-pubmed/1.0` 思路 |
| `From` | `contactEmail`（若有） | RFC 9110 礼貌标识 |
| `Accept` / `Accept-Language` | 保持现状 | — |
| `Referer` | **默认不设**；仅同注册域 + 确认 OA 直链 + 显式开关时补一次 | 避免「伪造来源绕过防盗链」争议 |
| `Cookie` / `Origin` / `Sec-Fetch-*` | **从不设置** | 合规红线；四个项目一致不复用用户会话 |
| 超时 | `pdfTimeoutMs` 默认 60s，与检索 20s 解耦；`AbortSignal.any([caller, timer])`，**单一总预算不按跳重置** | `dsh-web-search/src/fetch.ts:147-162, 547-550` |
| 重定向 | 保持手动跟随 + 每跳 SSRF 复查（现状比参考项目更严，保留） | 新增「跳到登录域」分类 |
| 并发 | Host 侧按注册域信号量**（同域 ≤2）**，permit 覆盖整次候选尝试；全局批量仍 5 | `dsh-web-search/src/semaphore.ts:93-99`、`transport.ts:249-281` |
| 退避 | 仅 5xx/网络错误重试 1 次（500ms）；429 读 `Retry-After` 并冷却该域；403 不重试 | `dsh-web-search/src/errors.ts:51-85`、`health.ts:102-111` |
| 下载节奏 | 批量下载串行/低并发，避免同出版社突发 | `dsh-pubmed/lib/pubmed-core.js:2591-2592` |

---

## 7. 交付层与交互

### 7.1 端点 A：同源附件（阶段 1 核心）

```
GET /dsh-litsearch/api/tasks/:taskId/papers/:paperId/file
    ?disposition=attachment|inline
    &session=<sessionId>
```

1. 复用 `isTrusted(req)`；GET 不需要写头。`readSessionId()` 已支持 `?session=`，浏览器导航式 GET 可关联工作目录。
2. 校验任务/论文存在、`pdfStatus === 'downloaded'`、`pdfFile` 经 `resolve()` 后位于 `resolvePdfRoot(workspace)` 之内（防路径穿越与旧数据脏值）；`stat` 确认为文件。
3. `writeHead` + `createReadStream().pipe(res)`，`res.on('close')` 时销毁流。

```ts
// src/host/router.ts（示意）
async function sendPdf(res: ServerResponse, file: PdfFileRef, attachment: boolean): Promise<void> {
  res.writeHead(200, {
    'content-type': 'application/pdf',
    'content-length': file.bytes,
    'content-disposition': contentDisposition(file.filename, attachment),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  const stream = createReadStream(file.path)
  res.on('close', () => stream.destroy())
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

function contentDisposition(filename: string, attachment: boolean): string {
  const type = attachment ? 'attachment' : 'inline'
  const fallback = filename.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
```

文件缺失返回 404 + 纯文本（不要 JSON，否则浏览器会把它当文件下载），并把状态置为 `missing`（复用 `recheck` 语义）。现有导出 `sendFile` 的裸 `filename="..."` 中文乱码问题**不改导出行为**，只在新端点做对。

服务层新增 `pdfFile(id, paperId, workspace)`：查任务 → 校验状态与路径包含关系 → `stat` → 返回 `{ path, filename, bytes }`；失败时把状态改 `missing`。

### 7.2 客户端触发原生下载

```ts
// src/client/api.ts
export function pdfFileUrl(taskId: string, paperId: string, download = true): string {
  const params = new URLSearchParams({ disposition: download ? 'attachment' : 'inline' })
  const session = currentSessionId()
  if (session !== '') params.set('session', session)
  return `${BASE}/tasks/${encodeURIComponent(taskId)}/papers/${encodeURIComponent(paperId)}/file?${params}`
}

export function triggerNativeDownload(url: string): void {
  const link = document.createElement('a')
  link.href = url
  link.rel = 'noreferrer'
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
}
```

要点：**同源**是前提（跨域 `<a download>` 会被忽略）；必须在 POST 返回 `downloaded` 后调用；用 `<a>` 而非 `location.href` 以免导航走 SPA；服务端已带 `attachment`，不需要 `download` 属性；若面板 iframe sandbox 拦截下载，提供「在新标签打开同源 URL」的次级链接。`autoDownloadPdf` 与批量下载的后台任务**不触发**浏览器下载（避免打开页面就弹一堆文件），只在用户当前点击的单篇上触发。

### 7.3 失败分支：行内动作条

```ts
const result = await downloadPaperPdf(taskId, paperId)
if (result.status === 'downloaded') {
  triggerNativeDownload(pdfFileUrl(taskId, paperId))   // 更新状态 + toast 照旧
} else {
  showActionBar(result.reason, result.links)           // 不静默、不只留 toast
}
```

```
后台未能获取 PDF：出版商拒绝了访问（HTTP 403，已尝试 3 个候选）
[用浏览器打开 PDF] [打开原文页] [看网页版全文] [重试] [我已下载，导入]
```

- 「用浏览器打开 PDF」用 `window.open(link.url, '_blank', 'noopener,noreferrer')`；`no-candidate` 时按钮改为「打开原文页」（DOI 落地页）。
- 「看网页版全文」优先 arXiv HTML 全文，其次现有 `/fulltext`（EPMC JATS）；都没有则隐藏。
- 批量弹窗按 `reason` 分桶显示「需手动获取 / 失败」，并给「批量打开链接」入口（用户主动逐条点击，不自动弹一堆标签页）。
- 失败文案统一走 `pdfFailureMessage()`，不在组件里手写。

### 7.4 端点 C：手动导入（替代 v1 的自动认领）

```
POST /tasks/:id/papers/:paperId/import
  headers: x-dsh-litsearch-write: 1
           x-dsh-litsearch-session: <sessionId>
           content-type: application/pdf
  body:   PDF 原始字节（浏览器 File 对象直接作为 fetch body）
```

**两个真实工程坑，v1 只写了一个**：

1. 现有 `readBody()` 的 `MAX_BODY_BYTES = 1_000_000`（[router.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L57)），30MB PDF 会被拒 → 导入端点必须单独流式读请求体，边读边按 `pdfMaxMb` 限流。
2. 现有 `hasWriteIntent()` 要求 `content-type` 含 `application/json`（[router.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L98-L103)）→ 导入端点必须单独校验「自定义写头 + session + `content-type: application/pdf`」，**不能复用 `hasWriteIntent()`**。

Host 侧流程：流式读 → `%PDF-` + `%%EOF` + 体积校验 → 前 64KB DOI 弱身份校验（与其它明确 DOI 冲突则拒绝并保留原状态）→ 复用 `persistPdf()` 写缓存与 `pdfRoot` → `pdfStatus='downloaded'`、`pdfFile=<绝对路径>`、清 `pdfError`、`rev++`。用户目录里的原文件**不移动、不删除**。

文件名沿用 `readableFilename()`（已含 PMID/DOI/paperId 后缀，正是 `paper-search-pro` 那套稳定标识思路），同一篇重复导入时 sha256 相同则直接标记 `downloaded`，不重复写。

### 7.5 状态面（刻意保持不变）

| 场景 | 状态 | 新增字段 |
| --- | --- | --- |
| Host 下载成功 | `downloaded` + `pdfFile` | 无 |
| 失败 | 沿用 `blocked`/`paywalled`/`failed`/`html-only` + `pdfError` | 无 |
| 浏览器打开后未导入 | **保持原失败状态** | 无（不设「等待认领」） |
| 手动导入成功 | `downloaded` + `pdfFile` | 无 |

「未导入」在 UI 上表现为失败状态仍在 + 动作条常驻，不需要持久化中间状态。这是 v2 相比 v1 最大的简化：**零新增枚举、零新增持久化字段、零定时器/TTL**。若阶段 3 要做路径统计，用下载日志区分 `host` / `manual-import`，不写进 `PaperState`。

---

## 8. 合规边界（写成可执行规则，而非口号）

| 规则 | 落地位置 | 依据 |
| --- | --- | --- |
| 只抓公开 OA 的 PDF；订阅文献只给落地页 | `isOaLocation()` 等价判断：仅直链 + `availabilityCode=OA/F` + 明确 license 才算 OA | `dsh-pubmed/lib/pubmed-core.js:2431-2435, 2501-2503` |
| 付费/受限平台不给可点击的「PDF 直链」，只给「原文页」 | `links[]` 中 `oa: false` 的落地页单独标注，不进下载候选 | `paper-search-pro/.../deeplink.py:180-205` 的 `url: None` 思路 |
| Crossref `link[]` 过滤 `intended-application=text-mining` 与不明 license | `crossref.ts` | TDM 需单独协议 |
| 高风险/需密钥的源显式 opt-in、默认关闭，能力矩阵如实标注「仅元数据」 | 设置项 + README | `paper-search-mcp/server.py:238-239`、`README.md:242-250` |
| 不复用/转发用户 Cookie、机构 SSO、EZproxy；不绕 Cloudflare/验证码/DRM | `fetchPdf` 请求头白名单 | 四个项目一致；`paper-search-mcp/docs/INSTITUTIONAL_CONNECTORS.md:114` |
| 不实现 Sci-Hub 类来源；不把插件做成通用代理 | 候选不接受客户端任意 URL | `dsh-pubmed/docs/00_roadmap.md:199` |
| 尊重 `429`/`Retry-After`，按域限流；礼貌池用 `mailto`/`From` 标识 | §6.3 | `dsh-web-search/src/errors.ts:74-85` |
| 批量下载前提示收窄范围；`autoDownloadPdf` 最多 10 篇（现状） | 设置页文案 | 现有实现已约束 |
| 不扫描/监听用户下载目录，不持久化与任务无关的文件信息 | §9 | `paper-search-pro` 的 `url=None` 式边界写法 |

诊断信息脱敏：错误串不带完整上游 URL 的 query、不带凭据、不带响应体（参考 `paper-search-mcp/.../institutional.py:56-60` 的稳定 `[code]` 前缀）。

---

## 9. 被否决的方案（保留评估记录）

### 9.1 v1 的「待认领 → 自动扫描入库」，不采用

v1 第 9 章设计：`pdfStatus='awaiting-claim'` + `PaperState.pdfClaim`（标题/DOI/作者/来源/原始状态/超时/候选列表）+ 5 个端点 + 切回面板时扫描 `~/Downloads` + 按 DOI/标题/文件名打分（≥85 自动入库、55–84 确认列表）+ 24h TTL 回退 + 可选 `fs.watch` 监听。

**否决理由：**

| 维度 | 问题 |
| --- | --- |
| 参考依据 | 四个项目**无一实现**；两个直接把「用户浏览器保存」当作终点，两个压根不把字节交给浏览器 |
| 可靠性 | 浏览器保存目录可由用户任意修改、可能「每次询问」、可能写 `.crdownload`、mtime 可能是上游 `Last-Modified`；跨设备/改文件名必漏 |
| 正确性 | 误认领会把别的 PDF 记成目标论文，污染 `pdfFile`、Zotero 附件与全文台账；v1 自己也承认「宁可漏认领，不可错认领」 |
| 隐私 | 常驻或定期读取用户下载目录，需要额外开关与显著提示 |
| 复杂度 | 新增状态枚举（两处同步）、持久化结构、匹配打分器、确认列表、TTL、批量角标、3 个设置项、5 个端点；阶段 1 的改动量被稀释，回归面大 |
| 收益 | 只是省掉「点一次选文件」；而 `<input type=file>` 的可靠性是 100%，且用户本来就知道自己刚存到哪 |

**替代**：§7.4 的手动导入。用户动作从「复制 DOI → 新标签 → 登录 → 保存 → 回面板扫描等待」变成「浏览器打开 → 保存 → 点导入 → 选文件」，可靠性最高、隐私侵入为零。

若未来确实需要自动入库，前置条件应是「浏览器扩展或 File System Access API 能把保存动作显式交给插件」，而不是猜测目录。

### 9.2 其余不做

| 方案 | 不做的理由 |
| --- | --- |
| 上游流式代理 `GET .../stream?candidate=<index>` | 失败发生在 `writeHead` 之后只能断连；落盘方案只多一次本地读盘，且四个项目都没有这层 |
| 目录监听 `fs.watch` | v1 已列为「默认不做」，v2 直接移除 |
| Headless 浏览器过 Cloudflare / 验证码 | 依赖重、易失效、合规越界（`dsh-web-search` 也只把 render 作为可选 rung，且明确不装浏览器） |
| 代理池 / UA 轮换 / 伪造 Referer 防盗链 | 越界且不可维护 |
| PDF 解析 / OCR / 元数据抽取 | 项目约束「不引入 PDF 解析依赖」；`dsh-pubmed` 也刻意只搬运字节 |
| 把 `download` 改成 GET / 302 跳上游 | 现有 POST 承担状态写入与批量编排；浏览器导航无法带自定义写头 |

---

## 10. 分阶段实施（3 个阶段，各自可独立上线/回滚）

### 阶段 1：原生下载闭环（最高优先级）

**目标**：OA 文献点击后浏览器真的收到文件；失败时一键打开可用链接；浏览器保存的文件能一键导入。

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | `pdfFile()`（状态/路径包含关系/stat/缺失时置 `missing`） | `src/host/tasks/service.ts` |
| 2 | `GET .../papers/:paperId/file` + RFC 5987 `contentDisposition()` + 流式回传 | `src/host/router.ts` |
| 3 | `POST .../papers/:paperId/import`：独立流式读体、独立写头校验、`%PDF-`/`%%EOF`/体积/DOI 弱校验、复用 `persistPdf()` | `src/host/router.ts` + `src/host/tasks/service.ts` |
| 4 | `PdfDownloadResult` 增 `links?: PdfLink[]`（成功/失败都带）；`resolvePdf` 失败回填最优候选直链 | `src/search/types.ts` + `src/host/pdf/store.ts` |
| 5 | `links[]` 组装：记录内链接 + DOI 落地页 + 网页全文（EPMC `/fulltext`、arXiv HTML） | `src/search/oa.ts` + `src/host/tasks/service.ts` |
| 6 | `fetchPdf` 补 HTML 拦截页体签名、`%%EOF`、Cloudflare 响应头、登录跳转分类；`persistPdf` 改 `.part` + `rename` | `src/host/pdf/store.ts` |
| 7 | `pdfFileUrl()` / `triggerNativeDownload()` / `importPdf()`；成功触发原生下载、失败展示动作条与「我已下载，导入」 | `src/client/api.ts` + `TaskPane.tsx` + `PaperPane.tsx` |
| 8 | 中英文案：用浏览器打开 / 打开原文页 / 看网页版全文 / 我已下载，导入 / 导入失败原因 | `src/client/locales.ts` |

**验证**：`pnpm build && pnpm build:client && pnpm typecheck:client && pnpm test`；新增 `test/pdf-file.test.ts`（未下载→404、路径越界→400、正常→头与字节一致、中文文件名 RFC 5987）、`test/pdf-import.test.ts`（非 PDF / 超限 / DOI 冲突 / 正常入库 / 重复导入）；手工按附录 B 矩阵跑一遍；回归预览、Zotero、批量、模型 `literature_download`、导出。
**回滚**：只删两个新端点与客户端触发逻辑；没有状态枚举/持久化结构变化，旧任务 JSON 完全兼容。

### 阶段 2：解析层与抓取加固

| # | 改动 |
| --- | --- |
| 1 | `oa.ts`：三源并发聚合（Unpaywall 引导、OpenAlex 按 DOI、`europepmc.ts` 抽出 `pickPdfUrl` 复用）+ 保留 query 的去重 + 两档排序 + `links[]` 补全 |
| 2 | `identity.ts`：`mergeRecord` 选择 `pdfUrl` 时静态直链优先于渲染页（不再先到先得） |
| 3 | `crossref.ts`：过滤 TDM 与不明 license 的 `link[]` |
| 4 | `store.ts`：`FetchOutcome` 分类集中化、`Retry-After`、按注册域信号量（同域 ≤2）、`pdfTimeoutMs` 与单一总预算、可选负缓存 |
| 5 | 设置页把 `contactEmail` 的作用写成「按 DOI 补 OA 候选（不保证直链可下）」，避免 11-14 之后再次出现夸大文案 |

**验证**：扩展 `test/oa.test.ts`（三源 allSettled、去重保留 query、排序、单源失败不阻塞）、`test/download-store.test.ts`（HTML 体签名、`%%EOF`、原子写、429 退避）；30 篇 OA 文献对比阶段 1/2 自动成功率；无 DOI/无 PMCID/Unpaywall 超时均不阻塞。

### 阶段 3：体验与可观测（可选）

- 记录每次下载的 `{doi, source, reason, latency, origin: 'host' | 'manual-import'}`（只记日志元数据，不记内容、不写进任务 JSON）。
- 概览页展示「自动成功率 / blocked 占比 / paywalled 占比 / 导入次数」。
- 批量下载弹窗按 `reason` 分桶 + 「批量打开链接」。
- 评估是否把全局并发 5 改为「全局 5 + 单域 2」（阶段 2 已在 Host 侧实现，客户端可不动）。
- **不做**：`autoDownloadPdf` 触发浏览器下载、目录监听、流式代理。

---

## 11. 风险与需要拍板的点

| # | 问题 | 建议 |
| --- | --- | --- |
| R1 | 原生下载后文件同时存在于工作目录与浏览器下载目录 | 接受重复；工作目录副本支撑预览与 Zotero |
| R2 | 面板 iframe sandbox 可能拦截下载 | 实测后保留「新标签打开同源 URL」降级链接 |
| R3 | Unpaywall 需邮箱，默认不可用 | 优先用 OpenAlex（无需 key）；设置页引导填邮箱，不夸大效果 |
| R4 | 大 PDF 超过 30MB 被拒 | 保持默认，超限提示在浏览器打开；手动导入也走同一上限 |
| R5 | 出版社 ToS 对自动化下载态度不一 | 仅 OA + 用户主动单篇/小批量；按域限流 |
| R6 | 浏览器打开的是 PDF 阅读器而非直接保存 | 接受；阅读器内一次保存即可，随后可用「我已下载，导入」 |
| R7 | 是否保留 `/download` POST 语义 | **保留**（状态写入 + 批量编排）；新增 GET 只负责交付字节 |
| R8 | 手动导入是否值得做 | **值得**：它是替代自动认领的唯一闭环，成本约 1 个端点 + 1 个文件选择器 |
| R9 | 导入端点放宽 `content-type` 会否削弱写保护 | 不放宽「自定义写头 + session + isTrusted」，只把 JSON 类型要求换成 `application/pdf`，并在测试中覆盖伪造跨站请求被拒 |
| R10 | 中文文件名 `filename*` 在旧浏览器表现 | 同时给 ASCII `filename` 回退，实测 Chrome/Edge/Safari |

---

## 附录 A：当前项目代码索引

| 主题 | 文件 |
| --- | --- |
| 下载按钮 / 单篇批量编排 | [DownloadButton.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/DownloadButton.tsx)、[TaskPane.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/TaskPane.tsx#L311-L511)、[PaperPane.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/PaperPane.tsx#L486-L494) |
| 客户端 API / 本地预览 | [api.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/api.ts#L352-L402)、[client/index.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/index.ts#L254-L269) |
| Host 路由（含信任栅栏、`sendFile`、`readBody`） | [router.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts) |
| 下载服务 / 全文兜底 | [service.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/tasks/service.ts#L802-L860) |
| 候选、抓取、落盘、命名 | [store.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts)、[root.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/root.ts#L11-L31) |
| 候选生成与 JATS→HTML | [oa.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/oa.ts) |
| 跨源合并 / 状态与失败类型 / 设置 | [identity.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/identity.ts#L135-L150)、[types.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/types.ts#L210-L252)、[config.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/config.ts) |
| 现有测试 | `test/oa.test.ts`、`test/download-store.test.ts`、`test/download-scope.test.ts` |

## 附录 B：手工验证矩阵

| 类别 | 预期（阶段 1 后） | 预期（阶段 2 后） |
| --- | --- | --- |
| arXiv 预印本 | 自动下载 + Downloads 出现文件 | 同左，另可看 HTML 全文 |
| PLOS ONE / BMC / Frontiers | 自动下载 | 同左 |
| PMC 开放获取 | 可能 `blocked` → 浏览器打开 → 保存后导入 | 通过 OpenAlex/EPMC 反查提升为自动成功 |
| Elsevier / Wiley 订阅 | `paywalled` + 打开原文页 → 登录后保存 → 导入 | 同左（不可消除） |
| Cloudflare 仓储页 | `blocked` + 打开 PDF 直链 → 导入 | 同左（不绕过） |
| 无 DOI / 无 PMCID | `no-candidate` + 打开原文页 | 同左 |
| 中文标题论文 | Downloads 文件名不乱码（`filename*` + ASCII 回退） | 同左 |
| 导入专项 | 非 PDF / 超限 / DOI 冲突被拒且状态不变；正常入库后预览与 Zotero 可用 | 同左 |
| 回归 | 批量下载、模型 `literature_download`、`autoDownloadPdf`、导出、reveal | 同左 |

验证命令：

```bash
pnpm build && pnpm build:client && pnpm typecheck:client && pnpm test
curl -sS -D - -o /tmp/out.pdf \
  "http://127.0.0.1:<port>/dsh-litsearch/api/tasks/<id>/papers/<paperId>/file?disposition=attachment"
```

## 附录 C：术语

- **落地页**：出版商/仓储的摘要页或 `https://doi.org/<doi>`，不是 PDF 文件。
- **渲染页**：仓储把 PDF 包在 HTML 查看器里的地址（如 `?pdf=render`），后台请求常被拦。
- **OA / TDM / polite pool**：开放获取 / 文本挖掘专用链接（需单独协议）/ 用邮箱标识的礼貌请求池。
- **同源附件**：Host 把已落盘的字节经同源 `GET` + `Content-Disposition: attachment` 交给浏览器下载管理器。
- **手动导入**：用户用文件选择器亲自指定刚保存的 PDF，Host 校验后写入 `pdfRoot` 并更新状态；不扫描、不猜测目录。

## 附录 D：参考项目证据索引

根目录：`/Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/参考代码/`

| 项目 | 关键文件（相对该项目根） |
| --- | --- |
| `dsh-pubmed-main` | `lib/pubmed-core.js:2321-2458`（OA 三源）、`:2402-2428`（去重排序）、`:2501-2503`（订阅链接不算 OA）、`:2522-2562`（候选链 + 两阶段）、`:2588-2598`（串行下载）、`lib/index.js:67-96, 125-177`（超时 + 下载校验 + 落盘）、`skills/dsh-pubmed/SKILL.md:19, 54`、`docs/00_roadmap.md:199-201`、`test/pdf-oa-test.mjs` |
| `paper-search-mcp-main` | `paper_search_mcp/server.py:294-363, 366-368, 396-476, 479-574, 735-744, 861-926, 1165-1280`、`paper_search_mcp/academic_platforms/public_pdf.py:13-57`、`docs/INSTITUTIONAL_CONNECTORS.md:3-39, 60-121`、`docs/OAUTH_PROTECTED_RESOURCE.md:23-29`、`README.md:242-250`、`tests/test_fallback.py:30-60`、`tests/test_semantic_pdf_validation.py` |
| `dsh-web-search-main` | `src/fetch.ts:60-74, 140-190, 534-750`、`src/errors.ts:51-85`、`src/semaphore.ts:93-99`、`src/transport.ts:249-281`、`src/health.ts:102-111`、`src/arxiv-url.ts:30-71`、`src/bridge.ts:35, 59-100`、`test/fetch-hardening.test.ts`、`test/failure-classification.test.ts`、`README.zh-CN.md:685-695` |
| `paper-search-pro-main` | `SKILL.md:3, 26-28, 366, 607-609, 687-698`、`scripts/search_export/deeplink.py:19-23, 180-205`、`scripts/types.py:246-296`、`scripts/yiigle_helper.py:41-46`、`scripts/generate_exports.py:218-236`、`assets/webartifacts_app/paper-report/src/components/papers/PaperSheet.tsx:87`、`tests/test_skill_frontmatter.py:21-33`、`tests/test_stable_ids.py:14-30` |
