# History Server：WebEnv 与 query_key

来源：https://www.ncbi.nlm.nih.gov/books/NBK25497/#chapter2.Using_the_Entrez_History_Server

## 1. 三个参数

History 上的一个 UID 集合由三个参数表示：

```
db=<数据库> & query_key=<整数> & WebEnv=<环境字符串>
```

- `WebEnv`：编码后的"会话"字符串，把多个 query key 归到同一个环境。
- `query_key`：环境内某个集合的整数编号，从 1 开始。
- `db`：集合所属数据库。

## 2. 哪些调用会生成集合

| 调用 | 条件 | 产物 |
| --- | --- | --- |
| ESearch | `usehistory=y` | 检索结果集（`WebEnv` + `query_key`） |
| EPost | 总是 | 上传的 ID 列表（新 `query_key`） |
| ELink | `cmd=neighbor_history` | 链接结果的 UID 集 |

```bash
esearch.fcgi?db=pubmed&term=asthma&usehistory=y
epost.fcgi?db=pubmed&id=uid1,uid2,uid3
elink.fcgi?dbfrom=pubmed&db=pmc&cmd=neighbor_history&id=uid1,uid2
```

## 3. 哪些调用会消费集合

| 调用 | 用法 |
| --- | --- |
| ESummary | `db` + `WebEnv` + `query_key` |
| EFetch | `db` + `WebEnv` + `query_key` + `rettype/retmode` |
| ELink | `dbfrom` + `db` + `WebEnv` + `query_key` |
| ESearch | 在 `term` 中用 `#<key>` 引用集合，并传 `WebEnv` 与 `usehistory=y` |

```bash
esummary.fcgi?db=pubmed&WebEnv=<webenv>&query_key=1
efetch.fcgi?db=pubmed&WebEnv=<webenv>&query_key=1&rettype=abstract&retmode=text
elink.fcgi?dbfrom=pubmed&db=pmc&WebEnv=<webenv>&query_key=1
esearch.fcgi?db=pubmed&term=%231+AND+review%5Bpt%5D&WebEnv=<webenv>&usehistory=y
```

## 4. 多个集合必须共享同一个 WebEnv

同一个 WebEnv 下可以有任意多个 query key，因此可以用 AND / OR / NOT 组合不同数据集。**要组合的两个集合必须在同一个 WebEnv 中。**

默认行为（两次独立调用）：

```bash
epost.fcgi?db=pubmed&id=uid1,uid2,uid3        # → web1, key 1
esearch.fcgi?db=pubmed&term=query&usehistory=y # → web2, key 1
```

| URL | WebEnv | query_key | 集合 |
| --- | --- | --- | --- |
| 1 | web1 | 1 | uid1,uid2,uid3 |
| 2 | web2 | 1 | 匹配 query 的 UID |

期望行为（第二次调用带上第一次的 WebEnv）：

```bash
epost.fcgi?db=pubmed&id=uid1,uid2,uid3                      # → web1, key 1
esearch.fcgi?db=pubmed&term=query&usehistory=y&WebEnv=web1  # → web1, key 2
```

| URL | WebEnv | query_key | 集合 |
| --- | --- | --- | --- |
| 1 | web1 | 1 | uid1,uid2,uid3 |
| 2 | web1 | 2 | 匹配 query 的 UID |

规则：**除第一次调用外，后续每次调用都要把已有的 `WebEnv` 传进去。**

## 5. 在 term 中引用 query key

- 直接传 `query_key=1` 时，ESearch 取该集合与 `term` 结果的**交集（AND）**。
- 如果需要 OR / NOT，或想同时引用多个集合，把 key 写进 `term`：`#1`（URL 中 `%231`）。
- 用 `#key` 时仍须提供 `WebEnv` 且 `usehistory=y`。

```bash
# 等价写法
esearch.fcgi?db=pubmed&term=asthma&query_key=1&WebEnv=<webenv>&usehistory=y
esearch.fcgi?db=pubmed&term=%231+AND+asthma&WebEnv=<webenv>&usehistory=y
```

## 6. 常见流水线

| 目标 | 流水线 |
| --- | --- |
| 检索式 → 记录 | ESearch → ESummary / EFetch |
| ID 列表 → 记录 | EPost → ESummary / EFetch |
| 找关联记录 | ESearch → ELink、EPost → ELink |
| 用检索式筛选 ID 列表 | EPost → ESearch |
| A 库检索 → B 库记录 | ESearch → ELink → ESummary / EFetch |
| ID 列表 ⊂ 检索结果的记录 | EPost → ESearch → ESummary / EFetch |
| 大 ID 集 → B 库关联 → 筛选 → 记录 | EPost → ELink → ESearch → EFetch |

## 7. 生命周期与注意事项

- 官方未承诺集合的保留时长；实践中应在同一批任务内尽快消费，不要跨天依赖旧 `WebEnv`。
- `WebEnv` 含特殊字符，拼进 URL 时必须编码；参数名必须写成 `WebEnv`（大写 W、E）。
- History 集合与 IP/会话相关，不适合作为跨用户共享的缓存。
- History 只存 UID，不存记录内容；需要内容仍要 EFetch。
- 超过 1 万条结果时，ESearch 只能给出前 1 万条；用 History 分批或按日期切分查询。
