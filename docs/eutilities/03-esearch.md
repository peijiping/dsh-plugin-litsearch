# ESearch：文本检索

来源：https://www.ncbi.nlm.nih.gov/books/NBK25499/ （ESearch 一节）

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi
```

## 功能

- 返回匹配文本查询的 UID 列表
- 把检索结果投递到 History Server
- 从 History Server 下载完整 UID 集
- 合并 / 限定 History 上的数据集
- 对 UID 集排序

> 与网页版的差异：PubMed 网页的引文匹配、拼写纠错等能力不通过 ESearch 提供，对应 API 是 ECitMatch 与 ESpell。

## 必需参数

| 参数 | 说明 |
| --- | --- |
| `db` | 要检索的数据库，必须是合法的 Entrez 库名（默认 `pubmed`） |
| `term` | Entrez 查询式；特殊字符须 URL 编码，空格可用 `+`；超过数百字符建议 POST |

示例：

```
esearch.fcgi?db=pubmed&term=asthma
esearch.fcgi?db=pubmed&term=”asthma treatment”[Title:~3]
```

PubMed 支持邻近检索：`"asthma treatment"[Title:~3]` 表示两词在 Title 中相距不超过 3 个词、顺序不限。

## 可选参数：History Server

| 参数 | 说明 |
| --- | --- |
| `usehistory` | 设为 `y` 时，把命中的 UID 集提交到 History Server。**要在 `term` 中使用 query key，或传入 `WebEnv`，必须设 `usehistory=y`** |
| `WebEnv` | 上一次 ESearch / EPost / ELink 返回的 Web 环境字符串。提供后，本次结果会**追加**到已有环境；同时允许在 `term` 中使用 query key。使用 `WebEnv` 时必须 `usehistory=y` |
| `query_key` | 之前 ESearch / EPost / ELink 返回的整数 key。提供后，ESearch 取 `query_key` 对应集合与 `term` 检索结果的**交集**（AND）。必须同时提供 `WebEnv` 且 `usehistory=y` |

query key 也可以写在 `term` 里，以 `#` 开头（URL 中编码为 `%23`）。`query_key` 参数一次只能给一个，但 `term` 里可以引用多个 key，并且可以用 OR / NOT 组合。

以下两个 URL 等价：

```
esearch.fcgi?db=pubmed&term=asthma&query_key=1&WebEnv=<webenv>&usehistory=y
esearch.fcgi?db=pubmed&term=%231+AND+asthma&WebEnv=<webenv>&usehistory=y
```

## 可选参数：结果分页

| 参数 | 说明 |
| --- | --- |
| `retstart` | 结果集中第一条要显示的 UID 序号，默认 `0` |
| `retmax` | 结果集中最多显示多少条 UID，默认 `20`，**上限 10,000**。若 `usehistory=y`，超出的部分存放在 History Server；否则直接丢失 |

**重要限制**：PubMed 和 PMC 最多只能检索到前 10,000 条匹配记录。要拿到更多：

- 用 EDirect 的本地 PubMed cache（自动分批）；
- 或给查询增加条件（如日期区间），把结果切分为每批 < 10,000 条；
- 其他数据库可通过递增 `retstart` 多次请求。

## 可选参数：返回格式与排序

| 参数 | 说明 |
| --- | --- |
| `rettype` | `uilist`（默认，标准 XML，含 UID 列表、总数、检索式翻译）或 `count`（只返回 `<Count>`） |
| `retmode` | `xml`（默认）或 `json` |
| `sort` | 排序方式，取值随库而异，可在 Entrez 结果页的 Display Settings 中查看。若 `usehistory=y`，History 中的集合按该顺序保存，后续 ESummary/EFetch 也按此顺序取回 |
| `field` | 把整个查询限制在某个字段。`term=asthma&field=title` 等价于 `term=asthma[title]` |
| `idtype` | 序列库（nuccore、popset、protein）用。默认返回 GI 号，`idtype=acc` 返回 accession.version |

PubMed 的 `sort` 取值（官方现行文档）：

| 值 | 含义 |
| --- | --- |
| `pub_date` | 按出版日期降序 |
| `Author` | 按第一作者升序 |
| `JournalName` | 按期刊名升序 |
| `relevance` | 默认，即网页版 "Best Match" |

> NLM 旧版 Data Guide 还列过 `journal`、`pub+date`、`most+recent`、`title`、`author`。以 Bookshelf 现行文档为准，旧值不保证仍可用。

## 可选参数：日期

| 参数 | 说明 |
| --- | --- |
| `datetype` | 用于限定的日期类型，常用 `mdat`（修改日期）、`pdat`（出版日期）、`edat`（Entrez 日期）；一般每个库只有两种可选值 |
| `reldate` | 整数 n，只返回 `datetype` 指定日期在最近 n 天内的记录 |
| `mindate`, `maxdate` | 日期区间，**必须成对使用**。格式 `YYYY/MM/DD`，也支持 `YYYY`、`YYYY/MM` |

PubMed 常见的 `datetype`（NLM Data Guide）：

| 值 | 含义 |
| --- | --- |
| `crdt` | Create Date，记录首次进入 PubMed 的日期 |
| `edat` | Entrez Date，记录进入 PubMed 的日期 |
| `pdat` | Publication Date，文章出版日期 |
| `mhda` | MeSH Date，被 MeSH 标引的日期 |

## 示例

```bash
# 近 60 天加入 PubMed 的 cancer 文献，取前 100 个 PMID，并存入 History
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=cancer&reldate=60&datetype=edat&retmax=100&usehistory=y

# PNAS 第 97 卷，从第 7 条开始取 6 条
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=PNAS[ta]+AND+97[vi]&retstart=6&retmax=6&tool=biomed3

# NLM Catalog 中匹配 obstetrics 的期刊
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=nlmcatalog&term=obstetrics+AND+ncbijournals[filter]

# PMC 中可免费获取全文、包含 stem cells 的文章
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pmc&term=stem+cells+AND+free+fulltext[filter]

# Nucleotide 中所有 tRNA
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=nucleotide&term=biomol+trna[prop]

# Protein 中分子量 70000–90000 的记录
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=protein&term=70000:90000[molecular+weight]
```

## JSON 返回结构

`retmode=json` 实测（`term=asthma&retmax=2`，2026-10-27）：

```json
{
  "header": { "type": "esearch", "version": "0.3" },
  "esearchresult": {
    "count": "246461",
    "retmax": "2",
    "retstart": "0",
    "idlist": ["42933872", "42933820"],
    "translationset": [
      { "from": "asthma", "to": "\"asthma\"[MeSH Terms] OR \"asthma\"[All Fields] OR ..." }
    ],
    "querytranslation": "\"asthma\"[MeSH Terms] OR ..."
  }
}
```

`usehistory=y` 时还会出现 `webenv` 与 `querykey` 字段；使用 `rettype=count` 时只关心 `count`。

## 使用建议

- 列表页只需要数量和 ID 时，用 `retmode=json&rettype=uilist`，`retmax` 控制在 20–100。
- 需要"共多少条"时用 `rettype=count`，比取 UID 列表便宜。
- 结果可能超过 1 万条时，先分段（按年份或主题）再检索。
- `term` 必须由调用方做 URL 编码；不要把用户输入直接拼进 URL。
