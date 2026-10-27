# NCBI E-utilities 官方文档中文整理

本目录整理 NCBI Entrez Programming Utilities（E-utilities）的官方说明，供后续开发（如为文献检索插件接入 PubMed / PMC 数据源）查阅。

- 整理日期：2026-10-27
- 原文版本：NCBI Bookshelf《Entrez® Programming Utilities Help》(NBK25501)，其中
  - 第 2 章《A General Introduction to the E-utilities》最后更新 2022-11-17
  - 第 4 章《The E-utilities In-Depth: Parameters, Syntax and More》最后更新 2026-03-04
- 说明：中文为整理与翻译，参数名、端点、示例 URL 保留官方原文；与官方不一致时以官方页面为准。

## 官方来源

| 内容 | 地址 |
| --- | --- |
| E-utilities 帮助首页（会跳转到 Bookshelf） | https://eutils.ncbi.nlm.nih.gov/ |
| 全书目录 / 总说明（Bookshelf） | https://www.ncbi.nlm.nih.gov/books/NBK25501/ |
| 入门介绍：A General Introduction to the E-utilities | https://www.ncbi.nlm.nih.gov/books/NBK25497/ |
| 参数详解：The E-utilities In-Depth | https://www.ncbi.nlm.nih.gov/books/NBK25499/ |
| EFetch 的 retmode / rettype 合法值表 | https://www.ncbi.nlm.nih.gov/books/NBK25499/table/chapter4.T._valid_values_of__retmode_and/ |
| Entrez 数据库与 UID 对照表 | https://www.ncbi.nlm.nih.gov/books/NBK25497/table/chapter2.T._entrez_unique_identifiers_ui/ |
| NLM Data Guide（九个工具的简明版，已停止更新） | https://dataguide.nlm.nih.gov/eutilities/utilities.html |
| Entrez 链接全表 | https://eutils.ncbi.nlm.nih.gov/entrez/query/static/entrezlinks.html |
| PubMed 帮助（检索字段与标签） | https://www.ncbi.nlm.nih.gov/books/NBK3827/ |

> 访问提示：www.ncbi.nlm.nih.gov 对无浏览器特征的抓取会返回 reCAPTCHA 页面；用真实浏览器打开可正常阅读，`eutils.ncbi.nlm.nih.gov` 的 API 端点本身不受影响。

## 目录

| 文档 | 内容 |
| --- | --- |
| [01-overview.md](01-overview.md) | 概述、基础 URL、URL 编码规则、九个工具速查、Entrez 体系与 UID |
| [02-usage-policy.md](02-usage-policy.md) | 使用规范：频率限制、API Key、tool/email 注册、批量与时间窗口、版权 |
| [03-esearch.md](03-esearch.md) | ESearch：文本检索，返回 UID 列表 |
| [04-epost.md](04-epost.md) | EPost：上传 UID 列表到 History Server |
| [05-esummary.md](05-esummary.md) | ESummary：批量获取文献摘要（DocSum） |
| [06-efetch.md](06-efetch.md) | EFetch：获取完整记录（PubMed XML / MEDLINE / 摘要文本等） |
| [07-elink.md](07-elink.md) | ELink：相关文献、跨库链接、LinkOut |
| [08-egquery.md](08-egquery.md) | EGQuery：全库计数 |
| [09-espell.md](09-espell.md) | ESpell：拼写纠错建议 |
| [10-ecitmatch.md](10-ecitmatch.md) | ECitMatch：引文字符串批量匹配 PMID |
| [11-history-server.md](11-history-server.md) | History Server：WebEnv / query_key 与多步流水线 |
| [12-retmode-rettype.md](12-retmode-rettype.md) | EFetch 的 retmode / rettype 全库合法值 |
| [13-databases-uids.md](13-databases-uids.md) | Entrez 数据库名与 UID 对照 |
| [14-integration-notes.md](14-integration-notes.md) | 面向本项目的接入要点、请求模板与常见坑 |

## 建议阅读顺序

1. [01-overview.md](01-overview.md) + [02-usage-policy.md](02-usage-policy.md)：先弄清端点、限流与合规要求。
2. [14-integration-notes.md](14-integration-notes.md)：实际接入文献检索时最常查的一页。
3. 按需查阅具体工具的文档；需要超过 1 万条结果时看 [11-history-server.md](11-history-server.md)。

## 版权与免责

E-utilities 使用时须向用户展示 NCBI 的免责声明与版权声明（https://www.ncbi.nlm.nih.gov/About/disclaimer.html）。PubMed 摘要可能包含受美国及外国版权法保护的内容，转载、再分发或商业使用需遵循权利人条款；超出合理使用范围需取得书面许可。大规模 PubMed 数据挖掘建议下载本地副本：https://www.nlm.nih.gov/databases/download/pubmed_medline.html
