# EFetch：获取完整记录

来源：https://www.ncbi.nlm.nih.gov/books/NBK25499/ （EFetch 一节）

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi
```

## 功能

- 按 UID 列表返回格式化后的完整记录
- 按 History Server 上的集合返回完整记录

EFetch 是唯一支持"多种输出格式"的工具，**不支持 JSON**，只能取 XML 或纯文本。

## 必需参数

| 参数 | 说明 |
| --- | --- |
| `db` | 数据库名（默认 `pubmed`）。**EFetch 并不支持所有 Entrez 库**，支持列表见 [12-retmode-rettype.md](12-retmode-rettype.md) |

输入二选一：

| 方式 | 参数 | 说明 |
| --- | --- | --- |
| UID 列表 | `id` | 单个或逗号分隔 UID，必须属于 `db`；没有硬上限，但超过约 200 个建议 HTTP POST。序列库可混合 GI 与 accession.version |
| History | `query_key` + `WebEnv` | 指定要取回的集合，两者必须同时使用 |

序列库特别说明：NCBI 已不再给越来越多的新序列分配 GI 号，这些记录不进 Entrez 索引，因此无法用 ESearch / ESummary 找到，也没有 ELink 链接；但 **EFetch 可以用 accession.version 直接取回**。

```bash
efetch.fcgi?db=pubmed&id=19393038,30242208,29453458
efetch.fcgi?db=protein&id=15718680,NP_001098858.1,119703751
efetch.fcgi?db=protein&query_key=<key>&WebEnv=<webenv string>
```

## 可选参数

| 参数 | 说明 |
| --- | --- |
| `retmode` | 数据格式（text / xml / asn.1 等），取值随库而定 |
| `rettype` | 记录视图（如 PubMed 的 abstract、medline；Protein 的 fasta、gp） |
| `retstart` | 从第几条记录开始，默认 `0` |
| `retmax` | 最多返回多少条，上限 **10,000**；可固定 `retmax` 递增 `retstart` 分批 |

`retmode` 与 `rettype` 必须配合使用，每个库的合法组合见 [12-retmode-rettype.md](12-retmode-rettype.md)。要点：

- 所有库都支持 `rettype=docsum&retmode=xml`（等价于 ESummary 输出）和 `rettype=uilist`。
- `retmode=html` 已废弃：请求会按该库的默认 `retmode` 返回。
- 不指定时使用该库的默认组合（表中标 `default` 的值）。

序列库专用参数：

| 参数 | 说明 |
| --- | --- |
| `strand` | DNA 链：`1` 正链，`2` 负链 |
| `seq_start` | 起始碱基坐标，`1` 表示序列第一个碱基 |
| `seq_stop` | 结束碱基坐标 |
| `complexity` | 返回的数据范围，取值见下表 |

`complexity` 取值：

| 值 | 返回内容 |
| --- | --- |
| `0` | 整个 blob |
| `1` | bioseq |
| `2` | minimal bioseq-set |
| `3` | minimal nuc-prot |
| `4` | minimal pub-set |

## 示例

```bash
# PubMed：文本摘要
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=17284678,9997&retmode=text&rettype=abstract

# PubMed：完整 XML
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=11748933,11700088&retmode=xml

# PubMed：MEDLINE 格式
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=17284678&retmode=text&rettype=medline

# PMC：XML
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=212403

# Nucleotide：正链前 100 个碱基 FASTA
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=21614549&strand=1&seq_start=1&seq_stop=100&rettype=fasta&retmode=text

# Nucleotide：负链前 100 个碱基 FASTA
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=21614549&strand=2&seq_start=1&seq_stop=100&rettype=fasta&retmode=text

# Nucleotide：nuc-prot 对象
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=21614549&complexity=3

# Nucleotide：ASN.1 / FASTA / GenBank / GBSeqXML / TinySeqXML
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nucleotide&id=5
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nucleotide&id=5&rettype=fasta
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nucleotide&id=5&rettype=gb
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nucleotide&id=5&rettype=gb&retmode=xml
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nucleotide&id=5&rettype=fasta&retmode=xml

# Protein：GenPept / GBSeqXML
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=protein&id=8&rettype=gp
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=protein&id=8&rettype=gp&retmode=xml

# Gene：完整 XML
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=gene&id=2&retmode=xml
```

## 返回结构（PubMed XML）

实测（2026-10-27）：当前 PubMed DTD 为 **PubMedArticle, 1st January 2025**。

```xml
<?xml version="1.0" ?>
<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN"
  "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation Status="MEDLINE" Owner="NLM" IndexingMethod="Manual">
      <PMID Version="1">11850928</PMID>
      <Article PubModel="Print">
        <Journal>
          <ISSN IssnType="Print">0003-987X</ISSN>
          <JournalIssue CitedMedium="Print">
            <Volume>92</Volume>
            <Issue>2</Issue>
            ...
```

常用节点：`MedlineCitation/PMID`、`Article/ArticleTitle`、`Article/Abstract/AbstractText`、`Article/Journal/Title`、`JournalIssue/PubDate`、`AuthorList/Author`、`ArticleIdList`（含 doi、pmc 等）、`MeshHeadingList`。

> 官方文档也指出 EFetch 的 XML 会按库遵循各自的 DTD；PubMed DTD 页：https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd

## 使用建议

- 详情页优先 `db=pubmed&retmode=xml`：信息最全，含摘要、MeSH、DOI、PMC ID。
- 只要摘要文本用于展示时，`retmode=text&rettype=abstract` 更省解析成本，但结构不稳定，不适合入库。
- EFetch 响应可能很大，`retmax` 控制在 200 以内、并设置较长的请求超时。
- 不要把 `retmode=html` 写进代码（已废弃）。
- 需要 JSON 时，列表用 ESummary，详情只能自己解析 XML。
