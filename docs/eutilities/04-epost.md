# EPost：上传 UID 列表

来源：https://www.ncbi.nlm.nih.gov/books/NBK25499/ （EPost 一节）

```
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/epost.fcgi
```

## 功能

- 把一组 UID 上传到 Entrez History Server
- 把 UID 列表追加到已有 Web Environment 下的集合

## 必需参数

| 参数 | 说明 |
| --- | --- |
| `db` | UID 所属数据库（默认 `pubmed`） |
| `id` | 单个 UID 或逗号分隔的 UID 列表，必须来自 `db` 指定的库 |

数量限制：

- PubMed / PMC：**单次 URL 最多 10,000 个 UID**。
- 其他库没有硬上限，但**超过约 200 个 UID 时应改用 HTTP POST**。
- 序列库（nuccore、popset、protein）允许混合 GI 号与 accession.version。使用 accession.version 时 NCBI 内部有转换步骤，大批量会超时，即使 POST 也一样；建议按 **≤ 500 个/批** 拆分，避免只取回部分记录。

## 可选参数

| 参数 | 说明 |
| --- | --- |
| `WebEnv` | 指定接收本次 UID 列表的 Web 环境。EPost 会在该环境下新建一个 query key。通常取自之前的 ESearch / EPost / ELink 输出。不提供时，EPost 新建 Web 环境并写入 `query_key=1` |

## 示例

```bash
# 上传 3 个 PMID
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/epost.fcgi?db=pubmed&id=19393038,30242208,29453458

# 混合 GI 与 accession.version
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/epost.fcgi?db=protein&id=15718680,NP_001098858.1,119703751

# 追加到已有 Web 环境
https://eutils.ncbi.nlm.nih.gov/entrez/eutils/epost.fcgi?db=protein&id=15718680,157427902,119703751&WebEnv=<webenv string>
```

## 返回

XML 中包含 `WebEnv` 与 `QueryKey`，后续可直接交给 ESummary / EFetch / ELink：

```xml
<ePostResult>
  <QueryKey>1</QueryKey>
  <WebEnv>MCID_...</WebEnv>
</ePostResult>
```

## 使用建议

- 从本地数据库或别家 API 拿到 PMID 列表后，先 EPost 再 EFetch，是最高效的批量取数方式。
- 一批 EPost + 一批 EFetch 通常比逐个请求快一个数量级，也更不容易触发限流。
- 需要与另一次检索结果做 AND / OR / NOT 组合时，务必把同一个 `WebEnv` 传给后续调用（见 [11-history-server.md](11-history-server.md)）。
