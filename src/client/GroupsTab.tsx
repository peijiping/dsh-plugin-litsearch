/**
 * 任务「分组」tab：维护「为什么读」的分类，并把文献归入其中。
 *
 * 分组是任务内概念；归组在结果卡片的分组下拉里完成，这里负责增删改名、排序。
 * 增删与排序立即保存，名称和说明在输入框失焦时保存——切到结果页或别处不会丢改动。
 *
 * 布局：页头（小标 + 统计 + 主操作）→ 收起的「新建分组」卡 → 分组卡片列表。
 * 每条分组是独立卡片，左序号、中可编辑、右四个图标操作；横线分割已全部撤掉。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'

import type { TaskDetail, TaskGroup } from '../search/types'
import { updateTask } from './api'
import { ArrowDownIcon, ArrowUpIcon, FilterIcon, IconButton, TrashIcon } from './icons'
import { tpl, type Translate } from './locales'

interface Props {
  t: Translate
  taskId: string
  detail: TaskDetail
  onSaved(): void
  onPickGroup(groupId: string): void
  /** 保存失败时走面板底部浮层提醒（页面内提示已滚走时也能看到）。 */
  onNotify(text: string): void
  /** 当前结果页正在筛选的分组；命中时对应卡片描边高亮。 */
  activeGroupId?: string
}

