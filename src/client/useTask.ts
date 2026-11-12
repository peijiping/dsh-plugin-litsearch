/**
 * 单个任务的取数状态机。
 *
 * 任务 tab 自己轮询：只有 `running / queued` 时才每 1.5 秒拉一次详情，完成即停，
 * 避免多个 tab 空转。重跑 / 取消都走同一套刷新。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { AnnotationInput, ResultsPage, TaskDetail } from '../search/types'
import { annotateTask, cancelTask, fetchResults, fetchTask, runTask } from './api'
import type { ResultsQuery } from './api'
import { subscribeTaskSummary } from './taskListStore'

const POLL_MS = 1500

/** 结果页每页篇数（与检索条件的「每源条数」无关，只影响面板展示）。 */
export const RESULT_PAGE_SIZE = 20

interface TaskState {
  detail: TaskDetail | null
  page: ResultsPage | null
  loading: boolean
  error: string | null
}

export interface TaskView extends TaskState {
  busy: boolean
  pageIndex: number
  pageSize: number
  pageCount: number
  goToPage(index: number): void
  reload(): void
  rerun(): Promise<void>
  cancel(): Promise<void>
  annotate(papers: readonly AnnotationInput[]): Promise<void>
}

const INITIAL: TaskState = { detail: null, page: null, loading: true, error: null }

function isActive(status: TaskDetail['status'] | undefined): boolean {
  return status === 'running' || status === 'queued'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useTask(
  id: string | null,
  signal: AbortSignal | undefined,
  pageSize = RESULT_PAGE_SIZE,
  filters: ResultsQuery = {},
): TaskView {
  const [state, setState] = useState<TaskState>(INITIAL)
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(false)
  const [pageIndex, setPageIndex] = useState(0)
  const size = Math.max(1, Math.floor(pageSize))

  const statusRef = useRef<TaskDetail['status'] | undefined>(undefined)
  const revRef = useRef(-1)
  const seq = useRef(0)
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const filterKey = JSON.stringify(filters)

  // 换任务或改筛选（含排序）时回到第一页：渲染期调整，避免先按旧页码多取一次。
  const scopeKey = `${id ?? ''}\u0000${filterKey}`
  const [prevScope, setPrevScope] = useState(scopeKey)
  if (prevScope !== scopeKey) {
    setPrevScope(scopeKey)
    setPageIndex(0)
  }

  // 结果变少（例如把最后一页的条目全部标为排除）后，页码可能越界，收回最后一页。
  useEffect(() => {
    if (state.page === null || state.page.total === 0) return
    const last = Math.ceil(state.page.total / size) - 1
    if (pageIndex > last) setPageIndex(last)
  }, [state.page, pageIndex, size])

  const load = useCallback(
    async (current: string, index: number, token?: number): Promise<TaskDetail | null> => {
      const detail = await fetchTask(current, signal)
      const page = await fetchResults(
        current,
        { ...filtersRef.current, offset: index * size, limit: size },
        signal,
      )
      // 期间又触发了新一轮加载（例如 /events 送来新 rev）：丢弃这次较旧的结果。
      if (token !== undefined && seq.current !== token) return detail
      statusRef.current = detail.status
      revRef.current = detail.rev
      setState({ detail, page, loading: false, error: null })
      return detail
    },
    [signal, size],
  )

  useEffect(() => {
    if (id === null) {
      setState({ detail: null, page: null, loading: false, error: null })
      return undefined
    }

    const current = ++seq.current
    statusRef.current = undefined
    revRef.current = -1
    setState((previous) =>
      previous.detail?.id === id
        ? { ...previous, loading: true, error: null }
        : { ...INITIAL, loading: true },
    )

    void load(id, pageIndex, current).catch((error: unknown) => {
      if (seq.current !== current || signal?.aborted === true) return
      setState({ detail: null, page: null, loading: false, error: errorMessage(error) })
    })
    const poll = (): void => {
      if (document.hidden || signal?.aborted === true) return
      if (!isActive(statusRef.current)) return
      void (async () => {
        try {
          const detail = await fetchTask(id, signal)
          if (seq.current !== current) return
          statusRef.current = detail.status
          const changed = detail.rev !== revRef.current
          revRef.current = detail.rev
          setState((previous) => ({ ...previous, detail }))
          if (changed) {
            const page = await fetchResults(
              id,
              { ...filtersRef.current, offset: pageIndex * size, limit: size },
              signal,
            )
            if (seq.current !== current) return
            setState((previous) => ({ ...previous, detail, page }))
          }
        } catch {
          // 单次轮询失败不打断：下一拍继续。
        }
      })()
    }

    const timer = setInterval(poll, POLL_MS)
    const onVisible = (): void => {
      if (!document.hidden) poll()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [id, nonce, size, load, signal, filterKey, pageIndex])

  // 任务空闲时不再轮询；宿主侧一旦改了 rev（模型在同一任务里开新一轮、
  // 批量标注等），靠 /events 的摘要触发一次整页重取。运行中的 rev 变化
  // 仍由上面的轮询处理，避免两路重复拉取。
  useEffect(() => {
    if (id === null) return undefined
    return subscribeTaskSummary((summary) => {
      if (summary.id !== id || summary.rev === revRef.current) return
      if (isActive(statusRef.current)) return
      setNonce((value) => value + 1)
    })
  }, [id])

  const reload = useCallback(() => {
    setNonce((value) => value + 1)
  }, [])

  const pageCount =
    state.page === null ? 1 : Math.max(1, Math.ceil(state.page.total / size))

  const goToPage = useCallback(
    (index: number): void => {
      setPageIndex(Math.min(Math.max(0, Math.floor(index)), pageCount - 1))
    },
    [pageCount],
  )

  const rerun = useCallback(async (): Promise<void> => {
    if (id === null || busy) return
    setBusy(true)
    try {
      await runTask(id)
      statusRef.current = 'running'
      revRef.current = -1
      setNonce((value) => value + 1)
    } catch (error) {
      setState((previous) => ({ ...previous, error: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }, [id, busy])

  const cancel = useCallback(async (): Promise<void> => {
    if (id === null || busy) return
    setBusy(true)
    try {
      await cancelTask(id)
      setNonce((value) => value + 1)
    } catch (error) {
      setState((previous) => ({ ...previous, error: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }, [id, busy])

  const annotate = useCallback(
    async (papers: readonly AnnotationInput[]): Promise<void> => {
      if (id === null || papers.length === 0) return
      setBusy(true)
      try {
        await annotateTask(id, papers)
        setNonce((value) => value + 1)
      } catch (error) {
        setState((previous) => ({ ...previous, error: errorMessage(error) }))
      } finally {
        setBusy(false)
      }
    },
    [id],
  )

  return {
    ...state,
    busy,
    pageIndex,
    pageSize: size,
    pageCount,
    goToPage,
    reload,
    rerun,
    cancel,
    annotate,
  }
}
