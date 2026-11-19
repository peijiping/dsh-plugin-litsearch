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
import { cleanupSettings, probeSource, probeStorage, probeZotero } from './api'
import { getHealth, refreshHealth, useHealth } from './health'
import { tpl, type Translate } from './locales'
import { linkStyle } from './styles'
import {
  ARXIV_HTML_FIELD,
  AUTO_DOWNLOAD_FIELD,
  AUTO_OPEN_FIELD,
  EPMC_FULLTEXT_FIELD,
  LANGUAGE_FIELD,
  LANGUAGES,
  NCBI_KEY_FIELD,
  OA_LOOKUP_FIELD,
  OPENALEX_KEY_FIELD,
  PDF_ROOT_FIELD,
  PMC_FULLTEXT_FIELD,
  S2_KEY_FIELD,
  SERP_KEY_FIELD,
  SOURCES_FIELD,
  SORT_FIELD,
  SORT_MODES,
  TEXT_FIELD,
  TRANSLATE_PROVIDER_FIELD,
  TRANSLATE_PROVIDERS,
  TRANSLATE_TARGET_FIELD,
  TRANSLATE_TARGET_OPTIONS,
  ZOTERO_ATTACH_FIELD,
  ZOTERO_BASE_URL_FIELD,
  ZOTERO_ENABLED_FIELD,
  ZOTERO_TAG_FIELD,
  readSourceList,
  type FieldName,
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
  'pdfMaxMb',
  'pdfCacheMaxMb',
  'pdfTimeoutMs',
  'pdfRetryCount',
  'pdfPerHostConcurrency',
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
    state.openalexApiKey.text,
    state.s2ApiKey.text,
    state.serpApiKey.text,
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
    state.pdfRoot.text,
    state.pdfMaxMb.text,
    state.pdfCacheMaxMb.text,
    state.autoDownloadPdf.text,
    state.enableEpmcFulltext.text,
    state.enableOaLookup.text,
    state.enableArxivHtml.text,
    state.pdfTimeoutMs.text,
    state.pdfRetryCount.text,
    state.pdfPerHostConcurrency.text,
    state.zoteroEnabled.text,
    state.zoteroBaseUrl.text,
    state.zoteroAttachPdf.text,
    state.zoteroTag.text,
    state.translateProvider.text,
    state.translateTarget.text,
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
      ? SOURCE_IDS.filter((id) => id !== 'googlescholar')
      : readSourceList(state.defaultSources.text)
  const sort = state.defaultSort.text === '' ? 'relevance' : state.defaultSort.text
  const language = state.defaultLanguage.text === '' ? 'any' : state.defaultLanguage.text
  const translateProvider =
    state.translateProvider.text === '' ? 'bing' : state.translateProvider.text
  const translateTarget = state.translateTarget.text === '' ? 'auto' : state.translateTarget.text

  /** 逐来源运行时健康状态，供来源分组内的探活行展示。 */
  const healthById = new Map((health?.sourceHealth ?? []).map((entry) => [entry.id, entry]))

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

  const renderText = (name: FieldName): ReactElement => (
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

  const renderToggle = (name: FieldName): ReactElement => {
    const on = state[name].text === 'true'
    return (
      <div style={CHOICE_ROW_STYLE} key={name}>
        <div style={TOGGLE_INFO_STYLE}>
          <span style={CHOICE_LABEL_STYLE}>{t(`field.${name}`)}</span>
          <span style={CHOICE_HINT_STYLE}>{t(`field.${name}Hint`)}</span>
        </div>
        <Switch
          checked={on}
          disabled={locked}
          label={t(`field.${name}`)}
          title={on ? t('settings.on') : t('settings.off')}
          onChange={(next) => props.edit(name, next ? 'true' : 'false')}
        />
      </div>
    )
  }

  return (
    <div style={FORM_STYLE}>
      {state.writable ? null : <p style={NOTICE_STYLE}>{t('form.readOnly')}</p>}
      <div style={HINT_STYLE}>{t('settings.hint')}</div>
      {state.failed && <p style={SAVE_FAILED_STYLE}>{t('form.autosaveFailed')}</p>}
      {!state.failed && state.saving && <p style={SAVE_STATUS_STYLE}>{t('form.autosaving')}</p>}

      <section style={GROUP_STYLE}>
        <GroupHead title={t('group.searchSources')} />
        <div style={HINT_STYLE}>{t('settings.sourcesHint')}</div>
        {SOURCE_IDS.map((id) => {
          const on = selectedSources.includes(id)
          const needsKey = id === 'googlescholar' && state.serpApiKey.text.trim() === ''
          return (
            <section key={id} style={SOURCE_BOX_STYLE}>
              <div style={SOURCE_HEAD_STYLE}>
                <div style={TOGGLE_INFO_STYLE}>
                  <span style={CHOICE_LABEL_STYLE}>{t(`source.${id}`)}</span>
                  <span style={CHOICE_HINT_STYLE}>{t(`source.${id}.desc`)}</span>
                </div>
                <Switch
                  checked={on && !needsKey}
                  disabled={locked || needsKey}
                  label={t(`source.${id}`)}
                  title={
                    needsKey
                      ? t('settings.sourceNeedsKey')
                      : on
                        ? t('settings.on')
                        : t('settings.off')
                  }
                  onChange={() => toggleSource(id)}
                />
              </div>
              <div style={SOURCE_BODY_STYLE}>
                {id === 'pubmed' && (
                  <>
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
                    {renderNumberField('pubmedIntervalMs')}
                    {renderToggle(PMC_FULLTEXT_FIELD)}
                    <div style={CHOICE_HINT_STYLE}>
                      <a
                        style={linkStyle}
                        href="https://www.ncbi.nlm.nih.gov/About/disclaimer.html"
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {t('source.pubmed.disclaimer')}
                      </a>
                    </div>
                  </>
                )}
                {id === 'openalex' && (
                  <SecretField
                    t={t}
                    id="plugin-config-litsearch-openalexApiKey"
                    label={t('field.openalexApiKey')}
                    hint={t('field.openalexApiKeyHint')}
                    configured={state.openalexApiKey.text.trim() !== ''}
                    disabled={locked}
                    onEdit={(value) => props.edit(OPENALEX_KEY_FIELD, value)}
                    onClear={() => props.edit(OPENALEX_KEY_FIELD, '')}
                  />
                )}
                {id === 'europepmc' && renderToggle(EPMC_FULLTEXT_FIELD)}
                {id === 'semanticscholar' && (
                  <>
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
                    {renderNumberField('s2IntervalMs')}
                  </>
                )}
                {id === 'arxiv' && renderNumberField('arxivIntervalMs')}
                {id === 'googlescholar' && (
                  <SecretField
                    t={t}
                    id="plugin-config-litsearch-serpApiKey"
                    label={t('field.serpApiKey')}
                    hint={t('field.serpApiKeyHint')}
                    configured={state.serpApiKey.text.trim() !== ''}
                    disabled={locked}
                    onEdit={(value) => props.edit(SERP_KEY_FIELD, value)}
                    onClear={() => props.edit(SERP_KEY_FIELD, '')}
                  />
                )}
              </div>
              <SourceProbeRow t={t} id={id} entry={healthById.get(id)} />
            </section>
          )
        })}
      </section>

      <section style={GROUP_STYLE}>
        <GroupHead title={t('group.defaults')} />

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
        <GroupHead title={t('group.translate')} />
        <div style={HINT_STYLE}>{t('settings.translateHint')}</div>

        <div style={TRANSLATE_ROW_STYLE}>
          <div style={TOGGLE_INFO_STYLE}>
            <span style={CHOICE_LABEL_STYLE}>{t('field.translateProvider')}</span>
            <span style={CHOICE_HINT_STYLE}>{t('field.translateProviderHint')}</span>
          </div>
          <select
            style={TRANSLATE_SELECT_STYLE}
            value={translateProvider}
            disabled={locked}
            aria-label={t('field.translateProvider')}
            onChange={(event) => props.edit(TRANSLATE_PROVIDER_FIELD, event.target.value)}
          >
            {TRANSLATE_PROVIDERS.map((value) => (
              <option key={value} value={value}>
                {t(`translate.provider.${value}`)}
              </option>
            ))}
          </select>
        </div>

        <div style={TRANSLATE_ROW_STYLE}>
          <div style={TOGGLE_INFO_STYLE}>
            <span style={CHOICE_LABEL_STYLE}>{t('field.translateTarget')}</span>
            <span style={CHOICE_HINT_STYLE}>{t('field.translateTargetHint')}</span>
          </div>
          <select
            style={TRANSLATE_SELECT_STYLE}
            value={translateTarget}
            disabled={locked}
            aria-label={t('field.translateTarget')}
            onChange={(event) => props.edit(TRANSLATE_TARGET_FIELD, event.target.value)}
          >
            {TRANSLATE_TARGET_OPTIONS.map((tag) => (
              <option key={tag} value={tag}>
                {t(`translate.target.${tag}`)}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section style={GROUP_STYLE}>
        <GroupHead title={t('group.network')} />
        {renderText(TEXT_FIELD)}
        {renderNumberField('requestTimeoutMs')}
      </section>

      <section style={GROUP_STYLE}>
        <GroupHead title={t('group.tasks')} />

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
            name !== 'arxivIntervalMs' &&
            name !== 'pdfMaxMb' &&
            name !== 'pdfCacheMaxMb' &&
            name !== 'pdfTimeoutMs' &&
            name !== 'pdfRetryCount' &&
            name !== 'pdfPerHostConcurrency',
        ).map(renderNumberField)}

        <div style={STORAGE_ROW_STYLE}>
          <span style={CHOICE_LABEL_STYLE}>{t('field.storageDir')}</span>
          <code style={STORAGE_PATH_STYLE}>{health?.storageDir ?? '—'}</code>
          <span style={CHOICE_HINT_STYLE}>{t('field.storageDirHint')}</span>
        </div>

        <CleanupRow t={t} disabled={locked} />
      </section>

      <section style={GROUP_STYLE}>
        <GroupHead title={t('group.fulltext')} />
        <div style={HINT_STYLE}>{t('group.fulltextHint')}</div>
        {renderText(PDF_ROOT_FIELD)}
        {renderNumberField('pdfMaxMb')}
        {renderNumberField('pdfCacheMaxMb')}
        {renderToggle(AUTO_DOWNLOAD_FIELD)}
        {renderToggle(OA_LOOKUP_FIELD)}
        {renderToggle(ARXIV_HTML_FIELD)}
        {renderNumberField('pdfTimeoutMs')}
        {renderNumberField('pdfRetryCount')}
        {renderNumberField('pdfPerHostConcurrency')}
        <StorageProbeRow t={t} disabled={locked} />
        <CleanupRow
          t={t}
          disabled={locked}
          scope="pdf"
          label={t('field.cleanupPdf')}
          hint={t('field.cleanupPdfHint')}
          buttonLabel={t('cleanup.pdf')}
          confirmText={t('cleanup.pdfConfirm')}
        />
      </section>

      <section style={GROUP_STYLE}>
        <GroupHead title={t('group.zotero')} />
        <div style={HINT_STYLE}>{t('group.zoteroHint')}</div>
        {renderToggle(ZOTERO_ENABLED_FIELD)}
        {renderText(ZOTERO_BASE_URL_FIELD)}
        {renderToggle(ZOTERO_ATTACH_FIELD)}
        {renderText(ZOTERO_TAG_FIELD)}
        <ZoteroProbeRow t={t} disabled={locked} />
      </section>
    </div>
  )
}

/** 分组标题：左侧强调条 + 加粗字号，与下方分隔线一起区分各大块。 */
function GroupHead({ title }: { title: string }): ReactElement {
  return (
    <h4 style={GROUP_HEAD_STYLE}>
      <span style={GROUP_HEAD_BAR_STYLE} aria-hidden="true" />
      {title}
    </h4>
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

/** 密钥输入：只显示「已配置/未配置」，从不回显当前值；失焦即保存。 */
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
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
        />
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

/** 清理任务文件 / PDF 缓存：二次确认后删除，结果就地反馈。 */
function CleanupRow({
  t,
  disabled,
  scope = 'tasks',
  label = t('field.cleanup'),
  hint = t('field.cleanupHint'),
  buttonLabel = t('cleanup.tasks'),
  confirmText = t('cleanup.confirm'),
}: {
  t: Translate
  disabled: boolean
  scope?: 'tasks' | 'pdf' | 'all'
  label?: string
  hint?: string
  buttonLabel?: string
  confirmText?: string
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)

  const run = (): void => {
    if (busy || disabled) return
    if (!window.confirm(confirmText)) return
    setBusy(true)
    setText('')
    setFailed(false)
    void cleanupSettings(scope)
      .then((result) => {
        setText(
          tpl(t('cleanup.done'), {
            n: result.removed,
            size: formatBytes(result.freedBytes),
          }),
        )
        void refreshHealth()
      })
      .catch((error: unknown) => {
        setFailed(true)
        setText(
          tpl(t('cleanup.failed'), {
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <div style={CHOICE_ROW_STYLE}>
      <div style={TOGGLE_INFO_STYLE}>
        <span style={CHOICE_LABEL_STYLE}>{label}</span>
        <span style={CHOICE_HINT_STYLE}>{hint}</span>
      </div>
      <div style={INLINE_ROW_STYLE}>
        <button type="button" style={SMALL_BUTTON_STYLE} disabled={busy || disabled} onClick={run}>
          {buttonLabel}
        </button>
        {text !== '' && (
          <span style={failed ? RESULT_ERROR_STYLE : RESULT_STYLE}>{text}</span>
        )}
      </div>
    </div>
  )
}

/** 测试下载目录可写性。 */
function StorageProbeRow({ t, disabled }: { t: Translate; disabled: boolean }): ReactElement {
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)

  const run = (): void => {
    if (busy) return
    setBusy(true)
    setText('')
    setFailed(false)
    void probeStorage()
      .then((result) => {
        setFailed(!result.writable)
        setText(
          result.writable
            ? tpl(t('storage.probeOk'), { root: result.root })
            : tpl(t('storage.probeFail'), {
                root: result.root,
                message: result.error ?? '',
              }),
        )
      })
      .catch((error: unknown) => {
        setFailed(true)
        setText(
          tpl(t('storage.probeFail'), {
            root: '—',
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <div style={CHOICE_ROW_STYLE}>
      <div style={TOGGLE_INFO_STYLE}>
        <span style={CHOICE_LABEL_STYLE}>{t('field.pdfRootProbe')}</span>
        <span style={CHOICE_HINT_STYLE}>{t('field.pdfRootProbeHint')}</span>
      </div>
      <div style={INLINE_ROW_STYLE}>
        <button type="button" style={SMALL_BUTTON_STYLE} disabled={busy || disabled} onClick={run}>
          {busy ? t('storage.testing') : t('storage.test')}
        </button>
        {text !== '' && (
          <span style={failed ? RESULT_ERROR_STYLE : RESULT_STYLE}>{text}</span>
        )}
      </div>
    </div>
  )
}

/** 测试 Zotero connector 并显示当前选中分类。 */
function ZoteroProbeRow({ t, disabled }: { t: Translate; disabled: boolean }): ReactElement {
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [failed, setFailed] = useState(false)

  const run = (): void => {
    if (busy) return
    setBusy(true)
    setText('')
    setFailed(false)
    void probeZotero()
      .then((result) => {
        setFailed(!result.ok)
        if (!result.ok) {
          setText(tpl(t('zotero.probeFail'), { message: result.error ?? '' }))
          return
        }
        setText(
          result.collection === undefined
            ? t('zotero.probeOkNoCollection')
            : tpl(t('zotero.probeOk'), {
                name: result.collection.name,
                version: result.version ?? '—',
              }),
        )
      })
      .catch((error: unknown) => {
        setFailed(true)
        setText(
          tpl(t('zotero.probeFail'), {
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <div style={CHOICE_ROW_STYLE}>
      <div style={TOGGLE_INFO_STYLE}>
        <span style={CHOICE_LABEL_STYLE}>{t('field.zoteroProbe')}</span>
        <span style={CHOICE_HINT_STYLE}>{t('field.zoteroProbeHint')}</span>
      </div>
      <div style={INLINE_ROW_STYLE}>
        <button type="button" style={SMALL_BUTTON_STYLE} disabled={busy || disabled} onClick={run}>
          {busy ? t('zotero.testing') : t('zotero.test')}
        </button>
        {text !== '' && (
          <span style={failed ? RESULT_ERROR_STYLE : RESULT_STYLE}>{text}</span>
        )}
      </div>
    </div>
  )
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

interface SourceProbeRowProps {
  t: Translate
  id: SourceId
  entry:
    | { lastOkAt?: string; lastError?: string; lastLatencyMs?: number; cooldownUntil?: string }
    | undefined
}

/** 来源分组内的探活行：显示运行时健康状态，并可手动探活一次（不受冷却影响）。 */
function SourceProbeRow({ t, id, entry }: SourceProbeRowProps): ReactElement {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ text: string; failed: boolean } | null>(null)

  const run = (): void => {
    if (busy) return
    setBusy(true)
    void probeSource(id)
      .then((probe) => {
        setResult({ text: probeText(t, probe), failed: !probe.ok })
        void refreshHealth()
      })
      .catch((error: unknown) => {
        setResult({
          failed: true,
          text: tpl(t('diagnostics.fail'), {
            message: error instanceof Error ? error.message : String(error),
          }),
        })
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <div style={SOURCE_PROBE_ROW_STYLE}>
      <span
        style={
          result === null
            ? SOURCE_PROBE_TEXT_STYLE
            : result.failed
              ? RESULT_ERROR_STYLE
              : RESULT_STYLE
        }
      >
        {result === null ? healthText(t, entry) : result.text}
      </span>
      <button type="button" style={SMALL_BUTTON_STYLE} disabled={busy} onClick={run}>
        {busy ? t('diagnostics.testing') : t('diagnostics.test')}
      </button>
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

const FORM_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  paddingBottom: 8,
}
const NOTICE_STYLE: CSSProperties = {
  margin: '0 0 12px',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9))',
}
const HINT_STYLE: CSSProperties = { fontSize: 12, color: 'var(--ls-ink-2)', marginBottom: 10 }
const SAVE_STATUS_STYLE: CSSProperties = {
  margin: '0 0 8px',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--ls-ink-2)',
}
const SAVE_FAILED_STYLE: CSSProperties = {
  ...SAVE_STATUS_STYLE,
  opacity: 1,
  color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error, var(--ls-error)))',
}
/** 每个设置分组是一张独立卡片，避免整页读成一大段。 */
const GROUP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  padding: '10px 12px 12px',
  border: '1px solid var(--ls-line)',
  borderRadius: 10,
  background: 'var(--ls-surface)',
}
const GROUP_HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'var(--ls-ink-1)',
  margin: '0 0 10px',
  paddingBottom: 8,
  borderBottom: '1px solid var(--ls-line)',
}
const GROUP_HEAD_BAR_STYLE: CSSProperties = {
  flex: '0 0 auto',
  width: 3,
  height: 15,
  borderRadius: 2,
  background: 'var(--ls-accent)',
}
/** 某个来源的分组框：开关、密钥、参数与探活都在框内。 */
const SOURCE_BOX_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  marginBottom: 6,
  padding: '8px 10px',
  borderRadius: 8,
  background: 'var(--ls-surface-2)',
}
const SOURCE_HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}
const SOURCE_BODY_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column' }
const SOURCE_PROBE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  paddingTop: 4,
}
const SOURCE_PROBE_TEXT_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--ls-ink-3)',
  minWidth: 0,
}
const CHOICE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '6px 0',
  borderBottom: '1px solid var(--ls-line)',
}
/** 翻译分组：左侧说明 + 右侧下拉，与参考设置页一致。 */
const TRANSLATE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '6px 0',
  borderBottom: '1px solid var(--ls-line)',
}
/** 引擎名比语言名长，限宽免得把左侧说明挤没。 */
const TRANSLATE_SELECT_STYLE: CSSProperties = {
  flexShrink: 0,
  maxWidth: '55%',
  fontSize: 12,
  padding: '3px 6px',
  borderRadius: 5,
  border: '1px solid var(--ls-line-strong)',
  background: 'transparent',
  color: 'inherit',
}
const CHOICE_LABEL_STYLE: CSSProperties = { fontSize: 12, fontWeight: 500 }
const CHOICE_HINT_STYLE: CSSProperties = { fontSize: 11, color: 'var(--ls-ink-3)', lineHeight: 1.5 }
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
  color: 'var(--ls-ink-2)',
  background: 'var(--ls-line)',
  padding: '4px 6px',
  borderRadius: 4,
}
const INLINE_ROW_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
const SECRET_INPUT_STYLE: CSSProperties = {
  fontSize: 12,
  padding: '4px 6px',
  borderRadius: 4,
  border: '1px solid var(--ls-line-strong)',
  background: 'transparent',
  color: 'inherit',
  minWidth: 0,
}
const SMALL_BUTTON_STYLE: CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  borderRadius: 4,
  border: '1px solid var(--ls-line-strong)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const RESULT_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--ls-accent-ink)',
}
const RESULT_ERROR_STYLE: CSSProperties = {
  ...RESULT_STYLE,
  color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error, var(--ls-error)))',
}