function draftOf(groups: readonly TaskGroup[]): TaskGroup[] {
  return groups.map((group) => ({ ...group }))
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function GroupsTab({
  t,
  taskId,
  detail,
  onSaved,
  onPickGroup,
  onNotify,
  activeGroupId,
}: Props): ReactElement {
  const [draft, setDraft] = useState<TaskGroup[]>(() => draftOf(detail.groups))
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // 多次改动合并成一串顺序写入，避免旧快照的请求后到、把新分组覆盖掉。
  const latest = useRef<TaskGroup[]>(draft)
  const queued = useRef(false)
  const saving = useRef(false)

  const usage = useMemo(() => {
    const counts = new Map<string, number>()
    for (const state of Object.values(detail.states)) {
      if (state.groupId === undefined) continue
      counts.set(state.groupId, (counts.get(state.groupId) ?? 0) + 1)
    }
    return counts
  }, [detail.states])

  const filed = useMemo(
    () => [...usage.values()].reduce((total, count) => total + count, 0),
    [usage],
  )

  // 「已保存」绿点两秒后自然消失，避免常驻。
  useEffect(() => {
    if (savedAt === null) return
    const timer = setTimeout(() => setSavedAt(null), 2200)
    return () => clearTimeout(timer)
  }, [savedAt])

  const persist = useCallback(
    (next: readonly TaskGroup[]): void => {
      latest.current = next.map((group, order) => ({ ...group, order }))
      queued.current = true
      if (saving.current) return
      saving.current = true
      setBusy(true)
      setError(null)
      void (async () => {
        try {
          while (queued.current) {
            queued.current = false
            await updateTask(taskId, { groups: latest.current.map((group) => ({ ...group })) })
          }
          setSavedAt(Date.now())
          onSaved()
        } catch (reason: unknown) {
          const message = errorMessage(reason)
          setError(message)
          onNotify(message)
        } finally {
          saving.current = false
          setBusy(false)
        }
      })()
    },
    [taskId, onSaved, onNotify],
  )

  const add = (): void => {
    const trimmed = name.trim()
    if (trimmed === '') return
    const id = `g${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`
    const group: TaskGroup = { id, name: trimmed.slice(0, 60), order: draft.length }
    const desc = description.trim()
    if (desc !== '') group.description = desc.slice(0, 200)
    const next = [...draft, group]
    setDraft(next)
    setName('')
    setDescription('')
    setAdding(false)
    persist(next)
  }

  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= draft.length) return
    const next = [...draft]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    const ordered = next.map((group, order) => ({ ...group, order }))
    setDraft(ordered)
    persist(ordered)
  }

  const remove = (group: TaskGroup): void => {
    if (!window.confirm(tpl(t('groups.deleteConfirm'), { name: group.name }))) return
    const next = draft.filter((entry) => entry.id !== group.id)
    setDraft(next)
    persist(next)
  }

  return (
    <div style={WRAP_STYLE}>
      <div style={HEAD_STYLE}>
        <div style={{ minWidth: 0 }}>
          <div className="ls-eyebrow">{t('groups.title')}</div>
          <div className="ls-page-title" style={{ marginTop: 2 }}>
            {tpl(t('groups.summary'), { n: draft.length, m: filed })}
          </div>
        </div>
        <button
          type="button"
          className="ls-btn ls-btn-primary"
          aria-expanded={adding}
          onClick={() => setAdding((previous) => !previous)}
        >
          + {t('groups.new')}
        </button>
      </div>
      <div className="ls-sub">{t('groups.hint')}</div>

      {adding && (
        <section className="ls-card" style={CREATE_CARD_STYLE}>
          <div className="ls-eyebrow">{t('groups.newTitle')}</div>
          <div style={FIELDS_STYLE}>
            <label style={FIELD_STYLE}>
              <span className="ls-micro">{t('groups.name')}</span>
              <input
                className="ls-input"
                value={name}
                placeholder={t('groups.namePlaceholder')}
                aria-label={t('groups.name')}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    add()
                  }
                  if (event.key === 'Escape') setAdding(false)
                }}
              />
            </label>
            <label style={FIELD_STYLE}>
              <span className="ls-micro">{t('groups.desc')}</span>
              <input
                className="ls-input"
                value={description}
                placeholder={t('groups.descPlaceholder')}
                aria-label={t('groups.desc')}
                onChange={(event) => setDescription(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    add()
                  }
                  if (event.key === 'Escape') setAdding(false)
                }}
              />
            </label>
          </div>
          <div style={CREATE_ACTIONS_STYLE}>
            <button
              type="button"
              className="ls-btn ls-btn-ghost ls-btn-compact"
              onClick={() => setAdding(false)}
            >
              {t('groups.cancel')}
            </button>
            <button
              type="button"
              className="ls-btn ls-btn-primary ls-btn-compact"
              disabled={name.trim() === ''}
              onClick={add}
            >
              {t('groups.add')}
            </button>
          </div>
        </section>
      )}

      {draft.length === 0
        ? !adding && (
            <div className="ls-empty">
              <div>{t('groups.empty')}</div>
              <button
                type="button"
                className="ls-btn ls-btn-ghost ls-btn-compact"
                style={{ marginTop: 10 }}
                onClick={() => setAdding(true)}
              >
                {t('groups.emptyCta')}
              </button>
            </div>
          )
        : (
            <div style={LIST_STYLE}>
              {draft.map((group, index) => {
                const count = usage.get(group.id) ?? 0
                const active = activeGroupId === group.id
                return (
                  <div
                    key={group.id}
                    className="ls-card"
                    style={active ? ACTIVE_CARD_STYLE : undefined}
                  >
                    <div style={ROW_STYLE}>
                      <div style={INDEX_STYLE} aria-hidden>
                        {String(index + 1).padStart(2, '0')}
                      </div>
                      <div style={MAIN_STYLE}>
                        <div style={NAME_ROW_STYLE}>
                          <input
                            className="ls-inline-input"
                            value={group.name}
                            aria-label={t('groups.name')}
                            onChange={(event) =>
                              setDraft((previous) =>
                                previous.map((entry) =>
                                  entry.id === group.id
                                    ? { ...entry, name: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                            onBlur={() => persist(draft)}
                          />
                          <span
                            className="ls-count-pill"
                            data-zero={count === 0}
                            title={active ? t('groups.filterActive') : undefined}
                          >
                            {tpl(t('groups.count'), { n: count })}
                          </span>
                        </div>
                        <input
                          className="ls-inline-input ls-inline-sub"
                          style={DESC_INPUT_STYLE}
                          value={group.description ?? ''}
                          placeholder={t('groups.descPlaceholder')}
                          aria-label={t('groups.desc')}
                          onChange={(event) =>
                            setDraft((previous) =>
                              previous.map((entry) =>
                                entry.id === group.id
                                  ? { ...entry, description: event.target.value }
                                  : entry,
                              ),
                            )
                          }
                          onBlur={() => persist(draft)}
                        />
                      </div>
                      <div style={ACTIONS_STYLE}>
                        <IconButton
                          size={20}
                          active={active}
                          label={t('groups.filter')}
                          onClick={() => onPickGroup(group.id)}
                        >
                          <FilterIcon />
                        </IconButton>
                        <IconButton
                          size={20}
                          label={t('groups.up')}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUpIcon />
                        </IconButton>
                        <IconButton
                          size={20}
                          label={t('groups.down')}
                          disabled={index === draft.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDownIcon />
                        </IconButton>
                        <IconButton
                          size={20}
                          label={t('groups.delete')}
                          onClick={() => remove(group)}
                        >
                          <TrashIcon />
                        </IconButton>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

      {error !== null ? (
        <div style={STATUS_ROW_STYLE}>
          <span className="ls-status-dot" data-tone="error" />
          <span style={{ color: 'var(--ls-error)', fontSize: 11.5 }}>{error}</span>
          <button type="button" className="ls-btn ls-btn-text" onClick={() => persist(draft)}>
            {t('groups.retry')}
          </button>
        </div>
      ) : busy ? (
        <div style={STATUS_ROW_STYLE}>
          <span className="ls-status-dot" data-tone="saving" />
          <span className="ls-sub">{t('groups.saving')}</span>
        </div>
      ) : savedAt !== null ? (
        <div style={STATUS_ROW_STYLE}>
          <span className="ls-status-dot" />
          <span className="ls-sub">{t('groups.statusSaved')}</span>
        </div>
      ) : null}
    </div>
  )
}

const WRAP_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }

const HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 10,
}

const CREATE_CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const FIELDS_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 8,
}

const FIELD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  minWidth: 0,
}

const CREATE_ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
}

const LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

/** 左序号 / 中可编辑 / 右操作，中间列必须能压缩，否则长名称会把按钮顶出容器。 */
const ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '14px minmax(0, 1fr) auto',
  alignItems: 'start',
  gap: 9,
}

const INDEX_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: '20px',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--ls-ink-3)',
}

const MAIN_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
}

const NAME_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minWidth: 0,
}

const DESC_INPUT_STYLE: CSSProperties = { padding: 0 }

const ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  flexShrink: 0,
}

const ACTIVE_CARD_STYLE: CSSProperties = {
  borderColor: 'var(--ls-accent)',
}

const STATUS_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minHeight: 16,
}
