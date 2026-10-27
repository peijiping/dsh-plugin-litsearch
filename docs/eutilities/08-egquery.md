# EGQuery：全库计数

来源：https://www.ncbi.nlm.nih.gov/books/NBK25499/ （EGQuery 一节）

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/egquery.fcgi
```

## 功能

对一个文本查询，返回它在**每个 Entrez 数据库**中的命中记录数。相当于全局版 ESearch，只给计数，不返回 UID。

## 参数

| 参数 | 说明 |
| --- | --- |
| `term` | Entrez 查询式，必需。特殊字符须 URL 编码，空格可用 `+`；很长的查询建议 POST |

```bash
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/egquery.fcgi?term=asthma
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/egquery.fcgi?term=breast+cancer
```

返回 XML 为 `eGQueryResult`，`ResultItem` 逐库给出 `DbName`、`MenuName`、`Count`、`Status`。

## 现状提示（2026-10 实测）

`egquery.fcgi` 目前返回 **301**，重定向到：

```
https://ext-http-eutils.linkerd.ncbi.nlm.nih.gov/gquery?term=...&retmode=xml
```

该目标主机在部分网络环境下无法解析（本次测试即如此）。实际使用中：

- 如果只需要 PubMed 的命中数，用 ESearch 更稳：`esearch.fcgi?db=pubmed&term=...&rettype=count&retmode=json`。
- 需要比较多个库时，对每个候选库分别调用 ESearch 计数，或改用 EInfo 了解库的规模。
- 接入前先在你的部署环境里探测一次 EGQuery 是否可达，不要把 EGQuery 作为唯一路径。

## 使用建议

- 用于"这个主题在哪些库有数据"的探索，不适合作为生产主链路。
- 与 ESearch 的 `rettype=count` 相比没有额外信息，且当前存在跳转问题，新代码优先用 ESearch。
