/**
 * 设置页表单控制器。
 *
 * `scope` 由 `configForms.get(ROW_ID)` 提供；表单模型只在暂存区改动，由
 * 组件的防抖自动保存落盘（见 SettingsSection）。
 */

import {
  SettingsFormModel,
  settingsNumberField,
  settingsTextField,
  type SettingsActions,
  type SettingsFieldSpec,
  type SettingsFieldState,
  type SettingsFormState,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-ui-primitives'

import {
  SOURCE_IDS,
  TASK_LANGUAGES,
  TRANSLATE_ENGINES,
  TRANSLATE_TARGETS,
  type SourceId,
} from '../search/types'

/** 设置命名空间 id（= cordis.patch.yml 的 insert 行 id）。 */
export const ROW_ID = 'dsh-plugin-litsearch'

/** 可配置字段名，与 Host `Config` schema 一一对应。 */
export type FieldName =
  | 'contactEmail'
  | 'ncbiApiKey'
  | 'openalexApiKey'
  | 's2ApiKey'
  | 'serpApiKey'
  | 'pubmedIntervalMs'
  | 's2IntervalMs'
  | 'arxivIntervalMs'
  | 'defaultPageSize'
  | 'requestTimeoutMs'
  | 'defaultSources'
  | 'defaultSort'
  | 'defaultLanguage'
  | 'autoOpenTaskTab'
  | 'maxTaskTabs'
  | 'taskRetentionDays'
  | 'taskRetentionCount'
  | 'taskMaxPapers'
  | 'pdfRoot'
  | 'pdfMaxMb'
  | 'pdfCacheMaxMb'
  | 'autoDownloadPdf'
  | 'enableEpmcFulltext'
  | 'enablePmcFulltext'
  | 'pdfTimeoutMs'
  | 'pdfRetryCount'
  | 'pdfPerHostConcurrency'
  | 'enableOaLookup'
  | 'enableArxivHtml'
  | 'zoteroEnabled'
  | 'zoteroBaseUrl'
  | 'zoteroAttachPdf'
  | 'zoteroTag'
  | 'translateProvider'
  | 'translateTarget'

export const TEXT_FIELD = 'contactEmail' as const
export const NCBI_KEY_FIELD = 'ncbiApiKey' as const
export const OPENALEX_KEY_FIELD = 'openalexApiKey' as const
export const S2_KEY_FIELD = 's2ApiKey' as const
export const SERP_KEY_FIELD = 'serpApiKey' as const
export const SOURCES_FIELD: FieldName = 'defaultSources'
export const SORT_FIELD: FieldName = 'defaultSort'
export const LANGUAGE_FIELD: FieldName = 'defaultLanguage'
export const AUTO_OPEN_FIELD: FieldName = 'autoOpenTaskTab'
export const PDF_ROOT_FIELD: FieldName = 'pdfRoot'
export const AUTO_DOWNLOAD_FIELD: FieldName = 'autoDownloadPdf'
export const EPMC_FULLTEXT_FIELD: FieldName = 'enableEpmcFulltext'
export const PMC_FULLTEXT_FIELD: FieldName = 'enablePmcFulltext'
export const OA_LOOKUP_FIELD: FieldName = 'enableOaLookup'
export const ARXIV_HTML_FIELD: FieldName = 'enableArxivHtml'
export const ZOTERO_ENABLED_FIELD: FieldName = 'zoteroEnabled'
export const ZOTERO_BASE_URL_FIELD: FieldName = 'zoteroBaseUrl'
export const ZOTERO_ATTACH_FIELD: FieldName = 'zoteroAttachPdf'
export const ZOTERO_TAG_FIELD: FieldName = 'zoteroTag'
export const TRANSLATE_PROVIDER_FIELD: FieldName = 'translateProvider'
export const TRANSLATE_TARGET_FIELD: FieldName = 'translateTarget'

const NUMBER_FIELDS: readonly FieldName[] = [
  'defaultPageSize',
  'requestTimeoutMs',
  'pubmedIntervalMs',
  's2IntervalMs',
  'arxivIntervalMs',
  'maxTaskTabs',
  'taskRetentionDays',
  'taskRetentionCount',
  'taskMaxPapers',
  'pdfMaxMb',
  'pdfCacheMaxMb',
  'pdfTimeoutMs',
  'pdfRetryCount',
  'pdfPerHostConcurrency',
]

const TEXT_FIELDS: readonly FieldName[] = [
  TEXT_FIELD,
  PDF_ROOT_FIELD,
  ZOTERO_BASE_URL_FIELD,
  ZOTERO_TAG_FIELD,
]

const BOOLEAN_FIELDS: readonly FieldName[] = [
  AUTO_OPEN_FIELD,
  AUTO_DOWNLOAD_FIELD,
  EPMC_FULLTEXT_FIELD,
  PMC_FULLTEXT_FIELD,
  OA_LOOKUP_FIELD,
  ARXIV_HTML_FIELD,
  ZOTERO_ENABLED_FIELD,
  ZOTERO_ATTACH_FIELD,
]

export const SORT_MODES = ['relevance', 'citations', 'year'] as const
export const LANGUAGES = TASK_LANGUAGES
/** 翻译引擎候选；与 Host `TranslateEngine` 同步。 */
export const TRANSLATE_PROVIDERS = TRANSLATE_ENGINES
/** 目标语言候选；首项 `auto` = 按原文语种中英互译。 */
export const TRANSLATE_TARGET_OPTIONS = TRANSLATE_TARGETS

/** 布尔字段：表单只认文本，开关以 'true' / 'false' 暂存。 */
function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (value === true ? 'true' : 'false'),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed === 'true' || trimmed === 'false') return { kind: 'set', value: trimmed === 'true' }
      return undefined
    },
  }
}

