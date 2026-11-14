# 「点击下载即得到 PDF」技术实现方案

> 调研对象：`dsh-plugin-litsearch`（package.json v0.3.5）
> 调研方式：只读源码与测试，不做任何代码改动。
> 结论以当前工作区代码为准，文中所有代码位置均可点击跳转。

---

## 0. 结论摘要

1. **现在的「下载」不是把 PDF 交给浏览器，而是 Host 代下并落盘。**
   客户端点击后调用 `POST /dsh-litsearch/api/tasks/:id/papers/:paperId/download`，Host 在 Node 进程里抓取候选 URL、校验 `%PDF-`、写入工作目录，最后返回一个 **JSON 信封**（含本地路径）。浏览器自始至终没有收到 PDF 字节，也没有触发原生下载。

2. **「浏览器手工能打开、插件下不了」的根因不在链接，而在身份与反爬。**
   Host 请求没有浏览器会话、机构授权和 Cookie；出版社/聚合站的 Cloudflare、登录墙、验证页会把 Node 请求打成 403 或返回 HTML。再怎么改 UA，也拿不到需要会话的内容——这是合规边界内不可消除的一部分。

3. **最小可行改造只需两件事，就能覆盖绝大多数「一键拿到文件」的诉求：**
   - Host 成功后，新增一个**同源 `attachment` 端点**，把已经下载好的字节交给浏览器，走浏览器原生下载（`Content-Disposition: attachment`）。
   - Host 失败时，把**最优候选直链**一并返回给客户端，提供一个「用浏览器打开」动作，让浏览器带着用户自己的会话去打开/保存。这正是当前用户手工做的动作，只是从「复制链接→新开标签→再保存」缩成一次点击。

4. **真正提升自动成功率的是「解析层」，不是请求头。**
   现有候选链只有 `paper.pdfUrl`、少量出版商规则、Europe PMC/PMC 渲染页、arXiv；Unpaywall 仅在配置了 `contactEmail` 时启用；OpenAlex 只取了 `best_oa_location.pdf_url`，不会按 DOI 反查；跨源合并时 `pdfUrl` 是「先到先得」而非「质量优先」。这些才是可以低成本提升的空间。

5. **明确不做**：转发/复用用户 Cookie、破解 Cloudflare 或验证码、伪造机构授权、把 Crossref 的 TDM 链接当免费全文、代理 Sci-Hub 类来源。这些既越界，也会把插件变成不可维护的爬虫。

---

## 1. 现状：读代码得出的事实

### 1.1 一次点击的完整链路

```
[客户端] DownloadButton.onClick
   → TaskPane.downloadPaper() / startBatchDownload()  (最多 5 并发)
   → api.downloadPaperPdf()  POST /tasks/:id/papers/:paperId/download
        headers: content-type: application/json
                 x-dsh-litsearch-write: 1
                 x-dsh-litsearch-session: <sessionId>
[Host] router.ts handleTasks → op === 'download'
   → service.downloadPdf()
        → resolvePdf(paper)          // 生成候选、逐个尝试、Unpaywall 补充
             → fetchPdf(url)         // 手动跟随重定向、UA、超时、体积上限、%PDF- 校验
        → persistPdf(buffer)         // 写 <storage>/pdfs/<sha256>.pdf + 用户目录可读文件名
   → 返回 JSON: { paperId, status, bytes, filename, path, url? }
[客户端] 更新 downloads 状态 + toast；不接收二进制
```

关键代码位置：

