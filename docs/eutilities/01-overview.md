# 概述与调用方式

来源：
- https://www.ncbi.nlm.nih.gov/books/NBK25497/ （第 2 章：A General Introduction to the E-utilities）
- https://www.ncbi.nlm.nih.gov/books/NBK25499/ （第 4 章：参数详解）

## 1. 什么是 E-utilities

Entrez Programming Utilities（E-utilities）是 NCBI 提供的一组服务端程序，用固定的 URL 语法访问 Entrez 检索与数据库系统。当前 Entrez 包含 38 个数据库，涵盖核酸/蛋白序列、基因记录、三维结构、生物医学文献等。

调用方式：程序向 NCBI 发送一个 E-utility URL，取回结果（默认 XML，部分工具支持 JSON），再自行解析处理。任何能发 HTTP 请求、能解析 XML/JSON 的语言都可以使用。

> 注意：Bookshelf 全书首页的简介写的是 "eight server-side programs"，但第 2 章与第 4 章均按 **九个** 工具描述（含后来新增的 ECitMatch）。以章节列表为准。

## 2. 基础 URL

所有请求都应发往以下前缀（该组服务器专供 E-utilities 使用）：

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
```

每个工具一个 `.fcgi` 端点：

| 工具 | 端点 | 作用 |
| --- | --- | --- |
| EInfo | `einfo.fcgi` | 数据库统计、索引字段、可用链接 |
| ESearch | `esearch.fcgi` | 文本检索，返回匹配的 UID 列表 |
| EPost | `epost.fcgi` | 上传 UID 列表到 History Server |
| ESummary | `esummary.fcgi` | 按 UID 列表返回文档摘要（DocSum） |
| EFetch | `efetch.fcgi` | 按 UID 列表返回完整记录（指定格式） |
| ELink | `elink.fcgi` | 同库相关记录 / 跨库链接 / LinkOut |
| EGQuery | `egquery.fcgi` | 全库计数 |
| ESpell | `espell.fcgi` | 拼写建议 |
| ECitMatch | `ecitmatch.cgi` | 引文字符串批量匹配 PMID |

请求形如：

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=asthma&retmax=20
```

## 3. URL 构造规则

- 参数名一律**小写**，唯一的例外是 `&WebEnv`（大写 W、大写 E）。
- 参数顺序无要求；空值或不适用的参数通常会被忽略。
- URL 中不要出现空格，用 `+` 代替：

```
错误：&term=biomol mrna[properties] AND mouse[organism]
正确：&term=biomol+mrna[properties]+AND+mouse[organism]

错误：&id=352, 25125, 234
正确：&id=352,25125,234
```

- 其他特殊字符用 URL 编码，例如双引号 `%22`、`#`（History 的 query key 前缀）`%23`：

```
错误：&term=#2+AND+"gene in genomic"[properties]
正确：&term=%232+AND+%22gene+in+genomic%22[properties]
```

- **长查询或长 ID 列表用 HTTP POST**：查询超过数百字符，或 UID 超过约 200 个时，官方建议改用 POST。
- 所有请求建议带上 `tool` 与 `email`（见 [02-usage-policy.md](02-usage-policy.md)）。

## 4. 返回格式

- 默认 XML，每个工具（EFetch 除外）有固定的 DTD，XML 头部会给出 DTD 链接。
- 支持 JSON 的工具（按官方 Release Notes 与参数说明）：**EInfo、ESearch、ESummary、ELink**，通过 `retmode=json` 指定。
- **EFetch 不支持 JSON**，只能取 XML 或纯文本，格式由 `retmode` + `rettype` 组合决定（见 [12-retmode-rettype.md](12-retmode-rettype.md)）。
- ESummary 加 `version=2.0` 会返回按库定制的 DocSum XML，字段通常更丰富。
- EGQuery、ESpell 文档未提供 JSON 模式；ECitMatch 仅支持 XML。

## 5. Entrez 体系要点

### 5.1 只有已在 Entrez 中的数据才能被检索

E-utilities 访问的是 Entrez 的检索与取回引擎，NCBI 有一部分数据不在 Entrez 中。立项前先确认目标数据在某个 Entrez 库里（可用 EInfo 列出所有库）。

### 5.2 UID 是记录主键

每个库用整数 UID 标识记录：PubMed 是 PMID，Nucleotide/Protein 是 GI 号，Structure 是 MMDB-ID，Taxonomy 是 TaxID。E-utilities 的输入输出基本都以 UID 为核心。完整对照见 [13-databases-uids.md](13-databases-uids.md)。

序列库（nuccore、nucest、nucgss、popset、protein）现在主标识是 **accession.version**。接受 UID 的接口也接受 accession.version；输出可用 `idtype=acc` 改为 accession.version；EFetch 能按 accession.version 取回没有 GI 号的记录。

### 5.3 检索式语法

Entrez 查询基本形式：

```
term1[field1] Op term2[field2] Op term3[field3] ...
```

- 布尔运算符必须全大写：`AND` / `OR` / `NOT`。
- 词与运算符之间必须有空格分隔。
- 纯 UID 或 accession 列表不做解析，直接返回对应记录。
- 字段标签因库而异，PubMed 的字段与标签见 PubMed Help。

示例：

```
human[organism] AND topoisomerase[protein name]
```

### 5.4 DocSum 与记录

- ESearch 只返回 UID 列表与检索式翻译，不含记录内容。
- ESummary 返回 DocSum（摘要级字段）。
- EFetch 返回完整记录，并按库支持多种格式（如 PubMed 的 abstract、MEDLINE、XML；Protein 的 FASTA、GenPept）。
- ELink 返回关联 UID，不返回记录内容。

## 6. 九个工具速查

| 工具 | 输入 | 输出 | 典型用途 |
| --- | --- | --- | --- |
| EInfo | 无 / `db` | 库列表、字段、链接、记录数 | 探测可用库与检索字段 |
| ESearch | `db`, `term` | UID 列表、总数、检索式翻译 | 关键词检索、计数 |
| EPost | `db`, `id` 列表 | `WebEnv`, `QueryKey` | 把已有 ID 列表交给 History Server |
| ESummary | `db`, `id` 列表或 History | DocSum | 列表页展示（标题、作者、期刊、日期） |
| EFetch | `db`, `id` 列表或 History | 完整记录（格式可选） | 详情页、导出、全文元数据 |
| ELink | `dbfrom`, `db`, `id`, `cmd` | 关联 UID / LinkOut | 相关文献、PubMed↔PMC、全文链接 |
| EGQuery | `term` | 各库命中数 | 全局计数、选择目标库 |
| ESpell | `db`, `term` | 纠正后的查询 | "你是不是要找……" |
| ECitMatch | `bdata` 引文字符串 | PMID | 从参考文献列表反查 PMID |

## 7. 组合调用（流水线）

History Server 让多个调用之间传递结果集（`db` + `WebEnv` + `query_key`）。基础组合：

| 目标 | 流水线 |
| --- | --- |
| 按检索式取记录 | ESearch → ESummary / EFetch |
| 按已知 ID 列表取记录 | EPost → ESummary / EFetch |
| 找关联记录 | ESearch → ELink、EPost → ELink |
| 用检索式筛选一组 ID | EPost → ESearch、ELink → ESearch |
| A 库检索 → B 库记录 | ESearch → ELink → ESummary/EFetch |
| 大 ID 集 → 子集 → 记录 | EPost → ESearch → EFetch |
| 大 ID 集 → B 库关联 → 筛选 → 记录 | EPost → ELink → ESearch → EFetch |

细节见 [11-history-server.md](11-history-server.md)。