/** 枚举字段：只接受白名单文本。 */
function enumField(field: string, allowed: readonly string[], fallback: string): SettingsFieldSpec {
  return {
    field,
    format: (value) =>
      typeof value === 'string' && allowed.includes(value) ? value : fallback,
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return allowed.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
    },
  }
}

/** 数据源数组字段：序列化成 JSON 文本；空数组表示回落到默认全部。 */
function sourcesField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => {
      const ids = Array.isArray(value)
        ? SOURCE_IDS.filter((id) => (value as unknown[]).includes(id))
        : []
      return JSON.stringify(ids)
    },
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
          return undefined
        }
        const ids = SOURCE_IDS.filter((id) => parsed.includes(id))
        return { kind: 'set', value: ids }
      } catch {
        return undefined
      }
    },
  }
}

/** 从字段文本解出当前选中的数据源（容错：非法文本回落到空数组）。 */
export function readSourceList(text: string): SourceId[] {
  try {
    const parsed: unknown = JSON.parse(text.trim() === '' ? '[]' : text)
    return Array.isArray(parsed)
      ? SOURCE_IDS.filter((id) => parsed.includes(id))
      : []
  } catch {
    return []
  }
}

/** 卡片快照：表单整体状态 + 逐字段状态。 */
export interface SettingsState extends SettingsFormState {
  contactEmail: SettingsFieldState
  ncbiApiKey: SettingsFieldState
  openalexApiKey: SettingsFieldState
  s2ApiKey: SettingsFieldState
  serpApiKey: SettingsFieldState
  pubmedIntervalMs: SettingsFieldState
  s2IntervalMs: SettingsFieldState
  arxivIntervalMs: SettingsFieldState
  defaultPageSize: SettingsFieldState
  requestTimeoutMs: SettingsFieldState
  defaultSources: SettingsFieldState
  defaultSort: SettingsFieldState
  defaultLanguage: SettingsFieldState
  autoOpenTaskTab: SettingsFieldState
  maxTaskTabs: SettingsFieldState
  taskRetentionDays: SettingsFieldState
  taskRetentionCount: SettingsFieldState
  taskMaxPapers: SettingsFieldState
  pdfRoot: SettingsFieldState
  pdfMaxMb: SettingsFieldState
  pdfCacheMaxMb: SettingsFieldState
  autoDownloadPdf: SettingsFieldState
  enableEpmcFulltext: SettingsFieldState
  enablePmcFulltext: SettingsFieldState
  pdfTimeoutMs: SettingsFieldState
  pdfRetryCount: SettingsFieldState
  pdfPerHostConcurrency: SettingsFieldState
  enableOaLookup: SettingsFieldState
  enableArxivHtml: SettingsFieldState
  zoteroEnabled: SettingsFieldState
  zoteroBaseUrl: SettingsFieldState
  zoteroAttachPdf: SettingsFieldState
  zoteroTag: SettingsFieldState
  translateProvider: SettingsFieldState
  translateTarget: SettingsFieldState
}

