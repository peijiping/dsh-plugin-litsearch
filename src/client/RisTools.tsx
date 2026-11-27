import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type { RisImportBatchSummary, RisImportIssue, RisImportMetadata, RisImportReport } from '../search/types'
import { importRisFile, listRisBatches } from './api'
import { tpl, type Translate } from './locales'
import { statusStyle } from './styles'

const FILE_LIMIT = 5 * 1024 * 1024
const FORM_STYLE: CSSProperties = { display: 'grid', gap: 10, minWidth: 0 }
const FIELD_STYLE: CSSProperties = { display: 'grid', gap: 4, minWidth: 0 }
const BUTTONS_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }
const SCROLL_STYLE: CSSProperties = { maxHeight: '55dvh', overflowY: 'auto', overflowWrap: 'anywhere', padding: 2 }

type BatchItem = RisImportBatchSummary & { issues: RisImportIssue[] }

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function RisTools({ t, taskId, onCommitted }: {
  t: Translate
  taskId: string
  onCommitted(): void
}): ReactElement {
  const [modal, setModal] = useState<'import' | 'batches' | null>(null)
  const close = () => setModal(null)
  return (
    <>
      <div style={{ ...BUTTONS_STYLE, justifyContent: 'flex-start', padding: '4px 8px' }}>
        <Button type="button" variant="outline" onClick={() => setModal('import')}>{t('ris.open')}</Button>
        <Button type="button" variant="outline" onClick={() => setModal('batches')}>{t('ris.batches')}</Button>
      </div>
      {modal === 'import' && <ImportDialog t={t} taskId={taskId} onClose={close} onCommitted={onCommitted} />}
      {modal === 'batches' && <BatchDialog t={t} taskId={taskId} onClose={close} />}
    </>
  )
}

