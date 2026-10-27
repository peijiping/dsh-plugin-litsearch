# dsh-plugin-litsearch

**给 DSH 加一个免费的文献检索助手。**

装上这个插件，大模型可以直接检索开放学术文献，你也可以在 DSH 右侧栏用同一套数据源检索，并把感兴趣的论文一键带进对话。无需账号、无需 API Key、无需本地服务。

> 当前为项目骨架：OpenAlex / Crossref 双源检索、模型工具、右侧栏面板与配置卡已可用，更多免费数据源在路线图中。

## 能做什么

- **模型侧检索**：内置 `literature_search` 工具，支持关键词、年份范围、仅开放获取等条件，多个数据源并发查询后合并去重。
- **人侧检索**：右侧栏「文献检索」面板，选择数据源、输入关键词即可浏览标题、作者、年份、出处、被引次数与摘要。
- **带进对话**：点击「插入到对话」，把论文元数据与摘要写入当前会话草稿（不自动发送），模型可据此继续工作。
- **免费数据源**：当前接入 [OpenAlex](https://openalex.org) 与 [Crossref](https://www.crossref.org)，两者均无需密钥。

## 安装

要求 dsh ≥ 0.2.1-rc.3（`package.json` 的 `engines.dsh` 为 `>=0.2.1-rc.3 <0.3.0-0`）。

```sh
dsh plugin --profile <profile> add dsh-plugin-litsearch
```

包内是预构建产物（`lib/` + `client/client.js`），安装时不运行构建脚本。

## 配置

插件页 → `dsh-plugin-litsearch` → 配置：

| 字段 | 说明 | 默认 |
|---|---|---|
| `contactEmail` | 联系邮箱，作为 OpenAlex / Crossref 的 polite pool 标识，留空也可用 | 空 |
| `defaultLimit` | 面板与工具默认返回条数 | 20 |
| `requestTimeoutMs` | 单次上游请求超时（毫秒） | 15000 |

## 本地开发

```bash
pnpm install
pnpm build            # Host: src -> lib
pnpm build:client     # Client: src/client -> client/client.js
pnpm typecheck:client
```

## 架构

- `src/search/`：数据源无关的检索层（类型、聚合、去重、错误）。
- `src/search/providers/`：每家免费 API 一个 provider，新增数据源只需实现 `Provider` 并注册。
- `src/host/`：`/dsh-litsearch/api/*` 只读端点 + 模型侧工具注册。
- `src/client/`：右侧栏 tab、检索面板、配置卡。

## 路线图

- [ ] arXiv（Atom XML）
- [ ] PubMed / Europe PMC
- [ ] Semantic Scholar
- [ ] DOAJ
- [ ] Unpaywall（按 DOI 补全开放获取全文地址）
- [ ] 结果排序策略与跨源去重增强

## License

MIT
