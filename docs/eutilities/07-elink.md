# ELink：关联记录与链接

来源：https://www.ncbi.nlm.nih.gov/books/NBK25499/ （ELink 一节）

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi
```

## 功能

- 返回与输入 UID 相关联的 UID（同库或跨库）
- 返回同库中符合某个查询的关联 UID
- 检查一组 UID 是否存在 Entrez 链接
- 列出某个 UID 可用的链接
- 列出 LinkOut URL 及属性
- 列出一组 UID 的主 LinkOut 提供者超链接
- 为单个 UID 生成指向主 LinkOut 提供者的超链接

## 指定链接方式（三选一，优先 linkname）

### 方式 1（首选）：`linkname`

```
linkname=dbfrom_db_subset
```

例：`gene_protein_refseq`。使用 `linkname` 时 ELink 只取这一种链接，效率最高。全部取值见 Entrez 链接表：https://eutils.ncbi.nlm.nih.gov/entrez/query/static/entrezlinks.html

**`linkname` 仅在 `cmd=neighbor` 或 `cmd=neighbor_history` 时生效。**

```bash
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?id=93986&linkname=gene_protein_refseq
```

### 方式 2：`db` + `dbfrom`

| 参数 | 说明 |
| --- | --- |
| `db` | 目标数据库（默认 `pubmed`） |
| `dbfrom` | 输入 UID 所属数据库（默认 `pubmed`）。两者相同时返回该库内的"计算邻居"（相关记录） |

省略任一参数时 ELink 会按 `pubmed` 处理。**若同时给了 `linkname`，`db` 与 `dbfrom` 会被忽略。**

```bash
# Gene → Protein 的全部链接类型
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=gene&db=protein&id=93986
```

同库邻居的 linkname 形如 `dbname_dbname`（如 `protein_protein`、`pcassay_pcassay_activityneighbor`）。

## `cmd`：命令模式

| 值 | 作用 |
| --- | --- |
| `neighbor`（默认） | 返回 `db` 中与 `dbfrom` 输入 UID 关联的 UID |
| `neighbor_score` | 返回同库相关 UID，并附带相似度分数（如 PubMed 相关文献） |
| `neighbor_history` | 把输出 UID 投递到 History Server，返回 `query_key` 与 `WebEnv` |
| `acheck` | 列出这组 UID 可用的全部链接 |
| `ncheck` | 检查同库内链接是否存在（等价于 `db` 与 `dbfrom` 相同） |
| `lcheck` | 检查是否存在外部链接（LinkOut） |
| `llinks` | 列出非图书馆类 LinkOut 提供者的 URL 与属性 |
| `llinkslib` | 列出所有 LinkOut 提供者（含图书馆）的 URL 与属性 |
| `prlinks` | 列出每个 UID 的主 LinkOut 提供者；单个 UID 且 `retmode=ref` 时直接跳转到提供者网站 |

示例：

```bash
# 相关文献（带分数）
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pubmed&id=20210808&cmd=neighbor_score

# PubMed → PMC
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pmc&id=19879512

# 投递到 History
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=protein&db=gene&id=15718680,157427902&cmd=neighbor_history

# 列出两条 protein 记录的全部可用链接
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=protein&id=15718680,157427902&cmd=acheck

# 检查同库相关序列链接
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=nuccore&id=21614549,219152114&cmd=ncheck

# LinkOut：非图书馆 / 含图书馆 / 主提供者 / 直接跳转
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&id=19880848,19822630&cmd=llinks
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&id=19880848,19822630&cmd=llinkslib
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&id=19880848,19822630&cmd=prlinks
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&id=19880848&cmd=prlinks&retmode=ref
```

## 输入

| 参数 | 说明 |
| --- | --- |
| `id` | 单个或逗号分隔 UID，必须属于 `dbfrom`。无硬上限，超过约 200 个建议 POST |
| `query_key` + `WebEnv` | 从 History Server 取输入集合，两者须同时使用 |

**一对多注意事项**：如果传多个 `id` 参数（不是逗号列表），ELink 会对每个集合分别做链接操作，从而得到"一对一"结果并保留输入与输出的对应关系：

```bash
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=protein&db=gene&id=15718680&id=157427902&id=119703751
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=protein&db=gene&id=15718680&id=NP_001098858.1&id=119703751
```

## 可选参数

| 参数 | 说明 |
| --- | --- |
| `retmode` | `xml`（默认）或 `json` |
| `idtype` | 序列库用；`idtype=acc` 返回 accession.version 而非 GI |
| `term` | 对链接结果再做 Entrez 查询过滤。**仅当 `db` 与 `dbfrom` 相同才生效** |
| `holding` | 只返回指定 LinkOut 提供者的 URL；值为 ELink XML 中的 `<NameAbbr>`。**仅 `cmd=llinks` / `llinkslib` 生效** |
| `datetype` / `reldate` / `mindate` / `maxdate` | 日期过滤。**仅 `cmd=neighbor` / `neighbor_history` 且 `dbfrom=pubmed` 生效** |

```bash
# 某篇文献的 2008 年相关综述
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&db=pubmed&id=19879512&term=review%5Bfilter%5D+AND+2008%5Bpdat%5D

# 只看 clinicaltrials.gov 提供的 LinkOut
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?dbfrom=pubmed&cmd=llinkslib&id=16210666&holding=CTgov
```

## JSON 返回结构

实测（`dbfrom=pubmed&db=pubmed&id=19879512&retmode=json`，2026-10-27）：

```json
{
  "header": { "type": "elink", "version": "0.3" },
  "linksets": [
    {
      "dbfrom": "pubmed",
      "ids": ["19879512"],
      "linksetdbs": [
        {
          "dbto": "pubmed",
          "linkname": "pubmed_pubmed",
          "links": ["19879512", "14513539", "19484671", "..."]
        }
      ]
    }
  ]
}
```

`cmd=neighbor_score` 时 `links` 的结构会变成对象数组（实测）：

```json
"linksetdbs": [{
  "dbto": "pubmed",
  "linkname": "pubmed_pubmed",
  "links": [
    { "id": "15876306", "score": 50184092 },
    { "id": "15466689", "score": 43628999 }
  ]
}]
```

不带 `neighbor_score` 时 `links` 是字符串数组。解析时需要兼容两种形态。

## 使用建议

- "相关文献"用 `cmd=neighbor_score&linkname=pubmed_pubmed`；只要纯相关列表用默认 `pubmed_pubmed`。
- 判断有无 PMC 全文：`dbfrom=pubmed&db=pmc` 看返回是否有链接，或用 ESummary v2.0 的 `pmcrefcount` 辅助判断。
- `cmd=neighbor_history` 可把相关文献集直接接入后续 EFetch，省掉一次 ID 中转。
