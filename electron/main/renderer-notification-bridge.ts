import { BrowserWindow } from 'electron'
import type { RepairProgressEvent, RepairResultEvent } from '../../src/shared/repair-events'

export type { RepairProgressEvent, RepairResultEvent }

export const REPAIR_PROGRESS_CHANNEL = 'managed-plugin:repair:progress'
export const REPAIR_RESULT_CHANNEL = 'managed-plugin:repair:result'

/**
 * Send a repair progress event to all renderer windows.
 */
export function sendRepairProgress(event: RepairProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents) {
      win.webContents.send(REPAIR_PROGRESS_CHANNEL, event)
    }
  }
}

/**
 * Send a repair result event to all renderer windows.
 */
export function sendRepairResult(event: RepairResultEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents) {
      win.webContents.send(REPAIR_RESULT_CHANNEL, event)
    }
  }
}

export const UPDATE_AVAILABLE_CHANNEL = 'qclaw:update:available'

/**
 * Send an update-available event to all renderer windows.
 */
export function sendUpdateAvailable(payload: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents) {
      win.webContents.send(UPDATE_AVAILABLE_CHANNEL, payload)
    }
  }
}
