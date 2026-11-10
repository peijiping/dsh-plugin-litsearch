/**
 * 「设置」对话框里的「文献检索」页。
 *
 * 没有保存按钮：字段改完停手 600ms 自动落盘；离开页面时把合法草稿立刻冲掉、
 * 非法草稿直接丢弃（与 dsh-plugin-zotero 的设置页同一套交互）。
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import {
  Pill,
  SettingsValueField,
  Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'

import { SOURCE_IDS, type ProbeResult, type SourceId } from '../search/types'
import { probeSource } from './api'
import { getHealth, refreshHealth, useHealth } from './health'
import { tpl, type Translate } from './locales'
import {
  AUTO_OPEN_FIELD,
  LANGUAGE_FIELD,
  LANGUAGES,
  NCBI_KEY_FIELD,
  S2_KEY_FIELD,
  SOURCES_FIELD,
  SORT_FIELD,
  SORT_MODES,
  TEXT_FIELD,
  readSourceList,
  type SettingsState,
} from './SettingsController'

/** 自动保存的静默窗口（毫秒）。 */
const AUTOSAVE_DELAY_MS = 600

const NUMBER_FIELD_NAMES = [
  'defaultPageSize',
  'requestTimeoutMs',
  'pubmedIntervalMs',
  's2IntervalMs',
  'arxivIntervalMs',
  'maxTaskTabs',
  'taskRetentionDays',
  'taskRetentionCount',
  'taskMaxPapers',
] as const

type NumberFieldName = (typeof NUMBER_FIELD_NAMES)[number]

interface Props {
  t: Translate
  useLitsearchSettings: <T>(selector: (state: SettingsState) => T) => T
  save(): void
  discard(): void
  edit(field: string, text: string): void
  resetField(field: string): void
}

const NUMBER_FIELDS: readonly NumberFieldName[] = [...NUMBER_FIELD_NAMES]

