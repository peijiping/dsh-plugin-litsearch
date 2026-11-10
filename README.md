# dsh-plugin-litsearch

**给 DSH 加一个免费的文献检索助手。**

装上这个插件，大模型可以直接检索开放学术文献，你也可以在 DSH 右侧栏用同一套数据源检索，并把感兴趣的论文一键带进对话。无需账号、无需 API Key、无需本地服务。

> 当前为 P2：PubMed / Europe PMC / OpenAlex / Crossref / Semantic Scholar / arXiv / PubTator 七源聚合，支持多检索式、跨源与跨式去重、结果筛选与概览统计。

## 能做什么

- **模型侧检索**：内置 `literature_search` 工具，支持一次提交多条检索式、年份范围、仅开放获取、文献类型等条件，七个数据源并发查询后合并去重。
- **人侧检索**：右侧栏「文献检索」面板，可加多条检索式、勾选数据源，结果显示来源、被引与开放获取状态。
- **筛选与概览**：结果可按关键词、来源、年份、类型、语言、人工筛选状态过滤并排序；「概览」页展示漏斗、年份分布、来源与检索式贡献，点击即可筛选结果。
- **带进对话**：点击「插入到对话」，把论文元数据与摘要写入当前会话草稿（不自动发送），模型可据此继续工作。
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

设置页还提供逐源诊断：查看最近一次成功/失败、限流冷却时间，并对单个数据源做一次探活测试。

## 本地开发

```bash
pnpm install
pnpm build            # Host: src -> lib
pnpm build:client     # Client: src/client -> client/client.js
pnpm typecheck:client
```

## 架构

- `src/search/`：数据源无关的检索层（类型、聚合、身份合并、查询适配、限流、健康状态）。
- `src/search/providers/`：每家免费 API 一个 provider，新增数据源只需实现 `Provider` 并注册。
- `src/host/`：`/dsh-litsearch/api/*` 端点、任务执行/持久化/统计 + 模型侧工具注册。
- `src/client/`：右侧栏检索面板、任务 tab（结果 / 概览）、设置页。

## 路线图

- [x] arXiv（Atom XML）
- [x] PubMed / Europe PMC
- [x] Semantic Scholar
- [x] 多检索式与跨式去重
- [x] 结果筛选、排序与概览统计
- [ ] DOAJ
- [ ] Unpaywall（按 DOI 补全开放获取全文地址）
- [ ] 续页加载与结果导出（BibTeX / RIS）

## License

MIT
