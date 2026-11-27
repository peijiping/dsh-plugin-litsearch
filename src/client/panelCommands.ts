import { useSyncExternalStore } from 'react'

import type { PanelCommand } from '../search/types'

let pending: readonly PanelCommand[] = []
const handled = new Set<string>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function publish(value: readonly PanelCommand[]): void {
  pending = value
  for (const listener of listeners) listener()
}

export function rememberPanelCommand(command: PanelCommand): boolean {
  if (handled.has(command.commandId)) return false
  handled.add(command.commandId)
  if (handled.size > 250) {
    const oldest = handled.values().next().value
    if (oldest !== undefined) handled.delete(oldest)
  }
  return true
}

export function queuePanelCommand(command: PanelCommand): void {
  publish([...pending.filter((entry) => Date.now() - entry.at <= 10 * 60_000), command].slice(-100))
}

export function consumePanelCommand(id: string): void {
  publish(pending.filter((command) => command.commandId !== id))
}

export function usePanelCommands(): readonly PanelCommand[] {
  return useSyncExternalStore(subscribe, () => pending)
}
