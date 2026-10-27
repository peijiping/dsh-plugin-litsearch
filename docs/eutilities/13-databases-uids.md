# Entrez 数据库与 UID 对照

来源（官方 Table 1）：https://www.ncbi.nlm.nih.gov/books/NBK25497/table/chapter2.T._entrez_unique_identifiers_ui/

| 数据库 | UID 名称 | E-utilities 库名（`db=`） |
| --- | --- | --- |
| BioProject | BioProject ID | `bioproject` |
| BioSample | BioSample ID | `biosample` |
| Books | Book ID | `books` |
| Conserved Domains | PSSM-ID | `cdd` |
| dbGaP | dbGaP ID | `gap` |
| dbVar | dbVar ID | `dbvar` |
| Gene | Gene ID | `gene` |
| Genome | Genome ID | `genome` |
| GEO Datasets | GDS ID | `gds` |
| GEO Profiles | GEO ID | `geoprofiles` |
| HomoloGene | HomoloGene ID | `homologene` |
| MeSH | MeSH ID | `mesh` |
| NCBI C++ Toolkit | Toolkit ID | `toolkit` |
| NLM Catalog | NLM Catalog ID | `nlmcatalog` |
| Nucleotide | GI number | `nuccore` |
| PopSet | PopSet ID | `popset` |
| Probe | Probe ID | `probe` |
| Protein | GI number | `protein` |
| Protein Clusters | Protein Cluster ID | `proteinclusters` |
| PubChem BioAssay | AID | `pcassay` |
| PubChem Compound | CID | `pccompound` |
| PubChem Substance | SID | `pcsubstance` |
| PubMed | PMID | `pubmed` |
| PubMed Central | PMCID | `pmc` |
| SNP | rs number | `snp` |
| SRA | SRA ID | `sra` |
| Structure | MMDB-ID | `structure` |
| Taxonomy | TaxID | `taxonomy` |

## 补充说明

- Entrez 当前共 38 个数据库，上表只列了官方给出的常用子集。要拿完整列表，调用不带 `db` 的 EInfo：

```bash
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi
```

- 各库支持的检索字段、可用链接，用 `einfo.fcgi?db=<库名>` 查询。
- 序列库（`nuccore`、`popset`、`protein`）现在以 **accession.version** 而不是 GI 号作为主标识，GI 号对新记录的分配已逐步停止：
  - 接受 UID 的接口同样接受 accession.version；
  - 输出时可用 `idtype=acc` 改为 accession.version；
  - EFetch 能按 accession.version 取回没有 GI 号的记录。
- 文献检索相关的主要是 `pubmed`（题录与摘要）、`pmc`（全文 XML）、`nlmcatalog`（期刊目录）、`mesh`（主题词）。
