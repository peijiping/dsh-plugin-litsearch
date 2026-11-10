# dsh-plugin-litsearch

**给 DSH 加一个免费的文献检索助手。**

装上这个插件，大模型可以直接检索开放学术文献，你也可以在 DSH 右侧栏用同一套数据源检索，并把感兴趣的论文一键带进对话。无需账号、无需 API Key、无需本地服务。

> 当前为 P4：七个免费数据源聚合，支持多检索式（可命名、启停、按源覆写）、去重、筛选与概览；可预览 / 下载开放获取 PDF、用 Europe PMC 兜底 HTML 全文、同步到本机 Zotero，并对结果做批量筛读、分组、备注、导出与批量插入对话。每篇论文还能打开独立论文页，查看 PubTator 实体标注；检索式带字段语法时会提示哪些源只按自然语言处理。

## 能做什么

- **模型侧检索**：内置 `literature_search`、`literature_sources`、`literature_task`、`literature_export` 四个工具，可提交多条检索式与年份、开放获取、文献类型等条件；任务可被读取、筛读、分组、对比与导出。
- **人侧检索**：右侧栏「文献检索」面板，可加多条检索式、勾选数据源，结果显示来源、被引与开放获取状态；任务自动保存，可随时回来继续。
- **高级检索式编辑**：每条检索式可改自定义名称、单独启用 / 停用、并针对某个数据源写覆写式（例如 PubMed 用 MeSH、OpenAlex 用概念检索）；未覆写的源仍用主检索式。
- **任务条件编辑**：任务完成后仍可在面板内「改条件」调整检索式、数据源、年份、开放获取、语言、类型、排序与每源条数，保存后一键重跑，无需新建任务。
- **数据源语法提示**：检索式含字段标签或布尔语法时，提示 Semantic Scholar / PubTator 会按自然语言处理；数据源按钮悬浮可查看各自支持的语法，必要时用单源覆写保留查询意图。
- **独立论文页**：任意结果可打开独立论文 tab，集中展示完整摘要、标识符、筛读 / 分组 / 备注 / 标签 / 必读序号、PDF 与 HTML 全文预览，并可插入对话。
- **PubTator 实体**：有 PMID 的论文可查看 PubTator3 标注的基因、疾病、化学物等实体，按标准标识符去重并显示出现次数。
- **筛选与概览**：结果可按关键词、来源、年份、类型、语言、人工筛读状态、缺全文等条件过滤并排序；「概览」页展示漏斗、年份分布、来源与检索式贡献，点击即可反向筛选结果。
- **筛读工作流**：每篇论文可标记未读 / 已读 / 纳入 / 排除，写备注、打标签、加入必读顺序；任务内可建「研究分组」，按为什么读归类，并导出分层报告。
- **全文预览与下载**：在结果卡片里直接预览开放获取 PDF，或下载到本地；文件按「作者年份_标题_标识.pdf」命名，支持断点式 Range 读取。没有 PDF 但有 PMCID 时，用 Europe PMC 全文渲染可读 HTML。
- **全文台账**：「全文」页列出可获取全文的覆盖率与缺失清单，标注需订阅 / 被出版商拒绝 / 获取失败等原因，和概览统计同一口径。
- **Zotero 同步**：通过本机 Zotero 桌面端 connector 保存条目，可选同时附上 PDF；未连接 Zotero、同步失败、部分成功都会给出明确提示，并保留一条带当前条目范围的 RIS 导出入口。
- **批量操作**：全选本页后可批量改筛读状态、归入或移出分组、下载 PDF、存入 Zotero、按选中导出。
- **导出与对比**：按当前筛选或选中条目导出 CSV 台账、RIS、BibTeX、Markdown 报告；也可选一个旧任务做新增 / 共有 / 缺失对比，并把「新增」整批标记为纳入。
- **带进对话**：点击「插入到对话」，把论文元数据与摘要写入当前会话草稿（不自动发送），模型可据此继续工作；勾选多篇后可一次插入，按序号编号。
- **免费数据源**：全部无需付费或申请密钥；NCBI 与 Semantic Scholar 可选填 Key 提高额度，限流在本地按源串行排队，单个源触发 429 只影响该源。

## 安装

要求 dsh ≥ 0.2.1-rc.3（`package.json` 的 `engines.dsh` 为 `>=0.2.1-rc.3 <0.3.0-0`）。

```sh
dsh plugin --profile <profile> add dsh-plugin-litsearch
```

包内是预构建产物（`lib/` + `client/client.js`），安装时不运行构建脚本。

## 配置

插件页 → `dsh-plugin-litsearch` → 配置（保存即生效）：

