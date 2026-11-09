# Changelog

本文件自 v0.4.3 起维护，此前版本摘要见 README「版本历史」与 GitHub Releases。格式参照 Keep a Changelog。

## [0.4.4] — 2026-09-30

### Changed
- **OpenAlex / Semantic Scholar 端点可配**：新增 `OPENALEX_BASE_URL` / `S2_BASE_URL`（补上 v0.4.x 新增两源的漏网硬编码，五族数据源全部支持自建反代）；不配置时行为与 v0.4.3 完全一致
- **S2 429 退避上限**：S2 调用重试预算降为 2 次（1s+2s ≈ 3s 快速见分晓，其余数据源维持 6 次）——无 key 共享池重度限流时不再拖 60–90s，多源合并立即返回（S2 以 perSource error 报告，其余源照常）；`withNetRetry` 新增可选预算参数，向后兼容
- **用户图谱 schema 迁移钩子**：读取用户图谱统一经 `migrateUserGraph`（core `loadUserGraph` 单一咽喉点，覆盖 `graph_get` / `graph_commit` 两个读点）——显式 `MIGRATIONS` 步骤表逐级迁移 + 结构规整（`sources`/`count`/`weight` 字段漂移自动修复，杜绝合并抛错与 `NaN`）；缺迁移步骤时保留原版本、绝不只盖版本戳；未来版本透传不降级；无 `version` 字段的旧文件自动升级为 v1
- **会话图谱内存上限 + 会话键硬化**：`sessionGraphs` LRU 上限 32（淘汰最久未用的会话图并同步清理对应写链，当前会话永不淘汰；被淘汰会话的 `graph_get` 见到空图，重新 `graph_add` 即可）；`sessionKeyOf` 回退链 `agent.id → sessionId → requestId → 'default'`

### Tests
- 新增 `test/v044-test.mjs`（26 断言）：P1 默认端点与 v0.4.3 一致、注入反代后全部重定向且零泄漏、尾斜杠归一化；P3 S2 429 三次尝试即报错（退避 1s+2s）、NCBI 仍 7 次、恢复路径不受影响；P4 LRU 封顶/淘汰/写链清理/数据丢失语义 + sessionKeyOf 四种回退
- `test/graph-test.mjs` 扩充 P2 断言：双读点一致迁移、结构规整、未来版本透传、缺步骤不盖戳

## [0.4.3] — 2026-09-18

### Added
- `pubmed_graph_add` 新增 `pmids` 批量形式（≤200）：内部自动取文 + 富集，"把检索结果加进图谱"一步到位
- `pubmed_fetch_fulltext` 升级两级链：NCBI PMC 之外新增 Europe PMC fullTextXML 兜底——EPMC-only OA 文章也有正文
- **ID 解析缓存**：pmid↔pmcid↔doi 解析结果插件内缓存（含负结果）——检索→OA→全文→图谱串联链路重复 ID 零网络开销
- 批量工具超时预算落地：批量 OA（10 id）、四源搜索、带富集入图 120–180s
- `pubmed_fetch_pdf_oa` 输出升级：每个 OA 候选位置带来源标注（unpaywall/europepmc/openalex + alsoIn）、末尾 Best PDF 推荐行、F3 自动换算 `converted` 回显

### Docs
- SKILL.md 路由更新：pmids 捷径、两级链、ID 缓存、批量超时、`HEURISTIC_RELATIONS` / `RELATION_ENDPOINT_REQUIRE_KEYWORD` 配置键
- 新建本 CHANGELOG；README 中英同步（能力描述 + 版本历史）

## [0.4.2] — 2026-09-18

### Added
- 第 26 个工具 `pubmed_fetch_pdf_oa`：单个或批量（≤10）DOI/PMID/PMCID → 聚合 Unpaywall + Europe PMC + OpenAlex 的去重排序 OA 链接列表；`download:true` 落盘（PDF 签名校验，出版社拦截页自动换下一候选）；`UNPAYWALL_EMAIL` 配置
- 统一搜索结果携带 `isOpenAccess` / `oaUrl` / `oaStatus`（检索→下载闭环，零额外请求）

### Fixed
- 图谱去噪五层修复：关系跨度严格停用词门（含被同名遮蔽的死代码清理）、端点 ∈ 本文关键词语义门（`RELATION_ENDPOINT_REQUIRE_KEYWORD`）、mermaid 不再补入 count=0 端点、`HEURISTIC_RELATIONS:false` 纯 curated 开关
- year 过滤下推各源查询（修复事后过滤返回 0 条）
- F1：`search_articles` 的 `includeSummaries` 默认值生效
- F3：`pmcids` 参数误传 PMID 自动换算
- F6：`find_related` 相似结果不再回含源 PMID

### Docs
- README 能力优先重构（中英）：六大功能模块 + 场景串联替代工具罗列

## [0.4.1] — 2026-09-02

### Changed
- `pubmed_search_papers` 默认三源（PubMed + Europe PMC + OpenAlex）；`sources` 支持 `'s2'` / `'all'`；`sort` 与 `year` 跨源过滤（下推各源查询）；agent 路由描述补全

## [0.4.0] — 2026-09-02

### Added
- Semantic Scholar 五工具：`search_s2` / `get_s2_detail` / `get_s2_citations` / `get_s2_recommendations` / `match_paper_by_title`（`S2_ENABLED` 门控 + 专用限速队列）
- `pubmed_search_papers` 双源统一检索（titleKey 归一化去重合并 + perSource 报告）
- `fetch_fulltext` 分页切片（`offset` / `maxCharacters` / `nextOffset` + 组互斥运行时强制）
- `EUTILS_BASE_URL` / `PUBTATOR_BASE_URL` / `EPMC_BASE_URL` 自建反代可配

### Infra
- 发布后自动同步 npmmirror（`scripts/sync-mirror.mjs`，国内 1 分钟内可装）

## 更早版本

v0.1.0–v0.3.9：自 [@cyanheads/pubmed-mcp-server](https://github.com/cyanheads/pubmed-mcp-server) 移植 11 个 PubMed 工具起步，经历 PubTator3 概念层（v0.2.x）、个人文献知识图谱与语义检索（v0.3.0–v0.3.4）、无代理韧性与质量工程（v0.3.5–v0.3.9）——完整时间线见 README「版本历史」。
