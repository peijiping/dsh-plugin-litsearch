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

import { SOURCE_IDS, type SourceId } from '../search/types'

/** 设置命名空间 id（= cordis.patch.yml 的 insert 行 id）。 */
export const ROW_ID = 'dsh-plugin-litsearch'

/** 可配置字段名，与 Host `Config` schema 一一对应。 */
export type FieldName =
  | 'contactEmail'
  | 'ncbiApiKey'
  | 's2ApiKey'
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

export const TEXT_FIELD = 'contactEmail' as const
export const NCBI_KEY_FIELD = 'ncbiApiKey' as const
export const S2_KEY_FIELD = 's2ApiKey' as const
export const SOURCES_FIELD: FieldName = 'defaultSources'
export const SORT_FIELD: FieldName = 'defaultSort'
export const LANGUAGE_FIELD: FieldName = 'defaultLanguage'
export const AUTO_OPEN_FIELD: FieldName = 'autoOpenTaskTab'

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
]

export const SORT_MODES = ['relevance', 'citations', 'year'] as const
export const LANGUAGES = ['any', 'eng', 'chi'] as const

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
  s2ApiKey: SettingsFieldState
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
      settingsTextField(TEXT_FIELD),
      settingsTextField(NCBI_KEY_FIELD),
      settingsTextField(S2_KEY_FIELD),
      ...NUMBER_FIELDS.map((field): SettingsFieldSpec => settingsNumberField(field)),
      sourcesField(SOURCES_FIELD),
      enumField(SORT_FIELD, SORT_MODES, 'relevance'),
      enumField(LANGUAGE_FIELD, LANGUAGES, 'any'),
      booleanField(AUTO_OPEN_FIELD),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): SettingsState {
    return {
      ...this.form.shell(),
      contactEmail: this.form.field('contactEmail'),
      ncbiApiKey: this.form.field(NCBI_KEY_FIELD),
      s2ApiKey: this.form.field(S2_KEY_FIELD),
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
    }
  }

  inject(): SettingsInjection {
    return { hooks: { litsearchSettings: this.store }, ...this.form.actions() }
  }

  dispose(): void {
    this.form.dispose()
  }
}
