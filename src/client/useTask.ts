/**
 * 单个任务的取数状态机。
 *
 * 任务 tab 自己轮询：只有 `running / queued` 时才每 1.5 秒拉一次详情，完成即停，
 * 避免多个 tab 空转。重跑 / 取消都走同一套刷新。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { ResultsPage, TaskDetail } from '../search/types'
import { cancelTask, fetchResults, fetchTask, runTask } from './api'
import type { ResultsQuery } from './api'

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
    async (current: string, pageLimit: number): Promise<TaskDetail | null> => {
      const detail = await fetchTask(current, signal)
      const page = await fetchResults(
        current,
        { ...filtersRef.current, limit: pageLimit },
        signal,
      )
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

    void load(id, fallbackLimit).catch((error: unknown) => {
      if (seq.current !== current || signal?.aborted === true) return
      setState({ detail: null, page: null, loading: false, error: errorMessage(error) })
    })
    const timer = setInterval(() => {
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
    }, POLL_MS)

    return () => {
      clearInterval(timer)
    }
  }, [id, nonce, fallbackLimit, load, signal, filterKey])

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

  return {
    ...state,
    loadingMore,
    busy,
    reload,
    loadMore,
    rerun,
    cancel,
  }
}
