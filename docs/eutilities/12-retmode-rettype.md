# EFetch：retmode / rettype 合法值对照

来源（官方 Table 1）：https://www.ncbi.nlm.nih.gov/books/NBK25499/table/chapter4.T._valid_values_of__retmode_and/

说明：

- `null` = 空字符串，即不传该参数。
- `default` 表示不指定时使用的默认值。
- 该表只适用于 EFetch；ESearch / ESummary / ELink 的 `retmode` 只有 `xml` / `json`。

## 所有数据库通用

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 文档摘要 | `docsum` | `xml`（默认） |
| UID 列表（XML） | `uilist` | `xml` |
| UID 列表（纯文本） | `uilist` | `text` |

## bioproject

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 完整记录 XML | `xml`（默认） | `xml`（默认） |

## biosample

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 完整记录 XML | `full`（默认） | `xml`（默认） |
| 完整记录文本 | `full`（默认） | `text` |

## gds

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 摘要 | `summary`（默认） | `text`（默认） |

## gene

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 文本 ASN.1 | `null` | `asn.1`（默认） |
| XML | `null` | `xml` |
| Gene 表 | `gene_table` | `text` |

## homologene

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 文本 ASN.1 | `null` | `asn.1`（默认） |
| XML | `null` | `xml` |
| 比对分数 | `alignmentscores` | `text` |
| FASTA | `fasta` | `text` |
| HomoloGene | `homologene` | `text` |

## mesh

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 完整记录 | `full`（默认） | `text`（默认） |

## nlmcatalog

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 完整记录 | `null` | `text`（默认） |
| XML | `null` | `xml` |

## nuccore / protein / popset

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 文本 ASN.1 | `null` | `text`（默认） |
| 二进制 ASN.1 | `null` | `asn.1` |
| 完整 XML 记录 | `native` | `xml` |
| Accession 号 | `acc` | `text` |
| FASTA | `fasta` | `text` |
| TinySeq XML | `fasta` | `xml` |
| SeqID 字符串 | `seqid` | `text` |

### nuccore / popset 额外选项

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| GenBank 平面文件 | `gb` | `text` |
| GBSeq XML | `gb` | `xml` |
| INSDSeq XML | `gbc` | `xml` |

### nuccore / protein 额外选项

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| Feature table | `ft` | `text` |

### nuccore 额外选项

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 含完整序列（contigs）的 GenBank 平面文件 | `gbwithparts` | `text` |
| CDS 核酸 FASTA | `fasta_cds_na` | `text` |
| CDS 蛋白 FASTA | `fasta_cds_aa` | `text` |

### protein 额外选项

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| GenPept 平面文件 | `gp` | `text` |
| GBSeq XML | `gp` | `xml` |
| INSDSeq XML | `gpc` | `xml` |
| Identical Protein XML | `ipg` | `xml` |

## pmc

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| XML | `null` | `xml`（默认） |
| MEDLINE | `medline` | `text` |

## pubmed

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| XML | `null` | `xml`（默认） |
| MEDLINE | `medline` | `text` |
| PMID 列表 | `uilist` | `text` |
| 摘要 | `abstract` | `text` |

## sequences

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 文本 ASN.1 | `null` | `text`（默认） |
| Accession 号 | `acc` | `text` |
| FASTA | `fasta` | `text` |
| SeqID 字符串 | `seqid` | `text` |

## snp

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| 文本 ASN.1 | `null` | `asn.1`（默认） |
| XML | `null` | `xml` |
| 平面文件 | `flt` | `text` |
| FASTA | `fasta` | `text` |
| RS Cluster 报告 | `rsr` | `text` |
| SS Exemplar 列表 | `ssexemplar` | `text` |
| 染色体报告 | `chr` | `text` |
| 摘要 | `docset` | `text` |
| UID 列表 | `uilist` | `text` 或 `xml` |

## sra

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| XML | `full`（默认） | `xml`（默认） |

## taxonomy

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| XML | `null` | `xml`（默认） |
| TaxID 列表 | `uilist` | `text` 或 `xml` |

## clinvar

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| ClinVar Set | `clinvarset` | `xml`（默认） |
| UID 列表 | `uilist` | `text` 或 `xml` |

## gtr

| 记录类型 | `rettype` | `retmode` |
| --- | --- | --- |
| GTR Test Report | `gtracc` | `xml`（默认） |

## 变更记录（与格式相关）

| 日期 | 变更 |
| --- | --- |
| 2015-06-24 | EFetch 支持 ClinVar 和 GTR；ELink 支持 JSON |
| 2014-02-14 | ESearch 支持 `sort`；EInfo、ESearch、ESummary 支持 JSON |
| 2013-08-09 | 新增 ECitMatch；EInfo v2.0 新增 `IsTruncatable`、`IsRangeable`；EFetch 支持 BioProject |
| 2012-02-15 | EFetch v2.0：支持 biosample、biosystems、sra；为所有支持的库定义默认 `retmode`/`rettype`；**不再支持 `retmode=html`**；`rettype=docsum` 返回与 ESummary 等价的 XML |
| 2011-11-09 | Genome 库重构，EFetch 不再支持 `db=genome` |
| 2011-11-04 | ESummary 支持 `version=2.0` |