function ImportDialog({ t, taskId, onClose, onCommitted }: {
  t: Translate
  taskId: string
  onClose(): void
  onCommitted(): void
}): ReactElement {
  const [file, setFile] = useState<File | undefined>()
  const [meta, setMeta] = useState<Omit<RisImportMetadata, 'fileName'>>({ database: '', searchedAt: '', query: '' })
  const [preview, setPreview] = useState<RisImportReport | null>(null)
  const [content, setContent] = useState('')
  const [committed, setCommitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])

  function changeField(field: keyof typeof meta, value: string): void {
    setMeta((current) => ({ ...current, [field]: value }))
    setPreview(null)
    setError('')
  }

  async function submit(confirm: boolean): Promise<void> {
    if (!file || pending.current || !meta.database.trim() || (confirm && (!preview || preview.added + preview.matched === 0))) return
    if (file.size === 0 || file.size > FILE_LIMIT) {
      setError(t('ris.size'))
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError('')
    try {
      const encoded = confirm ? content : await readFile(file)
      if (controller.signal.aborted) return
      setContent(encoded)
      const result = await importRisFile(taskId, { ...meta, fileName: file.name, content: encoded }, confirm ? preview?.fingerprint : undefined, controller.signal)
      if (controller.signal.aborted) return
      setPreview(result)
      if (confirm) {
        setCommitted(true)
        onCommitted()
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pending.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  const done = committed || preview?.alreadyImported === true
  const canConfirm = preview !== null && preview.added + preview.matched > 0
  const title = t(preview?.alreadyImported ? 'ris.existing' : committed ? 'ris.complete' : 'ris.open')
  return (
    <Modal open headless={done} title={title} onClose={() => { if (!busy && !done) onClose() }}>
      <form
        style={done ? { ...FORM_STYLE, padding: '14px 18px 16px' } : FORM_STYLE}
        onSubmit={(event) => {
          event.preventDefault()
          if (done) onClose()
          else void submit(preview !== null)
        }}
      >
        {done && <h2 style={{ margin: 0, fontSize: 17 }}>{title}</h2>}
        <div style={{ ...FORM_STYLE, ...SCROLL_STYLE }}>
          {!done && <>
            <p style={{ ...statusStyle, margin: 0 }}>{t('ris.taskScope')}</p>
            <label style={FIELD_STYLE}>
              {t('ris.file')}
              <input
                type="file"
                accept=".ris,application/x-research-info-systems,text/plain"
                disabled={busy}
                onChange={(event) => {
                  setFile(event.target.files?.[0])
                  setPreview(null)
                  setContent('')
                  setError('')
                }}
              />
            </label>
            <label style={FIELD_STYLE}>
              {t('ris.database')}
              <input disabled={busy} required maxLength={200} value={meta.database} onChange={(event) => changeField('database', event.target.value)} />
            </label>
            <label style={FIELD_STYLE}>
              {t('ris.searchedAt')}
              <input disabled={busy} type="date" value={meta.searchedAt} onChange={(event) => changeField('searchedAt', event.target.value)} />
            </label>
            <label style={FIELD_STYLE}>
              {t('ris.query')}
              <textarea disabled={busy} rows={3} maxLength={5000} value={meta.query} onChange={(event) => changeField('query', event.target.value)} />
            </label>
          </>}
          {error && <p role="alert" style={{ ...statusStyle, color: 'var(--ls-error)', margin: 0 }}>{error}</p>}
          {preview && <>
            <p role="status" style={{ margin: 0 }}>{tpl(t(done ? 'ris.counts' : 'ris.previewCounts'), {
              total: preview.total, added: preview.added, matched: preview.matched, failed: preview.issues.length,
            })}</p>
            <Issues t={t} entries={preview.issues} />
          </>}
        </div>
        <div style={BUTTONS_STYLE}>
          {done ? (
            <Button type="button" variant="primary" data-modal-autofocus onClick={onClose}>{t('ris.ok')}</Button>
          ) : <>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t('ris.cancel')}</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || file === undefined || !meta.database.trim() || (preview !== null && !canConfirm)}
            >
              {t(busy ? 'ris.working' : preview ? 'ris.confirm' : 'ris.preview')}
            </Button>
          </>}
        </div>
      </form>
    </Modal>
  )
}

function Issues({ t, entries }: { t: Translate; entries: RisImportIssue[] }): ReactElement | null {
  if (!entries.length) return null
  return (
    <ul style={{ margin: 0, paddingInlineStart: 20, maxHeight: 150, overflowY: 'auto' }}>
      {entries.map((issue) => (
        <li key={issue.record}>{tpl(t('ris.issue'), { ...issue, message: t('ris.' + issue.code) })}</li>
      ))}
    </ul>
  )
}

function BatchDialog({ t, taskId, onClose }: { t: Translate; taskId: string; onClose(): void }): ReactElement {
  const [batches, setBatches] = useState<BatchItem[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void listRisBatches(taskId, controller.signal).then(
      (result) => { if (!controller.signal.aborted) setBatches(result) },
      (cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) },
    )
    return () => controller.abort()
  }, [taskId])
  return (
    <Modal open title={t('ris.batches')} onClose={onClose}>
      <div style={FORM_STYLE}>
        <div style={{ ...FORM_STYLE, ...SCROLL_STYLE }}>
          {error ? <p role="alert" style={{ margin: 0 }}>{error}</p> :
            batches === null ? <p role="status" style={{ margin: 0 }}>{t('ris.working')}</p> :
            !batches.length ? <p style={{ margin: 0 }}>{t('ris.empty')}</p> :
            [...batches].reverse().map((batch) => (
              <details key={batch.id}>
                <summary>{batch.database} · {batch.fileName} · {new Date(batch.importedAt).toLocaleDateString()}</summary>
                <div style={{ ...FORM_STYLE, padding: '6px 0' }}>
                  <div>{tpl(t('ris.counts'), { total: batch.total, added: batch.added, matched: batch.matched, failed: batch.failed })}</div>
                  <RisOriginMetadata t={t} batch={batch} />
                  <Issues t={t} entries={batch.issues} />
                </div>
              </details>
            ))}
        </div>
        <div style={BUTTONS_STYLE}>
          <Button type="button" variant="primary" onClick={onClose}>{t('ris.ok')}</Button>
        </div>
      </div>
    </Modal>
  )
}

export function RisOriginMetadata({ t, batch }: { t: Translate; batch: RisImportBatchSummary }): ReactElement {
  return (
    <div style={{ overflowWrap: 'anywhere' }}>
      <div>{t('ris.searchedAt')} · {batch.searchedAt || t('ris.unknown')}</div>
      {batch.query && <div style={{ whiteSpace: 'pre-wrap' }}>{t('ris.query')} · {batch.query}</div>}
    </div>
  )
}
