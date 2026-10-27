# ESummary：文档摘要（DocSum）

来源：https://www.ncbi.nlm.nih.gov/books/NBK25499/ （ESummary 一节）

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi
```

## 功能

- 按 UID 列表返回 DocSum
- 按 History Server 上的集合返回 DocSum

DocSum 是"列表页级别"的字段集合（标题、作者、期刊、日期、卷期页、DOI 等），比 EFetch 轻，适合展示检索结果列表。

## 必需参数

| 参数 | 说明 |
| --- | --- |
| `db` | 数据库名（默认 `pubmed`） |

输入二选一：

**方式 A：直接给 UID 列表**

| 参数 | 说明 |
| --- | --- |
| `id` | 单个 UID 或逗号分隔列表，必须属于 `db`。没有硬性上限，但超过约 200 个建议用 HTTP POST。序列库可混合 GI 与 accession.version |

**方式 B：使用 History Server**

| 参数 | 说明 |
| --- | --- |
| `query_key` | 指定 Web 环境下的哪个 UID 列表作为输入，必须与 `WebEnv` 同时使用 |
| `WebEnv` | 包含目标 UID 列表的 Web 环境，必须与 `query_key` 同时使用 |

```bash
esummary.fcgi?db=protein&query_key=<key>&WebEnv=<webenv string>
```

## 可选参数

| 参数 | 说明 |
| --- | --- |
| `retstart` | 从第几条 DocSum 开始，**默认 1**（注意不是 0） |
| `retmax` | 最多返回多少条，**上限 10,000**；超过时保持 `retmax` 不变、递增 `retstart` 分批下载 |
| `retmode` | `xml`（默认）或 `json` |
| `version` | 填 `2.0` 时返回 v2.0 DocSum XML。v2.0 的字段按库定制，通常比默认 DocSum 更丰富 |

## 示例

```bash
# PubMed 默认 DocSum XML
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=11850928,11482001

# PubMed v2.0 XML
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=11850928,11482001&version=2.0

# 其他库
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=protein&id=28800982,28628843
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=nucleotide&id=28864546,28800981
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=structure&id=19923,12120
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=taxonomy&id=9913,30521
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=unists&id=254085,254086
```

## JSON 返回结构

`db=pubmed&retmode=json&version=2.0` 实测（2026-10-27），`result` 下以 UID 为键：

```json
{
  "header": { "type": "esummary", "version": "0.3" },
  "result": {
    "uids": ["11850928"],
    "11850928": {
      "uid": "11850928",
      "pubdate": "1965 Aug",
      "epubdate": "",
      "source": "Arch Dermatol",
      "authors": [{ "name": "LoPresti PJ", "authtype": "Author", "clusterid": "" }],
      "lastauthor": "Hambrick GW Jr",
      "title": "Zirconium granuloma following treatment of rhus dermatitis.",
      "volume": "92",
      "issue": "2",
      "pages": "188-91",
      "lang": ["eng"],
      "issn": "0003-987X",
      "essn": "",
      "pubtype": ["Case Reports", "Journal Article"],
      "articleids": [{ "idtype": "pubmed", "idtypen": 1, "value": "11850928" }],
      "fulljournalname": "Archives of dermatology",
      "elocationid": "",
      "sortpubdate": "1965/08/01 00:00",
      "sortfirstauthor": "LoPresti PJ"
    }
  }
}
```

PubMed v2.0 的完整键集合：`uid`、`pubdate`、`epubdate`、`source`、`authors`、`lastauthor`、`title`、`sorttitle`、`volume`、`issue`、`pages`、`lang`、`nlmuniqueid`、`issn`、`essn`、`pubtype`、`recordstatus`、`pubstatus`、`articleids`、`history`、`references`、`attributes`、`pmcrefcount`、`fulljournalname`、`elocationid`、`doctype`、`srccontriblist`、`booktitle`、`medium`、`edition`、`publisherlocation`、`publishername`、`srcdate`、`reportnumber`、`availablefromurl`、`locationlabel`、`doccontriblist`、`docdate`、`bookname`、`chapter`、`sortpubdate`、`sortfirstauthor`、`vernaculartitle`。

> 默认 DocSum（不加 `version=2.0`）结构不同且字段更少；`retmode=json` 时字段形态也会变化。接入时固定一种形态（推荐 v2.0 + JSON）以免解析分支过多。

## 使用建议

- 检索结果列表用 ESummary（v2.0 JSON）足够；详情页再按需 EFetch。
- 一次传 50–200 个 PMID 比较稳妥；再多考虑 POST 或 History。
- `references`、`history`、`pmcrefcount` 等字段在 v2.0 中可用，可用来展示引用数或 PMC 关联。
