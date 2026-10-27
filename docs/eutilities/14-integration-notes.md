# 接入实践：把 PubMed 作为文献数据源

面向本插件（`dsh-plugin-litsearch`）的落地要点。现有数据源是 OpenAlex / Crossref；若新增 PubMed，走 E-utilities 即可，无需付费、无需申请密钥（带 `tool` + `email`，高频再加 `api_key`）。

## 1. 最小可用请求

```bash
# 检索，返回 JSON
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=asthma&retmax=20&retmode=json&sort=relevance&tool=<tool>&email=<email>

# 摘要列表，v2.0 JSON
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=11850928,11482001&retmode=json&version=2.0&tool=<tool>&email=<email>

# 完整记录 XML
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=11850928&retmode=xml&tool=<tool>&email=<email>
```

## 2. 能力与格式矩阵

| 能力 | 工具 | 可用格式 | 备注 |
| --- | --- | --- | --- |
| 关键词检索 | ESearch | XML / JSON | 只返回 UID 与总数 |
| 计数 | ESearch | XML / JSON | `rettype=count` |
| 列表元数据 | ESummary | XML / JSON | 建议 `version=2.0` |
| 详情 | EFetch | XML / 文本 | **无 JSON** |
| 相关文献 | ELink | XML / JSON | `cmd=neighbor_score` |
| PubMed → PMC | ELink | XML / JSON | `db=pmc` |
| 拼写建议 | ESpell | XML | 无 JSON |
| 引文匹配 | ECitMatch | 纯文本 | 实际返回不是 XML |
| 全库计数 | EGQuery | XML | 当前 301 跳转，避免依赖 |

## 3. 推荐调用链

### 3.1 关键词检索 → 结果列表

1. `esearch.fcgi`，`retmode=json`，`retmax` 取 20–100，`sort=relevance|pub_date`。
2. 从 `esearchresult.idlist` 拿 PMID，`count` 作为总数。
3. 若列表需要元数据，把 idlist 交给 `esummary.fcgi?version=2.0&retmode=json`，一次 50–200 个。

```jsonc
// ESearch 关键字段
{
  "esearchresult": {
    "count": "246461",          // 总命中数（字符串）
    "retmax": "2",
    "retstart": "0",
    "idlist": ["42933872", "42933820"],
    "querytranslation": "\"asthma\"[MeSH Terms] OR ..."
  }
}
```

`querytranslation` 建议在 UI 上做"检索式解读"展示，便于用户理解 PubMed 如何解释输入。

### 3.2 结果详情

- 需要摘要、作者、期刊、DOI、MeSH、PMC ID：`efetch.fcgi?db=pubmed&retmode=xml`。
- 只要摘要展示：`retmode=text&rettype=abstract`，但格式不稳定，不建议入库。
- 列表页字段足够时无需 EFetch，直接用 ESummary。

PubMed XML 关键路径：

```
PubmedArticleSet/PubmedArticle/MedlineCitation/PMID
PubmedArticleSet/PubmedArticle/MedlineCitation/Article/ArticleTitle
PubmedArticleSet/PubmedArticle/MedlineCitation/Article/Abstract/AbstractText
PubmedArticleSet/PubmedArticle/MedlineCitation/Article/Journal/Title
PubmedArticleSet/PubmedArticle/MedlineCitation/Article/Journal/JournalIssue/PubDate
PubmedArticleSet/PubmedArticle/MedlineCitation/Article/AuthorList/Author
PubmedArticleSet/PubmedArticle/MedlineCitation/Article/ELocationID
PubmedArticleSet/PubmedArticle/MedlineCitation/MeshHeadingList/MeshHeading
PubmedArticleSet/PubmedArticle/PubmedData/ArticleIdList/ArticleId
```

`AbstractText` 可能有多段并带 `Label` 属性（BACKGROUND / METHODS / RESULTS / CONCLUSIONS），拼接时按段保留标签。

### 3.3 相关文献

```bash
# 带相关度分数
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pubmed&id=<PMID>&cmd=neighbor_score&retmode=json
```

注意 JSON 中 `links` 的结构差异：

- 普通模式：`"links": ["id1", "id2", ...]`
- `neighbor_score`：`"links": [{"id":"...","score":...}, ...]`

### 3.4 引文匹配（粘贴参考文献）

```
ecitmatch.cgi?db=pubmed&retmode=xml&bdata=<journal>|<year>|<volume>|<first_page>|<author>|<key>|%0D...
```

返回纯文本，每行 `...|PMID`，用 `your_key` 对应回输入条目。匹配为空时不要断言文献不存在。

## 4. 参数映射（文献检索场景）

| 需求 | 参数 |
| --- | --- |
| 标题/摘要检索 | `term=<q>[tiab]` |
| 作者 | `term=<author>[au]`（姓 + 名首字母） |
| 期刊 | `term=<journal>[ta]` |
| 年份 | `term=2020:2024[pdat]` 或 `mindate=2020&maxdate=2024&datetype=pdat` |
| 最近 N 天 | `reldate=N&datetype=edat` |
| 只看综述 | `term=review[pt]` 或 `review[filter]` |
| 只看免费全文 | `term="free full text"[filter]`（必须带引号） |
| 有 PMC 全文 | `term="pubmed pmc"[sb]` |
| 排序 | `sort=relevance` / `sort=pub_date` |
| 只要数量 | `rettype=count` |
| 指定字段整体限定 | `field=<field>` |

