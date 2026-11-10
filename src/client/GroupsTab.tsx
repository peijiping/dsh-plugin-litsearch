/**
 * 任务「分组」tab：维护「为什么读」的分类，并把文献归入其中。
 *
 * 分组是任务内概念；归组在结果卡片的标注区完成，这里只负责增删改名、排序，
 * 以及按组跳到结果页筛选。保存前全部改动只落在本地草稿。
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { TaskDetail, TaskGroup } from '../search/types'
import { updateTask } from './api'
import { tpl, type Translate } from './locales'
import { ERROR, linkButtonStyle, statusStyle } from './styles'

interface Props {
  t: Translate
  taskId: string
  detail: TaskDetail
  onSaved(): void
  onPickGroup(groupId: string): void
}

function draftOf(groups: readonly TaskGroup[]): TaskGroup[] {
  return groups.map((group) => ({ ...group }))
}

export function GroupsTab({ t, taskId, detail, onSaved, onPickGroup }: Props): ReactElement {
  const [draft, setDraft] = useState<TaskGroup[]>(() => draftOf(detail.groups))
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState('')

  useEffect(() => {
    setDraft(draftOf(detail.groups))
  }, [detail.rev])

  const usage = useMemo(() => {
    const counts = new Map<string, number>()
    for (const state of Object.values(detail.states)) {
      if (state.groupId === undefined) continue
      counts.set(state.groupId, (counts.get(state.groupId) ?? 0) + 1)
    }
    return counts
  }, [detail.states])

  const dirty =
    JSON.stringify(draft.map((group) => [group.id, group.name, group.description ?? ''])) !==
    JSON.stringify(detail.groups.map((group) => [group.id, group.name, group.description ?? '']))

  const add = (): void => {
    const trimmed = name.trim()
    if (trimmed === '') return
    const id = `g${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`
    const group: TaskGroup = { id, name: trimmed.slice(0, 60), order: draft.length }
    const desc = description.trim()
    if (desc !== '') group.description = desc.slice(0, 200)
    setDraft((previous) => [...previous, group])
    setName('')
    setDescription('')
    setToast(t('groups.added'))
  }

  const move = (index: number, delta: -1 | 1): void => {
    setDraft((previous) => {
      const target = index + delta
      if (target < 0 || target >= previous.length) return previous
      const next = [...previous]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next.map((group, order) => ({ ...group, order }))
    })
  }

  const remove = (group: TaskGroup): void => {
    if (!window.confirm(tpl(t('groups.deleteConfirm'), { name: group.name }))) return
    setDraft((previous) => previous.filter((entry) => entry.id !== group.id))
  }

  const save = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void updateTask(taskId, { groups: draft.map((group, order) => ({ ...group, order })) })
      .then(() => {
        setToast(t('groups.saved'))
        onSaved()
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <div style={WRAP_STYLE}>
      <div style={statusStyle}>{t('groups.hint')}</div>

      <div style={ADD_ROW_STYLE}>
        <input
          style={INPUT_STYLE}
          value={name}
          placeholder={t('groups.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          style={INPUT_STYLE}
          value={description}
          placeholder={t('groups.descPlaceholder')}
          onChange={(event) => setDescription(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
        />
        <Button variant="outline" size="sm" type="button" onClick={add}>
          {t('groups.add')}
        </Button>
      </div>

      {draft.length === 0 ? (
        <div style={statusStyle}>{t('groups.empty')}</div>
      ) : (
        <div style={LIST_STYLE}>
          {draft.map((group, index) => (
            <div key={group.id} style={GROUP_ROW_STYLE}>
              <div style={GROUP_HEAD_STYLE}>
                <input
                  style={{ ...INPUT_STYLE, flex: 1, fontWeight: 600 }}
                  value={group.name}
                  onChange={(event) =>
                    setDraft((previous) =>
                      previous.map((entry) =>
                        entry.id === group.id ? { ...entry, name: event.target.value } : entry,
                      ),
                    )
                  }
                />
                <span style={COUNT_STYLE}>{tpl(t('groups.count'), { n: usage.get(group.id) ?? 0 })}</span>
              </div>
              <input
                style={INPUT_STYLE}
                value={group.description ?? ''}
                placeholder={t('groups.descPlaceholder')}
                onChange={(event) =>
                  setDraft((previous) =>
                    previous.map((entry) =>
                      entry.id === group.id
                        ? { ...entry, description: event.target.value }
                        : entry,
                    ),
                  )
                }
              />
              <div style={ACTION_ROW_STYLE}>
                <button
                  type="button"
                  style={linkButtonStyle}
                  onClick={() => onPickGroup(group.id)}
                >
                  {t('groups.filter')}
                </button>
                <button
                  type="button"
                  style={linkButtonStyle}
                  disabled={index === 0}
                  title={t('groups.up')}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  style={linkButtonStyle}
                  disabled={index === draft.length - 1}
                  title={t('groups.down')}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button type="button" style={linkButtonStyle} onClick={() => remove(group)}>
                  {t('groups.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={ACTION_ROW_STYLE}>
        <Button variant="outline" size="sm" type="button" disabled={!dirty || busy} onClick={save}>
          {t('groups.save')}
        </Button>
        {toast !== '' && <span style={TOAST_STYLE}>{toast}</span>}
      </div>
      {error !== null && <div style={{ ...statusStyle, color: ERROR }}>{error}</div>}
    </div>
  )
}

const WRAP_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }
const ADD_ROW_STYLE: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap' }
const INPUT_STYLE: CSSProperties = {
  fontSize: 12,
  padding: '3px 5px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
  minWidth: 0,
  flex: '1 1 120px',
}
const LIST_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const GROUP_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '6px 0',
  borderTop: '1px solid rgba(127,127,127,0.14)',
}
const GROUP_HEAD_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
const COUNT_STYLE: CSSProperties = { fontSize: 11, opacity: 0.7, whiteSpace: 'nowrap' }
const ACTION_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
}
const TOAST_STYLE: CSSProperties = { fontSize: 12, color: '#2e9e5b' }
