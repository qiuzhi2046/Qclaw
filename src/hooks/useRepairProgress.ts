import { useCallback, useEffect, useState } from 'react'
import type { RepairProgressEvent, RepairResultEvent } from '../shared/repair-events'

export type { RepairProgressEvent, RepairResultEvent }

export interface RepairProgressState {
  activeRepairs: Map<string, RepairProgressEvent>
  lastResult: RepairResultEvent | null
}

const LAST_RESULT_AUTO_CLEAR_MS = 8_000

/**
 * Subscribe to repair progress and result events from the main process.
 * Uses onRepairProgress / onRepairResult from the preload API.
 */
export function useRepairProgress(): RepairProgressState {
  const [activeRepairs, setActiveRepairs] = useState<Map<string, RepairProgressEvent>>(new Map())
  const [lastResult, setLastResult] = useState<RepairResultEvent | null>(null)

  const handleProgress = useCallback((event: RepairProgressEvent) => {
    setActiveRepairs((prev) => {
      const next = new Map(prev)
      if (event.status === 'success' || event.status === 'failed') {
        next.delete(event.channelId)
      } else {
        next.set(event.channelId, event)
      }
      return next
    })
  }, [])

  const handleResult = useCallback((event: RepairResultEvent) => {
    setLastResult(event)
    setActiveRepairs((prev) => {
      if (!prev.has(event.channelId)) return prev
      const next = new Map(prev)
      next.delete(event.channelId)
      return next
    })
  }, [])

  // Auto-clear lastResult after 8 seconds
  useEffect(() => {
    if (!lastResult) return
    const timer = setTimeout(() => setLastResult(null), LAST_RESULT_AUTO_CLEAR_MS)
    return () => clearTimeout(timer)
  }, [lastResult])

  useEffect(() => {
    if (!window.api?.onRepairProgress || !window.api?.onRepairResult) return

    const unsubProgress = window.api.onRepairProgress((payload) => handleProgress(payload as RepairProgressEvent))
    const unsubResult = window.api.onRepairResult((payload) => handleResult(payload as RepairResultEvent))

    return () => {
      unsubProgress?.()
      unsubResult?.()
    }
  }, [handleProgress, handleResult])

  return { activeRepairs, lastResult }
}