字段标签以 PubMed Help 为准：https://www.ncbi.nlm.nih.gov/books/NBK3827/

## 5. 限流实现

- 默认按 **3 req/s** 设计；配置了 `api_key` 后放宽到 **10 req/s**。
- 用进程内令牌桶/串行队列即可，不需要分布式限流。
- 响应头 `X-Ratelimit-Limit` / `X-Ratelimit-Remaining` 可用于观测；实测值为 3。
- 超限时返回体是 JSON：`{"error":"API rate limit exceeded","count":"11"}`，**HTTP 状态可能仍是 200**，必须检查响应体。
- 网络错误/超时建议指数退避（1s、2s、4s），并设置请求超时（检索 10–15s，EFetch 30–60s）。

## 6. 分页与上限

| 工具 | `retstart` 起算 | `retmax` 上限 | 其他 |
| --- | --- | --- | --- |
| ESearch | 0 | 10,000 | PubMed/PMC 最多只能取前 10,000 条命中 |
| ESummary | **1** | 10,000 | 注意与 ESearch/EFetch 不一致 |
| EFetch | 0 | 10,000 | 响应体大，建议每批 ≤ 200 |
| EPost | — | — | PubMed/PMC 单次 ≤ 10,000 个 UID |

超过 1 万条：按年份/主题切分查询，或 EPost + History 分批。不要试图用大 `retstart` 突破 PubMed 的 10,000 条限制。

## 7. 编码与安全

- `term` 用 `encodeURIComponent` 编码；空格在编码后是 `%20`，NCBI 也接受 `+`。
- `WebEnv` 必须编码后再拼进 URL；参数名是 `WebEnv`。
- 解析 XML 时**禁用外部实体（XXE）**，PubMed XML 带 DOCTYPE，很多解析器默认会去拉 DTD。
- PubMed XML 的 DTD 会更新（实测 2026-10 为 `pubmed_250101.dtd`），解析时只取需要的节点，不要做严格 schema 校验。
- 不要把 `api_key` 写进前端或客户端产物；放在 Host 侧配置里。

## 8. 缓存与更新

- EInfo 可查库的 `lastupdate`（`einfo.fcgi?db=pubmed&retmode=json`）。
- PubMed 每日更新；检索结果可按查询 + 日期缓存，详情按 PMID 缓存较长时间。
- History 集合不要当缓存用，生命周期无保证。

## 9. 与现有数据源的衔接

| 维度 | OpenAlex / Crossref | PubMed (E-utilities) |
| --- | --- | --- |
| 覆盖 | 全学科 | 生物医学为主 |
| 标识 | OpenAlex ID / DOI | PMID / PMCID / DOI |
| 摘要 | 部分有 | 基本都有 |
| 主题词 | 概念/关键词 | MeSH（人工标引） |
| 被引次数 | 有 | ESummary 无被引次数（`pmcrefcount` 是 PMC 参考文献数，不是被引） |
| 格式 | JSON | XML（EFetch）/ JSON（ESearch、ESummary、ELink） |
| 认证 | 邮箱（Crossref polite pool） | `tool` + `email`，可选 `api_key` |

去重建议：优先用 DOI；没有 DOI 时用 PMID；标题 + 年份做兜底归一化。

## 10. 已观测到的现状（2026-10-27）

- `egquery.fcgi` 返回 301 到 `ext-http-eutils.linkerd.ncbi.nlm.nih.gov/gquery`，该主机在本次测试网络下无法解析。计数请改用 ESearch `rettype=count`。
- PubMed EFetch XML 的 DOCTYPE 为 `PubMedArticle, 1st January 2025`。
- ESummary v2.0 JSON 的 `authors` 是对象数组（`name` / `authtype` / `clusterid`）。
- ECitMatch 即便传 `retmode=xml`，返回仍是纯文本。
- `www.ncbi.nlm.nih.gov` 对非浏览器请求返回 reCAPTCHA；只有 `eutils.ncbi.nlm.nih.gov` 的 API 端点不受影响，开发时不要抓网页版做数据源。
- 官方示例里的 `free fulltext[filter]` 现在返回 0；实测有效写法是 **`"free full text"[filter]`**（带引号）。PMC 子集用 **`"pubmed pmc"[sb]`**，`pmc[sb]` 无效。
  - 对照数据（2026-10-27）：`asthma` 246,461 条；`asthma AND "free full text"[filter]` 95,175 条；`asthma AND "pubmed pmc"[sb]` 71,796 条。

## 11. 合规清单

- [ ] 请求带 `tool` 与维护者 `email`，并向 NCBI 注册
- [ ] 默认限流 3 req/s（有 Key 时 10 req/s）
- [ ] 大批量任务放在周末或美东 21:00–05:00
- [ ] UI 中提供 NCBI 免责与版权声明链接
- [ ] 不把 PubMed 摘要用于超出合理使用的再分发
- [ ] 大批量数据挖掘改用 PubMed 本地副本
