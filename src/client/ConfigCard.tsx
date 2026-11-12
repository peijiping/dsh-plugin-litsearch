/**
 * 插件页配置卡（浏览器半）。
 *
 * 把 Host 导出的 volatile `Config` 表单渲染进插件页的 `plugins.row.config`
 * 席位：控制器持 `SettingsFormModel`，组件经注入的 hook 读快照。
 *
 * 席位 key 由 plugin-manager 的 `rowConfigKey(bundle, rowId)` 决定，因此
 * {@link ROW_CONFIG_KEY} 必须与 `cordis.patch.yml` 的行 id 保持同步。
 */

import type { ReactElement } from 'react'

import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  settingsNumberField,
  settingsTextField,
  type SettingsActions,
  type SettingsFieldSpec,
  type SettingsFieldState,
  type SettingsFormState,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { Translate } from './locales'

/** 插件页的行 id / settings 命名空间（= cordis.patch.yml 的 insert 行 id）。 */
export const ROW_ID = 'dsh-plugin-litsearch'

/** `plugins.row.config` 席位的 key（= `<包名>#<行 id>`）。 */
export const ROW_CONFIG_KEY = `${ROW_ID}#${ROW_ID}`

/** 可配置字段名，与 Host `Config` schema 一一对应。 */
type FieldName = 'contactEmail' | 'defaultLimit' | 'requestTimeoutMs'

interface FieldMeta {
  name: FieldName
  /** 数值字段走 `settingsNumberField`（`numeric` 只提示数字键盘）。 */
  numeric: boolean
}

const FIELDS: readonly FieldMeta[] = [
  { name: 'contactEmail', numeric: false },
  { name: 'requestTimeoutMs', numeric: true },
  { name: 'defaultLimit', numeric: true },
]

/** 卡片快照：表单整体状态 + 逐字段状态。 */
interface CardState extends SettingsFormState {
  contactEmail: SettingsFieldState
  defaultLimit: SettingsFieldState
  requestTimeoutMs: SettingsFieldState
}

/** 席位注册时经 `inject()` 下发给组件的面。 */
interface CardInjection extends SettingsActions {
  hooks: { litsearchCard: SnapshotStore<CardState> }
}

/** 组件收到的 props：席位标准 props + 注入面 + 本卡字典。 */
interface CardProps {
  view: 'summary' | 'page'
  t: Translate
  useLitsearchCard: <T>(selector: (state: CardState) => T) => T
  save(): void
  discard(): void
  edit(field: string, text: string): void
  resetField(field: string): void
}

/**
 * 一张卡片的暂存表单模型：只在保存时写入，离开页面时丢弃草稿。
 * `scope` 由 `configForms.get(ROW_ID)` 提供（本条的共享配置表单）。
 */
export class LitsearchCardController {
  private readonly form: SettingsFormModel

  private readonly store: SnapshotStore<CardState>

  constructor(scope: unknown) {
    this.form = new SettingsFormModel(
      scope,
      FIELDS.map((field): SettingsFieldSpec =>
        field.numeric ? settingsNumberField(field.name) : settingsTextField(field.name),
      ),
    )
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): CardState {
    return {
      ...this.form.shell(),
      contactEmail: this.form.field('contactEmail'),
      defaultLimit: this.form.field('defaultLimit'),
      requestTimeoutMs: this.form.field('requestTimeoutMs'),
    }
  }

  /** 席位注册的注入面：hook + 表单动作。 */
  inject(): CardInjection {
    return { hooks: { litsearchCard: this.store }, ...this.form.actions() }
  }

  /** 释放表单订阅。 */
  dispose(): void {
    this.form.dispose()
  }
}

const GROUP_STYLE = { marginTop: 4 }
const GROUP_HEAD_STYLE = { fontSize: 13, fontWeight: 650, opacity: 0.85, margin: '0 0 6px' }

/** 行摘要返回一句话；行「配置」页返回完整表单。 */
export function ConfigCard(props: CardProps): ReactElement | string {
  const { t } = props
  const state = props.useLitsearchCard((snapshot) => snapshot)

  if (props.view === 'summary') return t('card.desc')

  const locked = !state.writable

  const renderField = (field: FieldMeta): ReactElement => (
    <SettingsValueField
      key={field.name}
      id={`plugin-config-litsearch-${field.name}`}
      label={t(`field.${field.name}`)}
      hint={t(`field.${field.name}Hint`)}
      overriddenLabel={t('form.overridden')}
      resetLabel={t('form.reset')}
      invalidLabel={t(field.numeric ? 'form.invalidNumber' : 'form.invalidText')}
      numeric={field.numeric}
      disabled={locked}
      {...state[field.name]}
      onEdit={(text) => props.edit(field.name, text)}
      onReset={() => props.resetField(field.name)}
    />
  )

  return (
    <SettingsForm
      labels={{
        unavailable: t('form.unavailable'),
        readOnly: t('form.readOnly'),
        saveFailed: t('form.saveFailed'),
        save: t('form.save'),
        saving: t('form.saving'),
      }}
      state={state}
      onSave={() => props.save()}
      onDiscard={() => props.discard()}
    >
      <section style={GROUP_STYLE}>
        <h4 style={GROUP_HEAD_STYLE}>{t('group.network')}</h4>
        {FIELDS.map(renderField)}
      </section>
    </SettingsForm>
  )
}
