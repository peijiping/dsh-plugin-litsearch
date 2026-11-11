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

interface TaskState {
  detail: TaskDetail | null
  page: ResultsPage | null
  loading: boolean
  error: string | null
}

export interface TaskView extends TaskState {
  loadingMore: boolean
  busy: boolean
  reload(): void
  loadMore(): Promise<void>
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
  fallbackLimit = 20,
  filters: ResultsQuery = {},
): TaskView {
  const [state, setState] = useState<TaskState>(INITIAL)
  const [nonce, setNonce] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busy, setBusy] = useState(false)

  const statusRef = useRef<TaskDetail['status'] | undefined>(undefined)
  const revRef = useRef(-1)
  const limitRef = useRef(fallbackLimit)
  const seq = useRef(0)
  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const filterKey = JSON.stringify(filters)

  const load = useCallback(
    async (current: string, pageLimit: number, token?: number): Promise<TaskDetail | null> => {
      const detail = await fetchTask(current, signal)
      const page = await fetchResults(
        current,
        { ...filtersRef.current, limit: pageLimit },
        signal,
      )
      // 期间又触发了新一轮加载（例如 /events 送来新 rev）：丢弃这次较旧的结果。
      if (token !== undefined && seq.current !== token) return detail
      statusRef.current = detail.status
      revRef.current = detail.rev
      limitRef.current = Math.max(pageLimit, detail.conditions.pageSize)
      setState({ detail, page, loading: false, error: null })
      return detail
    },
    [signal],
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

    void load(id, fallbackLimit, current).catch((error: unknown) => {
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
              { ...filtersRef.current, limit: Math.max(limitRef.current, detail.conditions.pageSize) },
              signal,
            )
            if (seq.current !== current) return
            limitRef.current = Math.max(page.limit, page.papers.length)
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
  }, [id, nonce, fallbackLimit, load, signal, filterKey])

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

  const loadMore = useCallback(async (): Promise<void> => {
    const detail = state.detail
    const page = state.page
    if (id === null || detail === null || page === null || loadingMore) return
    if (page.papers.length >= page.total) return
    setLoadingMore(true)
    try {
      const next = await fetchResults(
        id,
        { ...filtersRef.current, offset: page.papers.length, limit: Math.max(limitRef.current, 20) },
        signal,
      )
      setState((previous) => {
        if (previous.page === null) return previous
        return {
          ...previous,
          page: {
            ...next,
            offset: 0,
            papers: [...previous.page.papers, ...next.papers],
          },
        }
      })
    } catch (error) {
      setState((previous) => ({ ...previous, error: errorMessage(error) }))
    } finally {
      setLoadingMore(false)
    }
  }, [id, state.detail, state.page, loadingMore, signal])

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
    loadingMore,
    busy,
    reload,
    loadMore,
    rerun,
    cancel,
    annotate,
  }
}
