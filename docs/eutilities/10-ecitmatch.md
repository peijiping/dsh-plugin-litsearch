# ECitMatch：引文批量匹配

来源：https://www.ncbi.nlm.nih.gov/books/NBK25499/ （ECitMatch 一节）

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/ecitmatch.cgi
```

> 注意端点是 **`.cgi`**，不是 `.fcgi`。ECitMatch 是 PubMed 网页版 Batch Citation Matcher 的 API（https://www.ncbi.nlm.nih.gov/pubmed/batchcitmatch）。

## 功能

输入一组引文字符串（期刊、年、卷、首页、作者），返回对应的 PubMed ID（PMID）。

## 参数

| 参数 | 说明 |
| --- | --- |
| `db` | 唯一支持 `pubmed` |
| `rettype` | 官方参数说明写唯一支持 `xml` |
| `bdata` | 引文字符串，必需 |

### bdata 格式

每条引文：

```
journal_title|year|volume|first_page|author_name|your_key|
```

- 多条引文之间用回车符分隔，URL 中写成 `%0D`。
- `your_key` 是用户自定义标签，会原样出现在输出里，便于做本地对应。
- 所有空格替换为 `+`。
- 每条引文**以竖线 `|` 结尾**。

```bash
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/ecitmatch.cgi?db=pubmed&retmode=xml&bdata=proc+natl+acad+sci+u+s+a|1991|88|3248|mann+bj|Art1|%0Dscience|1987|235|182|palmenberg+ac|Art2|
```

> 官方文档的参数表写 `rettype=xml`，但同页示例用的是 `retmode=xml`。实测按示例传 `retmode=xml` 可以正常工作。

## 返回

实测（2026-10-27）返回的是**纯文本**，不是 XML；每行对应一条输入，格式为：

```
journal_title|year|volume|first_page|author_name|your_key|PMID
```

示例输出：

```
proc natl acad sci u s a|1991|88|3248|mann bj|Art1|2014248
```

匹配不到时末尾 PMID 为空。`Content-Type` 可能是 text/plain，解析时不要假设 XML。

## 使用建议

- 典型场景：用户粘贴参考文献列表 → 拆成条目 → 组装 `bdata` → 一次拿到一批 PMID → 再 ESummary/EFetch 取元数据。
- 每条最多 6 个字段，缺失字段留空但竖线不能省。
- 一次请求的引文条数官方未给硬上限，但建议控制在几十条，并统一走限流。
- 期刊名用标准缩写或全名均可，但缩写命中率更高。
- 结果为空不代表文献不存在，可降级为 ESearch 的 `[ta]`/`[vi]`/`[pg]` 组合检索。
