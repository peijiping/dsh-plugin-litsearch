# 使用规范与频率限制

来源：https://www.ncbi.nlm.nih.gov/books/NBK25497/#chapter2.Usage_Guidelines_and_Requiremen

## 1. 频率

- **无 API Key：每个 IP 每秒最多 3 个请求**。超过会收到错误响应。
- **带 API Key：默认每秒最多 10 个请求**；需要更高频率须向 NCBI 申请。
- 典型限流错误：

```json
{"error":"API rate limit exceeded","count":"11"}
```

- 实测响应头会返回当前窗口的额度（`X-Ratelimit-Limit: 3`、`X-Ratelimit-Remaining: 2`），可用于自适应限流。

## 2. 时间窗口

大批量任务请安排在**周末**，或工作日**美东时间 21:00–05:00**。不遵守可能导致 IP 被封禁。

## 3. API Key

- 2018-12-01 起提供。在 NCBI 账号的 Settings 页面获取：https://www.ncbi.nlm.nih.gov/account/
- 每个 NCBI 账号只允许一个 Key；重新申请会使旧 Key 失效。
- 每个请求通过 `api_key` 参数携带：

```
esummary.fcgi?db=pubmed&id=123456&api_key=ABCDE12345
```

## 4. tool 与 email（强烈建议）

所有请求都应带：

| 参数 | 取值 |
| --- | --- |
| `tool` | 发起调用的应用名，**不能含空格**，需唯一标识该软件 |
| `email` | 开发者（不是终端用户）的完整有效邮箱 |

作用与后果：

- NCBI 发现违规请求时会先尝试用该邮箱联系开发者，再考虑封禁。
- 仅仅在请求里带 `tool`/`email` **不算合规**：被封锁后，需要把这两个值**注册**到 NCBI 才会解封。
- 注册方式：发邮件到 `vog.hin.mln.ibcn@seitilitue`（即 `eutils@ncbi.nlm.nih.gov` 的反写），附上 `tool`、`email` 以及开发者或组织名称。
- 注册后可要求加入 E-utilities 邮件列表，接收更新、已知 bug 与政策变更通知。
- 注册后，该软件的所有请求都应继续携带这两个值。

> 对插件类项目：把 `tool` 设为稳定的包名/产品名，`email` 用维护者邮箱，并在文档中说明；这既符合规范，也能在出问题时被及时联系。

## 5. 减少请求数

需要检索或下载大量记录时，不要一条记录一个请求：

- 用 **EPost** 一次上传成千上万个 ID。
- 用 **EFetch** 一次取回数百条记录。
- 超过 1 万条结果时用 **History Server** 分批（见 [11-history-server.md](11-history-server.md)）。

## 6. 版权与免责

- 在软件中使用 E-utilities，必须让用户能看到 NCBI 的免责声明与版权声明：https://www.ncbi.nlm.nih.gov/About/disclaimer.html
- PubMed 摘要可能含受版权保护的材料；转载、再分发、商业使用需遵守权利人条款；超出合理使用需书面许可。NLM 不提供法律意见。
- 大规模 PubMed 数据挖掘建议下载本地数据库副本：https://www.nlm.nih.gov/databases/download/pubmed_medline.html

## 7. 合规检查清单

- [ ] 所有请求走 `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/`
- [ ] 带 `tool` 与 `email`，且已向 NCBI 注册
- [ ] 客户端限流 ≤ 3 req/s（或无 Key 时），有 Key 时 ≤ 10 req/s
- [ ] 大批量任务安排在非高峰时段
- [ ] ID 列表 > 200 或查询很长时改用 POST
- [ ] 大批量取数使用 EPost / EFetch / History 批量
- [ ] 界面上可访问 NCBI 免责与版权声明
