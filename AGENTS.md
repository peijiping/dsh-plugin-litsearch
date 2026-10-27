# AGENTS.md

面向 AI 编码代理的项目指南。

## 项目概述

DSH 文献检索插件，基于 cordis 框架（`@deepseek-ai/cordis`）。聚合免费文献 API（当前为 OpenAlex、Crossref），同时提供：

- **模型侧工具**：Host 直接调用上游 API，以 `literature_search` / `literature_sources` 注册进 dsh 工具表。
- **人侧界面**：右侧栏「文献检索」面板，相同检索能力，可把结果插入会话草稿。

不依赖本地服务或外部 MCP，安装即用。

## 目录结构

- `src/` — 插件主包源码（ESM，NodeNext）
  - `index.ts` — 插件入口：Config schema、工具注册、HTTP 路由
  - `search/` — 数据源无关的检索层
    - `types.ts` — `Paper`、数据源 id、请求/响应类型
    - `config.ts` — 默认值、volatile 设置读取面、路由前缀
    - `errors.ts` — `SearchError` 错误码
    - `http.ts` — 带超时的 JSON 请求 helper
    - `aggregate.ts` — 多源并发、去重、错误汇总
    - `providers/` — 每家免费 API 一个文件，统一实现 `Provider`
  - `host/` — Host 半
    - `router.ts` — `/dsh-litsearch/api/*` 只读端点
    - `tools.ts` — 模型侧工具定义与参数校验
  - `client/` — 浏览器（web）半：右侧栏 tab、检索面板、配置卡
- `client/` — 客户端构建产物 `client.js`（由 tsdown 产出，勿手改）
- `lib/` — `tsc` 构建产物（勿手改）

## 常用命令

```bash
pnpm build            # tsc 编译 src/ -> lib/
pnpm build:client     # tsdown 打包 client
pnpm typecheck:client # tsc --noEmit 校验 client
```

## 硬性约束

- **包管理器**：统一使用 **pnpm**，不得与 npm / yarn 混用（锁文件互不兼容，混装会导致 `node_modules` 结构反复重建）。
- **TypeScript 版本**：tsdown@0.22.0 的 peer 依赖要求 `typescript ^5.0.0 || ^6.0.0`，**不支持 TypeScript 7.x**；固定使用 `^5.9.0`。
- **构建产物**：不要修改 `lib/`、`client/client.js` 等产物文件。
- **免费数据源**：只接入无需付费、无需申请密钥、允许程序化访问的 API；改动接入方式前先确认其使用条款与限流要求。

## 约定

- 主包为 ESM（`"type": "module"`），模块解析 NodeNext，strict 模式；Host 侧相对导入必须带 `.js` 后缀。
- Client 侧使用 Bundler 解析、React 18，UI 组件从 `@deepseek-ai/dsh-client-ui-primitives` 获取。
- 新增数据源：在 `src/search/providers/` 新建实现 `Provider` 的文件，并在 `providers/index.ts` 注册；同时补 `types.ts` 的 `SOURCE_IDS` 与中英文案。
- 发布文件清单见 `package.json` 的 `files` 字段：`lib`、`client`、`cordis.patch.yml`。
- `dsh` 配置字段定义了 client 注入项与平台（web），修改需谨慎。
- 遵循迭代改进方式，避免过度工程化，优先轻量方案。