| 环节 | 位置 |
| --- | --- |
| 按钮组件（纯动作按钮，不涉及下载协议） | [DownloadButton.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/DownloadButton.tsx#L84-L92) |
| 单篇触发 | [TaskPane.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/TaskPane.tsx#L311-L345) |
| 批量触发与 5 并发 | [TaskPane.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/TaskPane.tsx#L414-L511)、[BATCH_CONCURRENCY](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/TaskPane.tsx#L1459-L1460) |
| 客户端 API | [api.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/api.ts#L352-L362) |
| Host 路由 | [router.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L750-L757) |
| 服务层下载 | [service.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/tasks/service.ts#L802-L844) |
| 候选 + 抓取 + 落盘 | [store.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts#L82-L233) |

### 1.2 路由事实

| 端点 | 方法 | 响应 | 说明 |
| --- | --- | --- | --- |
| `/tasks/:id/papers/:paperId/download` | POST | JSON 信封 | 唯一「下载」入口，返回本地路径 |
| `/tasks/:id/papers/:paperId/fulltext` | GET | `text/html` | Europe PMC JATS 渲染页，供 iframe 预览 |
| `/tasks/:id/papers/:paperId/recheck` | POST | JSON | 复核本地文件是否仍存在 |
| `/files/reveal` | POST | JSON | 调系统文件管理器定位文件（[router.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L905-L920)） |
| `/export?format=...` | GET | `attachment` 文件流 | **现有唯一的附件响应先例** |

结论：**没有 GET 二进制端点、没有流式转发、没有 `Content-Disposition: attachment` 的 PDF 响应**。唯一带附件头的是导出（[router.ts sendFile](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L124-L133)）。

换句话说：`download` **不是 302 跳转到上游**，也**不是把上游响应体透传给浏览器**，而是在 Host 进程内完成「解析候选 → 抓取 → 校验 → 落盘」，只把结果摘要以 JSON 返回。这就是「点击后拿不到文件」的直接原因。

### 1.3 请求层现有实现

[fetchPdf](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts#L146-L212) 目前的行为：

| 项 | 现状 | 备注 |
| --- | --- | --- |
| 协议/地址校验 | 只允许 http/https；DNS 解析后拒绝回环、私网、链路本地 | SSRF 防护已经比较完整，且**每一跳重定向都重新校验** |
| 重定向 | `redirect: 'manual'`，最多 5 跳 | 缺「跳转到登录/SSO」的识别 |
| 超时 | `FETCH_TIMEOUT_MS = 20_000`，整条请求一个总超时 | 没有空闲超时；大 PDF 可能被误杀 |
| 体积 | `pdfMaxMb`（默认 30MB），同时校验 `content-length` 与流式累计 | 流式读取时超限会 cancel |
| User-Agent | Chrome 126 / macOS 的浏览器 UA | 硬编码 |
| Accept | `application/pdf,application/octet-stream;q=0.9,*/*;q=0.5` | 合理 |
| Accept-Language | `zh-CN,zh;q=0.9,en;q=0.8` | 合理 |
| Referer | **未设置** | 部分出版社/仓储会校验 |
| Cookie | **没有** | 也不应该有 |
| 内容判定 | 必须以 `%PDF-` 开头；HTML 中匹配 `Just a moment` / `cf-mitigated` / `Enable JavaScript and cookies` 判为 `blocked` | 已是「识别验证页」的雏形 |
| 状态码 | 401/402 → `paywalled`；403 → `blocked`；429 → `blocked`；其余非 2xx → `failed` | 没有区分登录重定向、5xx 重试 |
| 错误分类 | `paywalled / blocked / failed / not_pdf / too_large / unsafe` | 见 [PdfFetchError](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts#L28-L41) |
| 成功返回 | `Buffer` + 命中的 URL | 只给内存，不流式给客户端 |

### 1.4 已有的状态机与失败分类

- `PdfStatus`：`unknown / available / downloaded / missing / html-only / paywalled / blocked / failed`（[types.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/types.ts#L211-L219)）。
- `PdfFailureReason`：`no-candidate / blocked / paywalled / not-pdf / failed`；`isManualPdfFailure()` 把前四类归为「浏览器可能能打开」，只有 `failed` 算程序故障（[types.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/types.ts#L227-L232)）。
- 界面已按这套分类分流：批量下载弹窗把「需手动获取」与「失败」分开计数（[TaskPane.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/TaskPane.tsx#L462-L466)）。

**这套分类是现成的资产**：新方案不需要重造状态机，只需要让「需手动获取」真正变成一键动作。

### 1.5 已下载文件的后续动作

- 「查看已下载」会先 `POST recheck` 复核文件存在，再通过 dsh 的 `localFileAddress(sessionId, path)` 在右侧栏用文档预览打开（[client/index.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/index.ts#L254-L269)）。
- 「在文件夹中显示」调用 `/files/reveal`，由 Host `spawn` `open -R` / `explorer /select` / `xdg-open`（[router.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L143-L193)）。

也就是说：**插件已经能把本地 PDF 交给 dsh 预览，但从未把 PDF 字节交给浏览器下载管理器**。

### 1.6 自动下载

设置项 `autoDownloadPdf` 是生效的：任务完成后串行下载最多 10 篇（[service.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/tasks/service.ts#L1192-L1231)）。它复用同一条 `resolvePdf → persistPdf` 链路，因此同样只落盘、不通知浏览器。

### 1.7 面向本需求的缺口清单

| # | 缺口 | 影响 | 位置 |
| --- | --- | --- | --- |
| G1 | 没有二进制交付端点 | 用户点完只能看到 toast 和路径，文件不在浏览器下载目录 | router |
| G2 | 失败响应不带候选直链（`url` 只在成功时赋值） | 客户端无法一键「用浏览器打开」 | [service.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/tasks/service.ts#L813-L843) |
| G3 | 候选无质量排序，跨源合并 `pdfUrl` 先到先得 | Europe PMC 渲染页可能压过 OpenAlex 的静态直链 | [identity.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/identity.ts#L135-L150) |
| G4 | Unpaywall 仅在 `contactEmail` 非空时启用 | 默认配置下少了一大块 OA 直链 | [oa.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/oa.ts#L76-L82) |
| G5 | OpenAlex 只读记录内的 `best_oa_location.pdf_url`，不按 DOI 反查 | PubMed/Crossref 命中且无 pdfUrl 的条目拿不到 OA 位置 | [openalex.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/providers/openalex.ts#L61-L96) |
| G6 | Europe PMC 的 `fullTextUrlList` 只在该源命中时被解析 | 其它源命中但有 PMCID 的条目不会补链接 | [europepmc.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/providers/europepmc.ts#L73-L104) |
| G7 | 没有解析结果缓存/负缓存 | 每次重试都重新打上游，批量下载时放大限流风险 | oa.ts / store.ts |
| G8 | 无 Referer | 少数出版社直链会 403 | store.ts |
| G9 | 无按宿主并发限制 | 5 并发打同一出版社容易 429 | TaskPane 固定 5 |
| G10 | Crossref `link` 未检查 `intended-application` 与许可证 | 可能把 TDM 链接当免费全文，存在合规风险 | [crossref.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/providers/crossref.ts#L87-L112) |
| G11 | 本地文件名可能含中文，直接放进 `Content-Disposition` 会乱码 | 原生下载的文件名不可用 | [store.ts readableFilename](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts#L245-L260) |
| G12 | `download` 是 POST，浏览器导航无法直接携带自定义写头 | 不能用「点击即导航」的方式简单实现 | [router.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L864-L867) |

---

## 2. 各数据源的链接类型与可下载性

### 2.1 逐源事实

| 数据源 | 记录里的 `url` | `pdfUrl` 来源 | 链接性质 | Host 能否直接拿到 PDF | 需要什么二次解析 |
| --- | --- | --- | --- | --- | --- |
| PubMed | `pubmed.ncbi.nlm.nih.gov/<pmid>/` | 恒为空串（[pubmed.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/providers/pubmed.ts#L106-L122)） | 摘要落地页 | 否 | DOI / PMCID → Unpaywall、OpenAlex、Europe PMC |
| Europe PMC | `europepmc.org/article/<src>/<id>` | `fullTextUrlList` 中 `documentStyle=pdf` 且 `availabilityCode` 为 `OA`/`F` 的第一条（[europepmc.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/providers/europepmc.ts#L95-L104)） | 多数是**出版商原文**；PMC 文章常见 `?pdf=render` | 视目标而定 | 有 PMCID 时补出版商 OA 直链；渲染页只作最后兜底 |
| OpenAlex | `primary_location.landing_page_url` 或 DOI | `best_oa_location.pdf_url`（[openalex.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/providers/openalex.ts#L61-L96)） | 静态 PDF 直链为主 | **通常可以** | 只取 best 不够；应按 DOI 反查 `locations[]` 取最优 |
| Crossref | `item.URL`（通常是 DOI 落地页） | `link[]` 中 `content-type=application/pdf` 的第一条（[crossref.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/providers/crossref.ts#L84-L115)） | 可能是 TDM / 相似度检测链接，**不一定可公开下载** | 不稳定 | 必须检查 `intended-application` 与 `license`；否则只当落地页 |
| Semantic Scholar | `paper.url` | `openAccessPdf.url`（[semanticscholar.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/providers/semanticscholar.ts#L73-L102)） | 仓储/出版商 OA 直链 | 多数可以 | 无；但链接可能过期 |
| arXiv | `arxiv.org/abs/<id>` | Atom 中 `title="pdf"` 的 link（[arxiv.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/providers/arxiv.ts#L50-L86)） | 静态 PDF 直链 | **可以** | 无；`http:` 已改成 `https:` |
| PubTator | PubMed 落地页 | 恒为空（[pubtator.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/providers/pubtator.ts#L62-L70)） | 摘要页 | 否 | 同 PubMed |
| Google Scholar（SerpAPI） | 结果链接 | `resources[].link` 中的 PDF（[googlescholar.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/providers/googlescholar.ts#L96-L117)） | 多为大学仓储/个人主页 PDF | 多数可以 | 无；注意第三方站点 ToS |

### 2.2 合并后的 `pdfUrl` 选择问题

跨源去重时（[mergeRecord](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/identity.ts#L135-L150)）：

```ts
if (base.pdfUrl === '' && extra.pdfUrl !== '') base.pdfUrl = extra.pdfUrl
```

即**第一个非空的 `pdfUrl` 获胜**，与来源顺序和并发返回顺序有关。Europe PMC 的 `?pdf=render` 因此可能压过 OpenAlex 的静态直链。

这是 G3 的直接证据，也解释了为什么「同样的文献，有时能下、有时报 blocked」。

### 2.3 当前候选链

[pdfCandidates](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/oa.ts#L16-L28) 的顺序：

1. `paper.pdfUrl`
2. 出版商固定规则（10.1186 / 10.1007 → Springer；10.3389 → Frontiers；10.1371/journal.pone → PLOS；10.1038 → Nature）
3. `https://europepmc.org/articles/<PMCID>?pdf=render`
4. `https://www.ncbi.nlm.nih.gov/pmc/articles/<PMCID>/pdf/`
5. `https://arxiv.org/pdf/<arXivId>`

随后 [resolvePdf](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts#L82-L107) 做了一次很有价值的重排：**静态直链优先、Unpaywall 次之、渲染页最后**。但候选池本身太窄，且没有版本/主机的质量信息。

---

## 3. 目标、非目标与验收口径

### 3.1 目标

- **T1**：对开放获取（OA）文献，点击「下载」后浏览器下载管理器**确实收到一个 PDF 文件**，文件名可读。
- **T2**：对后台拿不到、但浏览器能打开的文献，点击后**一次动作**即可在浏览器打开（理想情况下直接触发保存），不再要求用户复制链接。
- **T3**：不回归现有能力：右侧栏预览、Zotero 附件、批量下载、模型 `literature_download` 指令、全文台账统计。
- **T4**：所有新增抓取行为都可解释、可关闭、可审计，不越过合规边界。

### 3.2 非目标

- 不承诺 100% 自动下载；订阅文献、验证码、需机构登录的站点不在范围内。
- 不实现浏览器扩展、不接管系统下载目录。
- 不做 PDF 解析/OCR/元数据抽取。
- 不引入账号体系或代理池。

### 3.3 验收口径（建议）

| 指标 | 口径 | 目标 |
| --- | --- | --- |
| 一键成功率 | 点击后 Downloads 出现文件的篇数 / 有 OA 直链的篇数 | 观察值，先建立基线 |
| 一键到位率 | 点击后 ≤2 次用户动作即拿到文件（含浏览器打开） | 显著高于现状 |
| 误分类率 | 标为 `failed` 但实际浏览器可打开的篇数 | 趋近 0 |
| 回归 | 预览 / Zotero / 批量 / 导出 | 无退化 |

---

## 4. 总体方案

### 4.1 设计原则

1. **Host 仍是唯一出口**：所有对外抓取都在 Host 完成，保留 SSRF 校验、体积上限、超时与合规审计。
2. **浏览器只做两件事**：接收同源字节、用用户自己的会话打开上游。
3. **不引入新的运行依赖**：继续用 Node 原生 `fetch` / `fs` / `http`。
4. **状态机复用**：沿用 `PdfStatus` / `PdfFailureReason`，只补一个「候选直链」字段。

### 4.2 三层 + 一个交付层

```
                ┌──────────────────────────────────────────┐
                │ 1. 链接解析层（src/search/oa.ts）          │
                │    记录内链接 + DOI 反查 + 候选评分 + 缓存  │
                └───────────────┬──────────────────────────┘
                                │ 有序候选
                ┌───────────────▼──────────────────────────┐
                │ 2. 请求层（现 src/host/pdf/store.ts）      │
                │    请求头 / 重定向 / 超时 / 体积 / 分类      │
                └───────────────┬──────────────────────────┘
                                │ Buffer 或失败分类
        ┌───────────────────────┴─────────────────────────┐
        │ 3. 交付层（src/host/router.ts + client）          │
        │  A. 落盘 + 同源 attachment 端点 → 浏览器原生下载  │
        │  B. 失败 → 返回候选直链 → 浏览器打开              │
        └─────────────────────────────────────────────────┘
```

### 4.3 关键取舍（先给结论）

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 是否让浏览器直接跨域 fetch 出版社 | 否 | CORS 必然失败，且无法读取、无法保存 |
| 是否在 Host 维护 Cookie/会话 | 否 | 越界、脆弱、无法覆盖机构 SSO |
| 原生下载的来源 | **Host 已落盘的字节**，经同源端点回传 | 零重复抓取、可校验、可复用缓存 |
| Host 抓不到时 | **返回候选直链，浏览器打开** | 这是唯一合规且有效的兜底 |
| 是否新增流式代理 | 作为可选项，不是第一阶段 | 大多数场景落盘已够；流式只在「不想占磁盘/超大文件」时有价值 |
| 解析缓存 | 内存 TTL，不落盘 | 避免过度工程；任务状态已落盘，解析结果无需持久化 |

---

## 5. 链接解析层

### 5.1 候选模型

把「字符串数组」升级为带来源与质量信息的候选：

```ts
// src/search/oa.ts
export type CandidateOrigin =
  | 'metadata'        // paper.pdfUrl（OpenAlex/S2/arXiv/GS 给的）
  | 'publisher-rule'  // 按 DOI 前缀推导的 OA 直链
  | 'unpaywall'
  | 'openalex'
  | 'europepmc'
  | 'repository-render' // EPMC/PMC 渲染页

export interface PdfCandidate {
  url: string
  origin: CandidateOrigin
  /** 版本质量：published > accepted > submitted。 */
  version?: 'published' | 'accepted' | 'submitted'
  /** 是否指向静态文件（而非渲染页/落地页）。 */
  direct: boolean
}
```

评分规则（从高到低）：

1. `direct && version === 'published'`
2. `direct && version === 'accepted'`
3. `direct`（未知版本）
4. `publisher-rule`（`direct: true`，但排在元数据候选之后，因为它可能是订阅文章）
5. `repository-render`（永远最后）

同分时保持原顺序，并在入队前做 URL 归一化去重（去掉 `#fragment`、统一 `http→https`、去掉常见追踪参数）。

### 5.2 解析器清单

| 解析器 | 触发条件 | 请求 | 产出 | 取舍 |
| --- | --- | --- | --- | --- |
| 记录内链接 | 恒有 | 无 | `paper.pdfUrl` | 零成本，保留 |
| 出版商规则 | DOI 前缀命中白名单 | 无 | 固定 OA 直链 | 只收录**确认 OA** 的家族；不做「试订阅站」式探测 |
| Unpaywall | 有 DOI | `api.unpaywall.org/v2/<doi>?email=` | `best_oa_location.url_for_pdf` + `oa_locations[]` | 需要邮箱；**建议默认启用并在设置页说明**；无邮箱时跳过 |
| OpenAlex | 有 DOI 且记录内无 `pdfUrl` | `api.openalex.org/works/https://doi.org/<doi>?mailto=` | `best_oa_location` + `locations[]` 的 `pdf_url` | 免费、无 key、覆盖广；注意限流（polite pool） |
| Europe PMC | 有 DOI 或 PMCID | `.../search?query=DOI:"<doi>"&resultType=core&format=json` | `fullTextUrlList` 中 `availabilityCode=OA/F` 且 `documentStyle=pdf` 的 URL | 能补出版商 OA 链接；**不要**把 `?pdf=render` 提前 |
| PMC OA Service | 有 PMCID | `.../utils/oa/oa.fcgi?id=PMCxxxx` | tar.gz / FTP 链接 | **暂不做**：需要解包、选文件，复杂度高、收益低 |
| arXiv | 有 arXivId | 无 | `arxiv.org/pdf/<id>` | 直连可用，保留 |
| Crossref | 仅当记录来自 Crossref | 已有字段 | `link[]` | 必须过滤 `intended-application` 与 `license`；否则一律不当 PDF 直链 |

### 5.3 Unpaywall 的细节

- 只接受 `url_for_pdf`；若没有，才考虑 `url`，且必须满足「看起来是文件」的规则（现有实现已这样做，见 [oa.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/oa.ts#L76-L115)）。
- 优先取 `version === 'published'`；`host_type === 'publisher'` 与 `'repository'` 都可以，但前者通常需要订阅，因此排序上让 `direct` 说了算，而不是盲信 `best_oa_location`。
- 失败（404 / 无 DOI / 超时）静默返回空数组，不阻塞主流程——现有行为正确，保留。
- 缓存：按 `doi` 键，成功 7 天、失败 6 小时。

### 5.4 Europe PMC 的细节

现有 `pickPdfUrl` 要求 `availabilityCode` 为 `OA` 或 `F`，方向正确。需要补两点：

1. 当记录不是 Europe PMC 来源、但有 DOI/PMCID 时，才发起一次 `resultType=core` 查询（避免重复请求）。
2. `fullTextUrlList` 里同时存在出版商链接与 `europepmc.org/articles/...?pdf=render` 时，把后者降级到 `repository-render`。

### 5.5 缓存与负缓存

```ts
// 进程内，随宿主重启失效；不落盘，避免与任务存储耦合
interface CacheEntry { candidates: PdfCandidate[]; at: number }
const TTL_OK = 7 * 24 * 3600_000
const TTL_EMPTY = 6 * 3600_000
```

- 键：优先 `doi:<lowercased doi>`，无 DOI 用 `pmcid:` / `arxiv:`。
- 容量上限 500 条，超出按时间淘汰（简单 Map 即可，不需要 LRU 库）。
- **只缓存解析结果，不缓存 PDF 字节**（字节已有 sha256 去重缓存）。

### 5.6 失败兜底

`resolvePdf` 失败时，返回值增加：

```ts
{
  ok: false,
  status: 'blocked',
  reason: 'blocked',
  candidateUrl: candidates[0]?.url,  // 给浏览器打开用
  error: pdfFailureMessage(...)
}
```

这样客户端不需要再查任务详情，也不需要自己拼 DOI。

---

## 6. 请求层与交付层

### 6.1 三种交付方式对比

| 方案 | 做法 | 优点 | 缺点 | 建议 |
| --- | --- | --- | --- | --- |
| **A. 落盘 + 同源附件** | Host 抓到后写盘；客户端点击同源 `GET .../file?disposition=attachment` | 零重复抓取、可校验、可复用缓存、文件名可控 | 多一次本地 HTTP 读取（可忽略） | **第一阶段采用** |
| B. 上游流式代理 | `GET .../stream` 由 Host 实时转发上游字节 | 不占磁盘、首字节快 | 失败发生在响应头之后难以优雅报错；需处理背压/断连/超限 | 可选，第二阶段后 |
| C. 浏览器直开上游 | 客户端 `window.open(candidateUrl)` | 带用户会话，成功率高；零服务端成本 | 无法保证自动保存；可能停在 PDF 阅读器 | **失败兜底必备** |

推荐组合：**A 为主，C 为兜底**；B 只在明确的性能诉求下再做。

### 6.2 新增端点（方案 A）

```
GET /dsh-litsearch/api/tasks/:taskId/papers/:paperId/file
    ?disposition=attachment|inline
    &session=<sessionId>        // 可选；用于解析工作目录
```

行为：

1. 复用 `isTrusted(req)` 的信任栅栏；GET 不需要写头。现有 [readSessionId](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L89-L96) 已支持从 `?session=` 读取会话，浏览器导航式 GET 因此也能关联到正确的工作目录。
2. 校验任务与论文存在，且 `states[paperId].pdfStatus === 'downloaded'`。
3. 取 `states[paperId].pdfFile`，`stat` 确认为文件，并校验路径位于 `resolvePdfRoot(workspace)` 之内（防路径穿越/旧数据脏值）。
4. 设置响应头并流式回传：

```ts
// src/host/router.ts（示意）
async function sendPdf(res: ServerResponse, file: PdfFileRef, attachment: boolean): Promise<void> {
  res.writeHead(200, {
    'content-type': 'application/pdf',
    'content-length': file.bytes,
    'content-disposition': contentDisposition(file.filename, attachment),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  const stream = createReadStream(file.path)
  res.on('close', () => stream.destroy())
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}
```

5. 文件缺失：返回 404 + 纯文本（不要 JSON，否则浏览器会把它当文件下载下来），并让客户端把状态置为 `missing`（复用现有 recheck 语义）。

文件名编码必须兼容中文：

```ts
function contentDisposition(filename: string, attachment: boolean): string {
  const type = attachment ? 'attachment' : 'inline'
  const fallback = filename.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
```

> 现状的 `sendFile`（导出）用裸 `filename="..."`，遇到中文同样会有问题；本方案只针对 PDF 新增正确实现，不改导出行为。

### 6.3 服务层方法（示意）

```ts
// src/host/tasks/service.ts
export interface PdfFileRef { path: string; filename: string; bytes: number }

async pdfFile(id: string, paperId: string, workspace?: string): Promise<PdfFileRef> {
  const task = await this.get(id)
  findPaper(task, paperId)
  const state = task.states[paperId]
  const filePath = state?.pdfFile
  if (state?.pdfStatus !== 'downloaded' || filePath === undefined) {
    throw new SearchError('not_found', '该文献尚未下载 PDF')
  }
  const root = resolvePdfRoot(normalizeWorkspace(workspace) ?? normalizeWorkspace(task.workspace))
  if (!resolve(filePath).startsWith(`${resolve(root)}${sep}`)) {
    throw new SearchError('bad_request', '文件不在下载目录内')
  }
  const info = await stat(filePath).catch(() => null)
  if (info === null || !info.isFile()) {
    await this.setPdfState(task, paperId, { pdfStatus: 'missing', pdfFile: filePath })
    throw new SearchError('not_found', '下载文件已不存在')
  }
  return { path: filePath, filename: basename(filePath), bytes: info.size }
}
```

### 6.4 客户端触发原生下载

```ts
// src/client/api.ts
export function pdfFileUrl(taskId: string, paperId: string, download = true): string {
  const params = new URLSearchParams({ disposition: download ? 'attachment' : 'inline' })
  const session = currentSessionId()
  if (session !== '') params.set('session', session)
  return `${BASE}/tasks/${encodeURIComponent(taskId)}/papers/${encodeURIComponent(paperId)}/file?${params}`
}

// 新增小工具（可放在 DownloadButton.tsx 或独立文件）
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

要点：

- **同源**是前提。跨域 `<a download>` 会被浏览器忽略，这正是必须经 Host 回传的原因。
- `pdfFileUrl()` 必须在 POST 返回 `downloaded` 之后调用，否则服务端还没有可交付的文件。
- 用 `<a>` 而不是 `window.location.href`，避免把 dsh 单页应用导航走。
- 服务端已带 `Content-Disposition: attachment`，因此不需要 `download` 属性，也不受文件名跨域限制。
- 若面板运行在 iframe / 受限容器中，下载可能被 sandbox 拦截；需要实测并在失败时降级为「在新标签打开同源 URL」。

### 6.5 客户端状态机

```ts
const result = await downloadPaperPdf(taskId, paperId)
if (result.status === 'downloaded') {
  // 1) 更新已有状态与 toast
  // 2) 交给浏览器
  triggerNativeDownload(pdfFileUrl(taskId, paperId))
} else if (isManualPdfFailure(result.reason)) {
  // 3) 展示原因 + 主按钮「用浏览器打开」
  //    result.candidateUrl 由 Host 返回
} else {
  // 4) 真正的程序失败：保留「重试」
}
```

失败提示建议从 toast 升级为**行内可操作条**（结果卡片与论文页各一处）：

```
后台未能获取 PDF：出版商拒绝了访问（HTTP 403）
[用浏览器打开] [重试] [查看网页版全文]
```

- 「用浏览器打开」只在 `candidateUrl` 存在时显示。
- 「查看网页版全文」沿用现有 EPMC 逻辑（`html-only`）。
- 不要用「静默失败 + 只留一句 toast」，那正是当前体验的痛点。

### 6.6 请求头策略

| 头 | 取值 | 说明 |
| --- | --- | --- |
| `User-Agent` | 保持现状的浏览器 UA；如果配置了 `contactEmail`，追加 `(+mailto:...)` | 既提高兼容性，又保持可识别 |
| `Accept` | `application/pdf,application/octet-stream;q=0.9,*/*;q=0.5` | 保持 |
| `Accept-Language` | 保持 | 保持 |
| `Referer` | **仅当**候选 URL 的主机与论文落地页同注册域时，设为落地页 URL；默认关闭，按白名单开启 | 避免「伪造来源绕过防盗链」的争议 |
| `From` | `contactEmail`（如果有） | RFC 9110 的礼貌标识，替代把邮箱塞进 UA |
| `Cookie` | **从不设置** | 合规红线 |
| `Origin` / `Sec-Fetch-*` | **不设置** | 不伪装成浏览器导航 |
| `If-None-Match` / `Range` | 可选 | 仅在实现断点/缓存校验时需要 |

### 6.7 超时、重定向、体积、并发

| 项 | 建议 | 理由 |
| --- | --- | --- |
| 总超时 | PDF 单独用一个 `pdfTimeoutMs`（默认 60s），与检索的 20s 解耦 | 30MB PDF 在慢网下 20s 不够 |
| 空闲超时 | 若实现流式代理，加「连续 15s 无字节则中断」 | 防止挂死连接 |
| 重定向 | 继续保持手动跟随 + 每跳 SSRF 校验；新增「跳到登录/SSO 域」判定 | 现有实现正确，只需补分类 |
| 体积 | 保留 `content-length` + 流式双保险 | 正确 |
| 并发 | 批量仍 5 并发，但**同宿主最多 2 个**；同宿主两次请求间隔 ≥ 300ms | 降低 429 概率 |
| 重试 | 仅对 5xx / 网络错误重试 1 次，指数退避 500ms；403/429 不重试 | 避免放大封禁 |

### 6.8 可选：上游流式代理（方案 B）

只有在明确需要「不落盘」或「超大文件」时再做：

```
GET /api/tasks/:id/papers/:paperId/stream?candidate=<index>
```

- 候选由服务端解析，**不接受客户端传入任意 URL**（否则就是开放代理）；`candidate` 索引基于本次服务端候选列表，越界直接 400。
- 使用 `Readable.fromWeb(response.body).pipe(res)`。
- 先校验 `content-type` 与 `content-length`；超限直接 `res.destroy()`。
- 成功后可选 tee 到磁盘（Web Streams 的 `tee()`），让缓存与预览仍然可用。
- 失败若发生在 `writeHead` 之后，只能断开连接；因此**建议先发 `HEAD`/预取再决定**，复杂度明显高于方案 A。

**取舍**：方案 A 的延迟只多一次本地读盘（通常 <50ms），却保留了全部错误处理能力。除非有明确的大文件诉求，不建议优先做 B。

---

## 7. 拦截层：识别与降级

### 7.1 信号 → 分类

| 观察到的信号 | 判定 | `PdfStatus` / `reason` | 建议动作 |
| --- | --- | --- | --- |
| 200 + `application/pdf` + `%PDF-` | 成功 | `available` / —（落盘后为 `downloaded`） | 落盘 + 原生下载 |
| 200 + HTML，含 `Just a moment` / `cf-mitigated` / `Enable JavaScript and cookies` | Cloudflare 挑战 | `blocked` / `blocked` | 浏览器打开 |
| 200 + HTML，含 `sign in` / `login` / `access denied` / `purchase` / `subscribe` | 登录/付费墙页 | `paywalled` / `paywalled` | 浏览器打开（用户可能已有机构授权） |
| 302/303 → `login.` / `idp.` / `sso.` / `shibboleth` 域 | 认证跳转 | `paywalled` / `paywalled` | 浏览器打开 |
| 401 / 402 | 需要订阅 | `paywalled` / `paywalled` | 浏览器打开 |
| 403（`server: cloudflare` 或 `cf-ray`） | 反爬拒绝 | `blocked` / `blocked` | 浏览器打开 |
| 403（其它） | 拒绝/防盗链 | `blocked` / `blocked` | 仅在 OA 白名单宿主上补同域 Referer 重试一次，再降级 |
| 429 | 限流 | `blocked` / `blocked` | 稍后重试提示；批量时降并发 |
| 200 + `text/html` 且不是上述特征 | 落地页/摘要页 | `failed` / `not-pdf` | 浏览器打开 |
| 200 + 非 PDF 二进制 | 内容不符 | `failed` / `not-pdf` | 浏览器打开 |
| 5xx / 连接失败 / DNS 失败 | 程序故障 | `failed` / `failed` | 重试一次 |
| 超过体积上限 | 体积 | `failed` / `failed` | 提示可在浏览器打开 |
| 内网/非 http(s) 地址 | 安全拒绝 | `failed` / `failed` | 不重试，不提示浏览器 |

> 注意：`PdfStatus` 没有 `not-pdf` 取值，界面上的「返回的不是 PDF」由 `reason === 'not-pdf'` 表达，`status` 仍为 `failed`。实现时不要新增状态枚举。

### 7.2 实现位置

把分类逻辑集中在 [fetchPdf](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts#L146-L212) 内：

```ts
type FetchOutcome =
  | { kind: 'pdf'; buffer: Buffer }
  | { kind: 'paywalled'; detail: string }
  | { kind: 'blocked'; detail: string }
  | { kind: 'not-pdf'; detail: string }
  | { kind: 'failed'; detail: string; retryable: boolean }
```

不要在每个候选的循环里散落判断；`resolvePdf` 只负责「按顺序尝试 + 汇总最优失败原因」。

汇总规则应当**按用户可行动性排序**，而不是「最后一个错误」：

```
blocked > paywalled > not-pdf > failed
```

现有实现已经是这个顺序（`sawBlocked ? 'blocked' : sawPaywalled ? 'paywalled' : last.kind === 'not_pdf' ? 'not-pdf' : 'failed'`），这一层基本不用改；需要补的是响应信号（登录跳转、Cloudflare 头）与文案。

### 7.3 哪些源只能走浏览器

| 场景 | 能否后台下 | 建议路径 |
| --- | --- | --- |
| arXiv | 可以 | 直接落盘 + 原生下载 |
| PLOS / Frontiers / BMC / Nature OA | 多数可以 | 出版商规则直链 |
| PMC 开放获取 | 视文章 | 优先 Unpaywall/OpenAlex 的出版商链接；渲染页只兜底 |
| Elsevier / Wiley / Springer 订阅文章 | 不可以 | 浏览器打开 |
| Cloudflare 保护的仓储/聚合页 | 不可以 | 浏览器打开 |
| ResearchGate / Academia.edu | 不可以（ToS） | 不作为候选 |
| Google Scholar 指向的个人主页 | 多数可以 | 直接尝试；失败则浏览器打开 |

### 7.4 明确不要做

- 不用无头浏览器/Playwright 在 Host 里过验证码或 Cloudflare（依赖重、易失效、越界）。
- 不轮换 UA/IP、不使用代理池。
- 不把「返回 HTML 登录页」当成成功再让用户点开。
- 不静默吞掉失败。

---

## 8. 合规边界

### 8.1 允许（在公开 OA 范围内）

- 抓取**公开可访问**的 OA PDF：arXiv、PMC OA、PLOS、Frontiers、BMC、Nature OA、大学机构仓储。
- 使用 Unpaywall / OpenAlex / Europe PMC 的公开元数据 API，并遵守其礼貌池与限流（OpenAlex/Crossref 用 `mailto` 标识）。
- 设置合理的 UA、`From`/`mailto`，表明身份。
- 对同一宿主做速率限制与退避。

### 8.2 灰区（需谨慎、默认关闭）

- 浏览器 UA：广泛存在，但应同时提供可识别的联系方式。
- `Referer`：仅限同注册域，且只用于 OA 直链；不要为绕过防盗链伪造来源。
- Crossref `link`：很多是 TDM（文本挖掘）链接，需要单独的 TDM 协议；**未确认许可证前不要使用**。

### 8.3 禁止

- 转发、复用、伪造用户的 Cookie / 机构 SSO 会话。
- 破解或绕过 Cloudflare、验证码、付费墙、DRM。
- 使用 Sci-Hub 类来源，或把插件做成通用代理。
- 无视 `429`/`Retry-After` 继续高频抓取。
- 批量下载超出合理范围（现有批量只受并发 5 的限制，没有篇数上限；建议在文档中明确「大范围下载前先收窄条件」）。

### 8.4 与现有文档的一致性

README 已明确「出版商要求订阅、登录或人机验证时，后台程序拿不到 PDF（浏览器因为带着会话和机构授权反而能打开）」（[README.md](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/README.md#L59)）。本方案不改变这一事实，只是把「浏览器打开」从手工步骤变成产品内动作。

---

## 9. 分阶段实施建议

> 原则：先闭环、再提成功率、最后做体验与可观测。每阶段都可独立上线、独立回滚。

### 阶段 1：原生下载闭环（最高优先级）

**目标**：OA 文献点击后浏览器真的收到文件；失败时一键打开浏览器。

改动点：

1. `src/host/tasks/service.ts`：新增 `pdfFile()`（路径校验 + stat）。
2. `src/host/router.ts`：新增 `GET .../papers/:paperId/file`，实现 `Content-Disposition`（RFC 5987）与流式回传。
3. `src/search/types.ts`：`PdfDownloadResult` 增加 `candidateUrl?: string`。
4. `src/host/pdf/store.ts`：`resolvePdf` 失败时回填最优候选 URL；`fetchPdf` 补 `From` 头。
5. `src/client/api.ts`：新增 `pdfFileUrl()` 与 `triggerNativeDownload()`。
6. `TaskPane.tsx` / `PaperPane.tsx`：成功分支触发原生下载；失败分支展示行内动作条。
7. `locales.ts`：新增「用浏览器打开」「浏览器已开始下载」等中英文案。

验证：

- `pnpm build && pnpm build:client && pnpm typecheck:client`。
- 单测：新增 `test/pdf-file.test.ts`，覆盖「未下载 → 404」「路径越界 → 400」「正常 → 头与字节一致」。
- 手工：搜 arXiv 论文 → 点击下载 → 浏览器 Downloads 出现 `readableFilename` 生成的 `<作者><年份>_<标题>_<PMID|DOI|paperId>.pdf`；再点「查看已下载」仍能在右侧预览。
- 手工：找一篇 Europe PMC 渲染页被 403 的论文 → 点击后出现「用浏览器打开」，点击后浏览器能打开 PDF。
- 回归：批量下载、模型 `literature_download`、Zotero 附加 PDF。

风险与回滚：

- 若面板容器拦截下载，`triggerNativeDownload` 会静默失败；需要一个「下载未开始？点此在新标签打开」的次级链接。
- 回滚只需移除客户端触发与新增路由，状态机不变。

### 阶段 2：解析层增强

**目标**：提高 Host 自动成功率与「候选直链」的质量。

改动点：

1. `src/search/oa.ts`：
   - 引入 `PdfCandidate` 与评分排序。
   - 新增 `resolveViaOpenAlex(doi, email)`、`resolveViaEuropePmc(doi, pmcid)`。
   - 现有 `unpaywallPdfCandidates` 改为返回带 `version` 的候选。
   - 增加内存缓存（成功 7 天 / 空结果 6 小时，上限 500）。
2. `src/search/identity.ts`：`mergeRecord` 选择 `pdfUrl` 时不再「先到先得」，而是「静态直链优先于渲染页」。
3. `src/search/providers/crossref.ts`：过滤 `intended-application`，仅在许可证明确为 CC/OA 时使用 `link`。
4. `src/search/providers/europepmc.ts`：抽出可复用的 `fullTextUrlList` 解析函数，供解析层调用。

验证：

- `node --test test/oa.test.ts` 扩展：候选排序、去重、缓存命中、Crossref TDM 过滤。
- 手工矩阵：PubMed 命中（无 pdfUrl）→ 配好 `contactEmail` → 能通过 Unpaywall/OpenAlex 补到直链。
- 对比实验：同一批 30 篇 OA 文献，阶段 1 与阶段 2 的自动成功率。
- 回归：无 DOI、无 PMCID、Unpaywall 超时，均不应阻塞下载流程。

### 阶段 3：拦截识别与降级体验

**目标**：把「失败」讲清楚，并给出正确动作。

改动点：

1. `fetchPdf` 的响应分类（登录跳转、HTML 特征、Cloudflare 头）。
2. `resolvePdf` 的失败汇总规则（blocked/paywalled > not-pdf > failed）。
3. 客户端行内动作条（重试 / 用浏览器打开 / 网页版全文），批量弹窗按 `reason` 分桶。
4. 失败文案统一走 `pdfFailureMessage`，避免多处手写。

验证：

- 用已知会 Cloudflare 拦截的仓储页、订阅文章、arXiv、PLOS 各测 2 篇，检查状态与文案。
- 单测：给定 HTML 片段 → 分类正确。
- 检查「标为 failed 但浏览器可打开」的数量应趋近 0。

### 阶段 4（可选）：流式代理与按宿主限流

**目标**：支持不落盘的即点即得、超大文件、以及更温和的批量行为。

改动点：

- `GET .../stream?candidate=<index>`（服务端解析候选，拒绝任意 URL）。
- `Readable.fromWeb` 管道、超限断开、断连取消上游。
- 同宿主并发 2 + 300ms 间隔。

验证：

- 50MB 级 PDF：浏览器下载完整、无内存峰值。
- 中途取消下载：上游连接被 abort（看日志/连接数）。
- 批量 20 篇来自同一出版社：无 429，或能正确退避。

**取舍**：如果阶段 1–3 已满足需求，此阶段可以不做。

### 阶段 5：可观测与批量收口

- 记录每次下载的 `{doi, origin, reason, latency}`（只记元数据，不记内容）。
- 在设置页/概览页展示「自动成功率、blocked 占比、paywalled 占比」。
- 评估是否把批量并发从「全局 5」改为「全局 5 + 单宿主 2」。
- 评估 `autoDownloadPdf` 是否也应触发浏览器下载（建议**不**，避免打开页面就弹下载）。

---

## 10. 风险与需要拍板的点

| # | 问题 | 选项 | 建议 |
| --- | --- | --- | --- |
| R1 | 原生下载会让文件同时存在于工作目录和浏览器下载目录 | 接受重复 / 只保留一份 / 加开关 | 接受重复；工作目录副本支撑预览与 Zotero |
| R2 | 面板可能运行在 iframe/受限容器，下载被 sandbox 拦截 | 检测失败后提示新标签打开 | 先实测，保留降级链接 |
| R3 | Unpaywall 需要邮箱，默认配置下不可用 | 默认关闭 / 引导填写 / 用 OpenAlex 替代 | 优先用 OpenAlex（无需邮箱）；Unpaywall 作为增强 |
| R4 | 大 PDF 超过 30MB 被拒 | 提高上限 / 流式 / 提示浏览器打开 | 保持默认 30MB，超限走浏览器 |
| R5 | 出版社 ToS 对自动化下载的态度不一 | 全量抓取 / 仅 OA / 仅单篇 | 仅 OA + 单篇/小批量；批量保留用户主动触发 |
| R6 | 失败后打开的是 PDF 阅读器而不是直接保存 | 接受 / 依赖出版社 `Content-Disposition` | 接受；阅读器内一次保存即可 |
| R7 | 是否保留 `/download` POST 语义 | 改成 GET / 保留双端点 | **保留** POST（状态写入 + 批量编排），新增 GET 仅负责交付字节 |

---

## 附录 A：关键代码位置索引

| 主题 | 文件 |
| --- | --- |
| 下载按钮 | [DownloadButton.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/DownloadButton.tsx) |
| 单篇/批量下载编排 | [TaskPane.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/TaskPane.tsx#L311-L511) |
| 论文详情页下载 | [PaperPane.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/PaperPane.tsx#L486-L494) |
| 客户端 API | [api.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/api.ts#L352-L402) |
| 本地预览入口 | [client/index.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/client/index.ts#L254-L269) |
| Host 路由 | [router.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/router.ts#L750-L769) |
| 下载服务 | [service.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/tasks/service.ts#L802-L844) |
| 候选与抓取 | [store.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/host/pdf/store.ts) |
| 候选生成 | [oa.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/oa.ts) |
| 跨源合并 | [identity.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/identity.ts#L135-L150) |
| 状态与失败类型 | [types.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/types.ts#L210-L232) |
| 设置项 | [config.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/src/search/config.ts#L125-L127) |
| 现有测试 | [oa.test.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/test/oa.test.ts)、[download-store.test.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/test/download-store.test.ts)、[download-scope.test.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-litsearch/test/download-scope.test.ts) |

## 附录 B：手工验证矩阵（建议按类各取 2–3 篇）

| 类别 | 取材方式 | 预期（阶段 1 后） | 预期（阶段 2 后） |
| --- | --- | --- | --- |
| arXiv 预印本 | 关键词搜出 arXiv 来源 | 自动下载成功 | 同左 |
| PLOS ONE | 搜 `10.1371/journal.pone.*` | 自动下载成功 | 同左 |
| BMC / Springer OA | 搜 `10.1186/*` | 自动下载成功 | 同左 |
| Frontiers | 搜 `10.3389/*` | 自动下载成功 | 同左 |
| PMC 开放获取 | 有 PMCID 但无 pdfUrl | 可能 `blocked` → 浏览器打开 | 通过 Unpaywall/OpenAlex 提升为自动成功 |
| Elsevier / Wiley 订阅 | 任意付费文章 | `paywalled` + 浏览器打开 | 同左（不可消除） |
| Cloudflare 仓储页 | 渲染页返回 403 的条目 | `blocked` + 浏览器打开 | 同左（不绕过） |
| 无 DOI / 无 PMCID | 仅 PubMed 摘要 | `no-candidate` + 浏览器打开原文 | 同左 |

验证命令：

```bash
pnpm build
pnpm build:client
pnpm typecheck:client
pnpm test
# 手工检查响应头与文件名
curl -sS -D - -o /tmp/out.pdf \
  "http://127.0.0.1:<port>/dsh-litsearch/api/tasks/<id>/papers/<paperId>/file?disposition=attachment"
```

## 附录 C：术语

- **落地页（landing page）**：出版商/仓储的文章摘要页，不是 PDF 文件。
- **渲染页（render page）**：仓储把 PDF 包在 HTML 查看器里的地址（如 `?pdf=render`），后台请求容易被拦截。
- **OA**：Open Access，公开可访问的全文。
- **TDM**：Text and Data Mining，Crossref 等提供的批量文本挖掘链接，通常需要单独协议。
- **polite pool**：OpenAlex / Crossref / NCBI 用邮箱标识的礼貌请求池，额度更稳定。