export function SettingsSection(props: Props): ReactElement {
  const { t } = props
  const state = props.useLitsearchSettings((snapshot) => snapshot)
  const health = useHealth()

  useEffect(() => {
    if (getHealth() === null) void refreshHealth()
  }, [])

  const locked = !state.writable

  /** 草稿指纹：任何字段改动都换字符串，防抖计时器才会重启。 */
  const draftKey = [
    state.contactEmail.text,
    state.ncbiApiKey.text,
    state.s2ApiKey.text,
    state.defaultPageSize.text,
    state.requestTimeoutMs.text,
    state.pubmedIntervalMs.text,
    state.s2IntervalMs.text,
    state.arxivIntervalMs.text,
    state.defaultSources.text,
    state.defaultSort.text,
    state.defaultLanguage.text,
    state.autoOpenTaskTab.text,
    state.maxTaskTabs.text,
    state.taskRetentionDays.text,
    state.taskRetentionCount.text,
    state.taskMaxPapers.text,
  ].join('\u0000')

  useEffect(() => {
    if (!state.dirty || state.invalid || state.saving || state.failed) return
    const timer = setTimeout(() => {
      props.save()
    }, AUTOSAVE_DELAY_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [draftKey, state.dirty, state.invalid, state.saving, state.failed])

  /** 离开页面：合法草稿立即冲盘，非法草稿丢弃。 */
  const pendingRef = useRef({ dirty: false, invalid: false, save: () => {}, discard: () => {} })
  useEffect(() => {
    pendingRef.current = {
      dirty: state.dirty,
      invalid: state.invalid,
      save: () => {
        props.save()
      },
      discard: () => {
        props.discard()
      },
    }
  }, [draftKey, state.dirty, state.invalid])
  useEffect(
    () => () => {
      const pending = pendingRef.current
      if (!pending.dirty) return
      if (pending.invalid) pending.discard()
      else pending.save()
    },
    [],
  )

  if (!state.available) return <p style={NOTICE_STYLE}>{t('form.unavailable')}</p>

  const selectedSources =
    state.defaultSources.text.trim() === ''
      ? [...SOURCE_IDS]
      : readSourceList(state.defaultSources.text)
  const sort = state.defaultSort.text === '' ? 'relevance' : state.defaultSort.text
  const language = state.defaultLanguage.text === '' ? 'any' : state.defaultLanguage.text

  const toggleSource = (id: (typeof SOURCE_IDS)[number]): void => {
    const next = selectedSources.includes(id)
      ? selectedSources.filter((source) => source !== id)
      : [...selectedSources, id]
    if (next.length === 0) return
    props.edit(SOURCES_FIELD, JSON.stringify(SOURCE_IDS.filter((source) => next.includes(source))))
  }

  const renderNumberField = (name: NumberFieldName): ReactElement => (
    <SettingsValueField
      key={name}
      id={`plugin-config-litsearch-${name}`}
      label={t(`field.${name}`)}
      hint={t(`field.${name}Hint`)}
      overriddenLabel={t('form.overridden')}
      resetLabel={t('form.reset')}
      invalidLabel={t('form.invalidNumber')}
      numeric
      disabled={locked}
      {...state[name]}
      onEdit={(text) => props.edit(name, text)}
      onReset={() => props.resetField(name)}
    />
  )

  const renderText = (name: 'contactEmail'): ReactElement => (
    <SettingsValueField
      id={`plugin-config-litsearch-${name}`}
      label={t(`field.${name}`)}
      hint={t(`field.${name}Hint`)}
      overriddenLabel={t('form.overridden')}
      resetLabel={t('form.reset')}
      invalidLabel={t('form.invalidText')}
      disabled={locked}
      {...state[name]}
      onEdit={(text) => props.edit(name, text)}
      onReset={() => props.resetField(name)}
    />
  )

  return (
    <div style={FORM_STYLE}>
      {state.writable ? null : <p style={NOTICE_STYLE}>{t('form.readOnly')}</p>}
      <div style={HINT_STYLE}>{t('settings.hint')}</div>
      {state.failed && <p style={SAVE_FAILED_STYLE}>{t('form.autosaveFailed')}</p>}
      {!state.failed && state.saving && <p style={SAVE_STATUS_STYLE}>{t('form.autosaving')}</p>}

      <section style={GROUP_STYLE}>
        <h4 style={GROUP_HEAD_STYLE}>{t('group.defaults')}</h4>

        <div style={CHOICE_ROW_STYLE}>
          <span style={CHOICE_LABEL_STYLE}>{t('field.defaultSources')}</span>
          <span style={CHOICE_HINT_STYLE}>{t('field.defaultSourcesHint')}</span>
          <div style={PILL_ROW_STYLE}>
            {SOURCE_IDS.map((id) => (
              <Pill
                key={id}
                type="button"
                active={selectedSources.includes(id)}
                aria-pressed={selectedSources.includes(id)}
                disabled={locked}
                onClick={() => toggleSource(id)}
              >
                {t(`source.${id}`)}
              </Pill>
            ))}
          </div>
        </div>

        {renderNumberField('defaultPageSize')}

        <div style={CHOICE_ROW_STYLE}>
          <span style={CHOICE_LABEL_STYLE}>{t('field.defaultSort')}</span>
          <span style={CHOICE_HINT_STYLE}>{t('field.defaultSortHint')}</span>
          <div style={PILL_ROW_STYLE}>
            {SORT_MODES.map((mode) => (
              <Pill
                key={mode}
                type="button"
                active={sort === mode}
                aria-pressed={sort === mode}
                disabled={locked}
                onClick={() => props.edit(SORT_FIELD, mode)}
              >
                {t(`sort.${mode}`)}
              </Pill>
            ))}
          </div>
        </div>

        <div style={CHOICE_ROW_STYLE}>
          <span style={CHOICE_LABEL_STYLE}>{t('field.defaultLanguage')}</span>
          <span style={CHOICE_HINT_STYLE}>{t('field.defaultLanguageHint')}</span>
          <div style={PILL_ROW_STYLE}>
            {LANGUAGES.map((value) => (
              <Pill
                key={value}
                type="button"
                active={language === value}
                aria-pressed={language === value}
                disabled={locked}
                onClick={() => props.edit(LANGUAGE_FIELD, value)}
              >
                {t(`lang.${value}`)}
              </Pill>
            ))}
          </div>
        </div>
      </section>

      <section style={GROUP_STYLE}>
        <h4 style={GROUP_HEAD_STYLE}>{t('group.network')}</h4>
        {renderText(TEXT_FIELD)}
        {renderNumberField('requestTimeoutMs')}
      </section>

      <section style={GROUP_STYLE}>
        <h4 style={GROUP_HEAD_STYLE}>{t('group.sources')}</h4>
        <div style={HINT_STYLE}>{t('group.sourcesHint')}</div>

        <SecretField
          t={t}
          id="plugin-config-litsearch-ncbiApiKey"
          label={t('field.ncbiApiKey')}
          hint={t('field.ncbiApiKeyHint')}
          configured={state.ncbiApiKey.text.trim() !== ''}
          disabled={locked}
          onEdit={(value) => props.edit(NCBI_KEY_FIELD, value)}
          onClear={() => props.edit(NCBI_KEY_FIELD, '')}
        />
        <SecretField
          t={t}
          id="plugin-config-litsearch-s2ApiKey"
          label={t('field.s2ApiKey')}
          hint={t('field.s2ApiKeyHint')}
          configured={state.s2ApiKey.text.trim() !== ''}
          disabled={locked}
          onEdit={(value) => props.edit(S2_KEY_FIELD, value)}
          onClear={() => props.edit(S2_KEY_FIELD, '')}
        />

        {renderNumberField('pubmedIntervalMs')}
        {renderNumberField('s2IntervalMs')}
        {renderNumberField('arxivIntervalMs')}
      </section>

      <section style={GROUP_STYLE}>
        <h4 style={GROUP_HEAD_STYLE}>{t('group.diagnostics')}</h4>
        <Diagnostics t={t} keys={health?.keys} health={health?.sourceHealth ?? []} />
      </section>

      <section style={GROUP_STYLE}>
        <h4 style={GROUP_HEAD_STYLE}>{t('group.tasks')}</h4>

        <div style={CHOICE_ROW_STYLE}>
          <div style={TOGGLE_INFO_STYLE}>
            <span style={CHOICE_LABEL_STYLE}>{t('field.autoOpenTaskTab')}</span>
            <span style={CHOICE_HINT_STYLE}>{t('field.autoOpenTaskTabHint')}</span>
          </div>
          <Switch
            checked={state.autoOpenTaskTab.text === 'true'}
            disabled={locked}
            label={t('field.autoOpenTaskTab')}
            title={
              state.autoOpenTaskTab.text === 'true' ? t('settings.on') : t('settings.off')
            }
            onChange={(next) => props.edit(AUTO_OPEN_FIELD, next ? 'true' : 'false')}
          />
        </div>

        {NUMBER_FIELDS.filter(
          (name) =>
            name !== 'defaultPageSize' &&
            name !== 'requestTimeoutMs' &&
            name !== 'pubmedIntervalMs' &&
            name !== 's2IntervalMs' &&
            name !== 'arxivIntervalMs',
        ).map(renderNumberField)}

        <div style={STORAGE_ROW_STYLE}>
          <span style={CHOICE_LABEL_STYLE}>{t('field.storageDir')}</span>
          <code style={STORAGE_PATH_STYLE}>{health?.storageDir ?? '—'}</code>
          <span style={CHOICE_HINT_STYLE}>{t('field.storageDirHint')}</span>
        </div>
      </section>
    </div>
  )
}

interface SecretFieldProps {
  t: Translate
  id: string
  label: string
  hint: string
  configured: boolean
  disabled: boolean
  onEdit(value: string): void
  onClear(): void
}

/** 密钥输入：只显示「已配置/未配置」，从不回显当前值。 */
function SecretField({
  t,
  id,
  label,
  hint,
  configured,
  disabled,
  onEdit,
  onClear,
}: SecretFieldProps): ReactElement {
  const [draft, setDraft] = useState('')

  const commit = (): void => {
    const value = draft.trim()
    if (value === '' || disabled) return
    onEdit(value)
    setDraft('')
  }

  return (
    <div style={CHOICE_ROW_STYLE}>
      <label style={CHOICE_LABEL_STYLE} htmlFor={id}>
        {label}
      </label>
      <span style={CHOICE_HINT_STYLE}>{hint}</span>
      <div style={INLINE_ROW_STYLE}>
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          style={{ ...SECRET_INPUT_STYLE, flex: 1 }}
          value={draft}
          disabled={disabled}
          placeholder={
            configured ? t('field.keyConfigured') : t('field.keyEmpty')
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
        />
        <button
          type="button"
          style={SMALL_BUTTON_STYLE}
          disabled={disabled || draft.trim() === ''}
          onClick={commit}
        >
          {t('field.keySave')}
        </button>
        {configured && (
          <button
            type="button"
            style={SMALL_BUTTON_STYLE}
            disabled={disabled}
            onClick={onClear}
          >
            {t('field.keyClear')}
          </button>
        )}
      </div>
    </div>
  )
}

interface DiagnosticsProps {
  t: Translate
  keys: { ncbi: boolean; s2: boolean } | undefined
  health: readonly { id: SourceId; lastOkAt?: string; lastError?: string; lastLatencyMs?: number; cooldownUntil?: string }[]
}

/** 逐源诊断：显示运行时健康状态，并可手动探活一次（不受冷却影响）。 */
function Diagnostics({ t, keys, health }: DiagnosticsProps): ReactElement {
  const [results, setResults] = useState<Record<string, { busy: boolean; text: string }>>({})
  const byId = new Map(health.map((entry) => [entry.id, entry]))

  const run = (source: SourceId): void => {
    setResults((previous) => ({
      ...previous,
      [source]: { busy: true, text: previous[source]?.text ?? '' },
    }))
    void probeSource(source)
      .then((result) => {
        setResults((previous) => ({
          ...previous,
          [source]: { busy: false, text: probeText(t, result) },
        }))
        void refreshHealth()
      })
      .catch((error: unknown) => {
        setResults((previous) => ({
          ...previous,
          [source]: {
            busy: false,
            text: tpl(t('diagnostics.fail'), {
              message: error instanceof Error ? error.message : String(error),
            }),
          },
        }))
      })
  }

  return (
    <div>
      <div style={HINT_STYLE}>
        {keys === undefined
          ? t('diagnostics.loading')
          : tpl(t('diagnostics.keys'), {
              ncbi: keys.ncbi ? t('diagnostics.configured') : t('diagnostics.notConfigured'),
              s2: keys.s2 ? t('diagnostics.configured') : t('diagnostics.notConfigured'),
            })}
      </div>
      {SOURCE_IDS.map((id) => {
        const entry = byId.get(id)
        const result = results[id]
        return (
          <div key={id} style={DIAG_ROW_STYLE}>
            <div style={DIAG_INFO_STYLE}>
              <span style={CHOICE_LABEL_STYLE}>{t(`source.${id}`)}</span>
              <span style={CHOICE_HINT_STYLE}>{healthText(t, entry)}</span>
              {result !== undefined && result.text !== '' && (
                <span style={result.busy ? CHOICE_HINT_STYLE : RESULT_STYLE}>{result.text}</span>
              )}
            </div>
            <button
              type="button"
              style={SMALL_BUTTON_STYLE}
              disabled={result?.busy === true}
              onClick={() => run(id)}
            >
              {result?.busy === true ? t('diagnostics.testing') : t('diagnostics.test')}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function probeText(t: Translate, result: ProbeResult): string {
  const base = result.ok
    ? tpl(t('diagnostics.ok'), { ms: result.latencyMs, count: result.count })
    : tpl(t('diagnostics.fail'), { message: result.error ?? '' })
  if (result.cooldownUntil === undefined) return base
  return `${base} ${tpl(t('diagnostics.cooldown'), { time: formatTime(result.cooldownUntil) })}`
}

function healthText(
  t: Translate,
  entry: { lastOkAt?: string; lastError?: string; lastLatencyMs?: number; cooldownUntil?: string } | undefined,
): string {
  if (entry === undefined) return t('diagnostics.unknown')
  if (entry.cooldownUntil !== undefined) {
    return tpl(t('diagnostics.cooldown'), { time: formatTime(entry.cooldownUntil) })
  }
  if (entry.lastError !== undefined) {
    return tpl(t('diagnostics.lastError'), { message: entry.lastError })
  }
  if (entry.lastOkAt !== undefined) {
    return tpl(t('diagnostics.lastOk'), { ms: entry.lastLatencyMs ?? 0 })
  }
  return t('diagnostics.unknown')
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString()
}

const FORM_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', paddingBottom: 8 }
const NOTICE_STYLE: CSSProperties = {
  margin: '0 0 12px',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9))',
}
const HINT_STYLE: CSSProperties = { fontSize: 12, opacity: 0.72, marginBottom: 10 }
const SAVE_STATUS_STYLE: CSSProperties = {
  margin: '0 0 8px',
  fontSize: 12,
  lineHeight: 1.5,
  opacity: 0.72,
}
const SAVE_FAILED_STYLE: CSSProperties = {
  ...SAVE_STATUS_STYLE,
  opacity: 1,
  color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error, #b3261e))',
}
const GROUP_STYLE: CSSProperties = { marginTop: 4 }
const GROUP_HEAD_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  opacity: 0.72,
  margin: '0 0 6px',
}
const CHOICE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '6px 0',
  borderBottom: '1px solid rgba(127,127,127,0.12)',
}
const CHOICE_LABEL_STYLE: CSSProperties = { fontSize: 12, fontWeight: 600 }
const CHOICE_HINT_STYLE: CSSProperties = { fontSize: 11, opacity: 0.66, lineHeight: 1.5 }
const PILL_ROW_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }
const TOGGLE_INFO_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
}
const STORAGE_ROW_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 0' }
const STORAGE_PATH_STYLE: CSSProperties = {
  fontSize: 11,
  wordBreak: 'break-all',
  opacity: 0.8,
  background: 'rgba(127,127,127,0.1)',
  padding: '4px 6px',
  borderRadius: 4,
}
const INLINE_ROW_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
const SECRET_INPUT_STYLE: CSSProperties = {
  fontSize: 12,
  padding: '4px 6px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
  minWidth: 0,
}
const SMALL_BUTTON_STYLE: CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.3)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const DIAG_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '5px 0',
  borderBottom: '1px solid rgba(127,127,127,0.12)',
}
const DIAG_INFO_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  minWidth: 0,
}
const RESULT_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: '#508cff',
}
