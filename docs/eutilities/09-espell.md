# ESpell：拼写建议

来源：https://www.ncbi.nlm.nih.gov/books/NBK25499/ （ESpell 一节）

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/espell.fcgi
```

## 功能

对某个数据库中的单条文本查询给出拼写纠正建议，相当于 PubMed 网页上"你是不是要找……"的 API。

## 参数

| 参数 | 说明 |
| --- | --- |
| `db` | 数据库名（默认 `pubmed`） |
| `term` | Entrez 查询式，必需；特殊字符须 URL 编码，空格可用 `+`；很长的查询建议 POST |

```bash
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/espell.fcgi?db=pubmed&term=asthmaa+OR+alergies
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/espell.fcgi?db=pubmed&term=deoxyribonulceic+acid
```

## 返回

只有 XML（无 JSON 模式）。实测（2026-10-27）：

```xml
<?xml version="1.0"?>
<!DOCTYPE eSpellResult PUBLIC "-//NLM//DTD eSpellResult, 23 November 2004//EN"
  "https://www.ncbi.nlm.nih.gov/entrez/query/DTD/eSpell.dtd">
<eSpellResult>
  <Database>pubmed</Database>
  <Query>asthmaa</Query>
  <CorrectedQuery>asthma</CorrectedQuery>
  <SpelledQuery>
    <Original></Original>
    <Replaced>asthma</Replaced>
  </SpelledQuery>
  <ERROR/>
</eSpellResult>
```

字段：

| 节点 | 含义 |
| --- | --- |
| `Database` | 库名 |
| `Query` | 原始查询 |
| `CorrectedQuery` | 纠正后的查询；**为空（`<CorrectedQuery/>`）表示没有建议** |
| `SpelledQuery` | 逐词替换明细（`Original` / `Replaced`），无建议时同样为空 |
| `ERROR` | 一般为空 |

查询本身拼写正确时（实测 `term=asthma`）：

```xml
<eSpellResult>
  <Database>pubmed</Database>
  <Query>asthma</Query>
  <CorrectedQuery/>
  <SpelledQuery/>
  <ERROR/>
</eSpellResult>
```

## 使用建议

- 在搜索框失焦或结果为空时调用，给出"是否要搜索 xxx"。
- 每次只处理一条查询；多关键词用 `OR`/`AND` 拼接时建议对每个词分别调用或直接展示整体纠正结果。
- 该接口对 request 数敏感，建议加短缓存（如 24 小时）并纳入统一限流。
