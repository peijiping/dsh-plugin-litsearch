/**
 * 面板级通知：任务切换预检失败等「不在某个页面状态里」的提醒。
 *
 * 主页与任务页都订阅同一份通知，当前可见的那个面板负责展示。
 */

import { useSyncExternalStore } from 'react'

export interface Notice {
  id: number
  text: string
  tone: 'info' | 'error'
}

let notice: Notice | null = null
let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

export function showNotice(text: string, tone: 'info' | 'error' = 'error', ms = 6000): void {
  seq += 1
  notice = { id: seq, text, tone }
  clearTimer()
  timer = setTimeout(() => {
    timer = null
    notice = null
    emit()
  }, ms)
  emit()
}

export function dismissNotice(): void {
  clearTimer()
  if (notice === null) return
  notice = null
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Notice | null {
  return notice
}

function getServerSnapshot(): Notice | null {
  return null
}

export function useNotice(): Notice | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