/** 席位注册时经 `inject()` 下发给组件的面。 */
export interface SettingsInjection extends SettingsActions {
  hooks: { litsearchSettings: SnapshotStore<SettingsState> }
}

export class LitsearchSettingsController {
  private readonly form: SettingsFormModel

  private readonly store: SnapshotStore<SettingsState>

  constructor(scope: unknown) {
    this.form = new SettingsFormModel(scope, [
      ...TEXT_FIELDS.map((field): SettingsFieldSpec => settingsTextField(field)),
      settingsTextField(NCBI_KEY_FIELD),
      settingsTextField(OPENALEX_KEY_FIELD),
      settingsTextField(S2_KEY_FIELD),
      settingsTextField(SERP_KEY_FIELD),
      ...NUMBER_FIELDS.map((field): SettingsFieldSpec => settingsNumberField(field)),
      sourcesField(SOURCES_FIELD),
      enumField(SORT_FIELD, SORT_MODES, 'relevance'),
      enumField(LANGUAGE_FIELD, LANGUAGES, 'any'),
      enumField(TRANSLATE_PROVIDER_FIELD, TRANSLATE_PROVIDERS, 'bing'),
      enumField(TRANSLATE_TARGET_FIELD, TRANSLATE_TARGET_OPTIONS, 'auto'),
      ...BOOLEAN_FIELDS.map((field): SettingsFieldSpec => booleanField(field)),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): SettingsState {
    return {
      ...this.form.shell(),
      contactEmail: this.form.field('contactEmail'),
      ncbiApiKey: this.form.field(NCBI_KEY_FIELD),
      openalexApiKey: this.form.field(OPENALEX_KEY_FIELD),
      s2ApiKey: this.form.field(S2_KEY_FIELD),
      serpApiKey: this.form.field(SERP_KEY_FIELD),
      pubmedIntervalMs: this.form.field('pubmedIntervalMs'),
      s2IntervalMs: this.form.field('s2IntervalMs'),
      arxivIntervalMs: this.form.field('arxivIntervalMs'),
      defaultPageSize: this.form.field('defaultPageSize'),
      requestTimeoutMs: this.form.field('requestTimeoutMs'),
      defaultSources: this.form.field(SOURCES_FIELD),
      defaultSort: this.form.field(SORT_FIELD),
      defaultLanguage: this.form.field(LANGUAGE_FIELD),
      autoOpenTaskTab: this.form.field(AUTO_OPEN_FIELD),
      maxTaskTabs: this.form.field('maxTaskTabs'),
      taskRetentionDays: this.form.field('taskRetentionDays'),
      taskRetentionCount: this.form.field('taskRetentionCount'),
      taskMaxPapers: this.form.field('taskMaxPapers'),
      pdfRoot: this.form.field(PDF_ROOT_FIELD),
      pdfMaxMb: this.form.field('pdfMaxMb'),
      pdfCacheMaxMb: this.form.field('pdfCacheMaxMb'),
      autoDownloadPdf: this.form.field(AUTO_DOWNLOAD_FIELD),
      enableEpmcFulltext: this.form.field(EPMC_FULLTEXT_FIELD),
      enablePmcFulltext: this.form.field(PMC_FULLTEXT_FIELD),
      pdfTimeoutMs: this.form.field('pdfTimeoutMs'),
      pdfRetryCount: this.form.field('pdfRetryCount'),
      pdfPerHostConcurrency: this.form.field('pdfPerHostConcurrency'),
      enableOaLookup: this.form.field(OA_LOOKUP_FIELD),
      enableArxivHtml: this.form.field(ARXIV_HTML_FIELD),
      zoteroEnabled: this.form.field(ZOTERO_ENABLED_FIELD),
      zoteroBaseUrl: this.form.field(ZOTERO_BASE_URL_FIELD),
      zoteroAttachPdf: this.form.field(ZOTERO_ATTACH_FIELD),
      zoteroTag: this.form.field(ZOTERO_TAG_FIELD),
      translateProvider: this.form.field(TRANSLATE_PROVIDER_FIELD),
      translateTarget: this.form.field(TRANSLATE_TARGET_FIELD),
    }
  }

  inject(): SettingsInjection {
    return { hooks: { litsearchSettings: this.store }, ...this.form.actions() }
  }

  dispose(): void {
    this.form.dispose()
  }
}
