/**
 * 文案字典（zh / en）。
 *
 * `t()` 只接受 key、返回字符串本身，不带插值；需要插值处用 {@link tpl}。
 * namespace 与 client 注册时使用的 NS 保持一致。
 */

export const NS = 'dsh-plugin-litsearch'

export type Translate = (key: string) => string

/** 极简占位符替换：`{name}` → 变量值。 */
export function tpl(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (_, key: string) => {
    const value = vars[key]
    return value === undefined ? '' : String(value)
  })
}

const zh: Record<string, string> = {
  'tab.title': '文献检索',
  'guide.title': '文献检索',
  'guide.desc': '检索免费开放学术文献，把感兴趣的论文带进当前会话',

  'search.placeholder': '输入关键词，如 graph neural networks',
  'search.button': '检索',
  'search.searching': '检索中…',
  'search.sources': '数据源',
  'search.empty': '输入关键词开始检索，结果来自免费开放文献 API。',
  'search.noResults': '没有找到匹配文献，试试更短的关键词或英文主题词。',
  'search.count': '共 {n} 篇',

  'source.openalex': 'OpenAlex',
  'source.crossref': 'Crossref',

  'result.citedBy': '被引 {n}',
  'result.openAccess': '开放获取',
  'result.expandAbstract': '展开摘要',
  'result.collapseAbstract': '收起摘要',
  'result.insert': '插入到对话',
  'result.inserted': '已插入到会话草稿',
  'result.pdf': 'PDF',

  'error.noEditor': '当前面板不在会话上下文中，无法插入到输入框',
  'error.draftChanged': '输入框草稿已变化，未插入；请避免在插入期间编辑草稿',
  'error.sourceFailed': '数据源 {source} 检索失败：{message}',

  'card.title': '文献检索设置',
  'card.desc': '配置免费文献 API 的请求参数，保存后即时生效',
  'group.network': '网络与数据源',
  'field.contactEmail': '联系邮箱',
  'field.contactEmailHint': '作为 OpenAlex / Crossref 的 polite pool 标识，可留空；填写后限流更宽松',
  'field.defaultLimit': '默认返回条数',
  'field.defaultLimitHint': '面板与模型工具默认返回条数，1–50，默认 20',
  'field.requestTimeoutMs': '请求超时（毫秒）',
  'field.requestTimeoutMsHint': '单次上游请求超时，默认 15000',

  'form.unavailable': '该插件当前未加载，暂时无法配置。',
  'form.readOnly': '本部署的设置为只读。',
  'form.saveFailed': '本部署没有接受这些值，已保留供你修改。',
  'form.save': '保存',
  'form.saving': '保存中…',
  'form.overridden': '已覆盖',
  'form.reset': '恢复默认',
  'form.invalidNumber': '请填数字；留空表示使用默认值。',
  'form.invalidText': '请填字符串；留空表示使用默认值。',

  'cmp.paper.header': '【文献｜{source}】{title}',
  'cmp.paper.authors': '作者：{value}',
  'cmp.paper.year': '年份：{value}',
  'cmp.paper.venue': '出处：{value}',
  'cmp.paper.doi': 'DOI：{value}',
  'cmp.paper.url': '链接：{value}',
  'cmp.paper.pdf': 'PDF：{value}',
  'cmp.paper.abstract': '摘要：{value}',
}

const en: Record<string, string> = {
  'tab.title': 'Literature Search',
  'guide.title': 'Literature Search',
  'guide.desc': 'Search free open scholarly literature and bring papers into this conversation',

  'search.placeholder': 'Enter keywords, e.g. graph neural networks',
  'search.button': 'Search',
  'search.searching': 'Searching…',
  'search.sources': 'Sources',
  'search.empty': 'Enter keywords to search free open literature APIs.',
  'search.noResults': 'No matching papers. Try shorter keywords or English subject terms.',
  'search.count': '{n} papers',

  'source.openalex': 'OpenAlex',
  'source.crossref': 'Crossref',

  'result.citedBy': 'Cited by {n}',
  'result.openAccess': 'Open access',
  'result.expandAbstract': 'Show abstract',
  'result.collapseAbstract': 'Hide abstract',
  'result.insert': 'Add to conversation',
  'result.inserted': 'Added to the conversation draft',
  'result.pdf': 'PDF',

  'error.noEditor': 'This panel is not in a conversation context; cannot insert into the composer',
  'error.draftChanged': 'The draft changed; nothing was inserted. Avoid editing while inserting.',
  'error.sourceFailed': 'Source {source} failed: {message}',

  'card.title': 'Literature search settings',
  'card.desc': 'Request parameters for the free literature APIs; changes take effect immediately',
  'group.network': 'Network and sources',
  'field.contactEmail': 'Contact email',
  'field.contactEmailHint': 'Used as the polite-pool identifier for OpenAlex / Crossref; optional, but it raises rate limits',
  'field.defaultLimit': 'Default result count',
  'field.defaultLimitHint': 'Default results for the panel and the model tool, 1–50, default 20',
  'field.requestTimeoutMs': 'Request timeout (ms)',
  'field.requestTimeoutMsHint': 'Timeout of one upstream request, default 15000',

  'form.unavailable': 'This plugin is not loaded, so it cannot be configured right now.',
  'form.readOnly': 'This deployment stores settings read-only.',
  'form.saveFailed': 'This deployment did not accept these values; they were kept for you to fix.',
  'form.save': 'Save',
  'form.saving': 'Saving…',
  'form.overridden': 'Overridden',
  'form.reset': 'Reset to default',
  'form.invalidNumber': 'Enter a number; leave blank to use the default.',
  'form.invalidText': 'Enter text; leave blank to use the default.',

  'cmp.paper.header': '[Literature | {source}] {title}',
  'cmp.paper.authors': 'Authors: {value}',
  'cmp.paper.year': 'Year: {value}',
  'cmp.paper.venue': 'Venue: {value}',
  'cmp.paper.doi': 'DOI: {value}',
  'cmp.paper.url': 'URL: {value}',
  'cmp.paper.pdf': 'PDF: {value}',
  'cmp.paper.abstract': 'Abstract: {value}',
}

export const dicts = { zh, en }