| 字段 | 说明 | 默认 |
|---|---|---|
| `contactEmail` | 联系邮箱，作为 OpenAlex / Crossref / NCBI 的 polite pool 标识，留空也可用 | 空 |
| `ncbiApiKey` | 可选，PubMed E-utilities 额度 3 → 10 次/秒；界面不回显 | 空 |
| `s2ApiKey` | 可选，Semantic Scholar 配额；界面不回显 | 空 |
| `pubmedIntervalMs` / `s2IntervalMs` / `arxivIntervalMs` | 各源最小请求间隔 | 350 / 3000 / 3000 |
| `defaultPageSize` | 每个来源默认取多少条 | 20 |
| `requestTimeoutMs` | 单次上游请求超时（毫秒） | 15000 |
| `defaultSources` / `defaultSort` / `defaultLanguage` | 新任务默认勾选的数据源、排序与语言 | 全部 / 相关度 / 不限 |
| `autoOpenTaskTab` / `maxTaskTabs` | 模型发起检索后自动打开任务 tab，及同时打开上限 | 开 / 5 |
| `taskRetentionDays` / `taskRetentionCount` / `taskMaxPapers` | 未置顶任务保留天数、保留条数、单任务结果上限 | 90 / 120 / 1500 |
| `pdfRoot` / `pdfMaxMb` / `autoDownloadPdf` | PDF 保存目录、单文件上限（MB）、检索完成后自动下载 | `~/Downloads/dsh-litsearch` / 30 / 关 |
| `enableEpmcFulltext` | 没有 PDF 时用 Europe PMC JATS 全文兜底为可读 HTML | 开 |
| `zoteroEnabled` / `zoteroBaseUrl` | 启用 Zotero 同步及 connector 地址（只允许本机回环） | 开 / `http://127.0.0.1:23119` |
| `zoteroAttachPdf` / `zoteroTag` | 同步时附带 PDF、附加标签 | 开 / `dsh-litsearch` |

设置页还提供诊断与清理：逐源查看最近成功 / 失败与限流冷却并做探活；测试 PDF 下载目录可写性；测试 Zotero connector 连接并读取当前选中分类；按任务 / PDF 缓存 / 全部三种范围清理文件。

## Zotero 同步

同步走 Zotero 桌面端自带的 connector（默认 `http://127.0.0.1:23119`），不需要 Web API Key：

1. 启动 Zotero 桌面端，保持运行；
2. 在「设置 → 高级」中允许其他应用与本机通信（若该版本提供此开关）；
3. 如有需要，先在 Zotero 里选中目标分类——未选中时条目会保存到「我的文库」。

同步会写入条目元数据、标签与可选 PDF 附件。连接失败、当前分类不可写附件、单篇条目或附件失败都会在界面给出对应提示；分类只读时只保存条目，不尝试上传 PDF。同步失败或部分失败时，任务页会保留一条 RIS 导出入口（只含本次同步的条目），可先导出备用。

## 隐私

- 检索词会发送给所选数据源（PubMed、Europe PMC、OpenAlex、Crossref、Semantic Scholar、arXiv、PubTator）的公开 API。
- PDF 下载与 Zotero 连接都只在本机进行；Zotero connector 仅允许回环地址。
- API Key 只保存在本机配置文件（明文）中，界面不回显、不写日志。

## 本地开发

```bash
pnpm install
pnpm build            # Host: src -> lib
pnpm build:client     # Client: src/client -> client/client.js
pnpm typecheck:client
pnpm test             # node:test 单元测试（test/**/*.test.ts）
```

构建后用独立的本地 profile 启动调试：

```bash
pnpm build && pnpm build:client
dsh --profile litsearch
```

该 profile 位于 `~/.dsh/profiles/litsearch`，通过 `link:` 指向本仓库，包含 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与本插件，不会影响 demo 等其他测试 profile。

## 架构

- `src/search/`：数据源无关的检索层（类型、聚合、身份合并、查询适配、限流、健康状态）。
- `src/search/providers/`：每家免费 API 一个 provider，新增数据源只需实现 `Provider` 并注册。
- `src/host/`：`/dsh-litsearch/api/*` 端点、任务执行 / 持久化 / 统计 / 导出、模型侧工具注册。
- `src/host/pdf/`：PDF 候选链、SSRF 防护的抓取与本地缓存、可读文件名、Europe PMC 全文兜底。
- `src/host/zotero/`：本机 Zotero connector 协议封装（探测、保存条目、上传附件）。
- `src/client/`：右侧栏检索面板、任务 tab（结果 / 概览 / 分组 / 笔记 / 对比 / 全文）、独立论文 tab 与设置页。

## 路线图

- [x] arXiv（Atom XML）
- [x] PubMed / Europe PMC
- [x] Semantic Scholar
- [x] 多检索式与跨式去重
- [x] 结果筛选、排序与概览统计
- [x] 筛读、分组、备注与任务对比
- [x] 续页加载与导出（CSV / RIS / BibTeX / Markdown）
- [x] PDF 预览 / 下载、Europe PMC 全文兜底、全文台账
- [x] Zotero 同步与批量操作
- [x] 高级检索式编辑、任务条件修改与批量插入对话
- [x] 独立论文页、PubTator 实体与数据源语法提示
- [x] 对比视图整批纳入、Zotero 失败回退 RIS
- [x] Unpaywall（按 DOI 补全开放获取全文地址；需配置 `contactEmail`）
- [ ] DOAJ

## License

MIT
