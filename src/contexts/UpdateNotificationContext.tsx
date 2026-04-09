import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import UpdateConfirmDialog from '../components/UpdateConfirmDialog'
import type { QClawUpdateStatus } from '../shared/openclaw-phase4'
import {
  buildUpdateNotificationState,
  EMPTY_UPDATE_NOTIFICATION_STATE,
  type UpdateNotificationState,
} from '../shared/qclaw-update-reminder'

interface DevUpdateMockWindow {
  __qclawSetMockUpdate?: (overrides?: Partial<QClawUpdateStatus>) => void
  __qclawClearMockUpdate?: () => void
}

function buildDevMockUpdateStatus(
  overrides: Partial<QClawUpdateStatus> = {}
): QClawUpdateStatus {
  return {
    ok: true,
    supported: true,
    configured: true,
    currentVersion: '2.2.0',
    availableVersion: '2.2.1',
    status: 'available',
    progressPercent: null,
    downloaded: false,
    releaseDate: '2026-04-10',
    releaseNotes: 'Dev console preview',
    ...overrides,
  }
}

interface UpdateNotificationContextValue {
  state: UpdateNotificationState
  openConfirmDialog: () => void
  dismiss: () => void
}

const UpdateNotificationContext = createContext<UpdateNotificationContextValue | null>(null)

export function UpdateNotificationProvider({
  children,
  initialUpdate = null,
}: {
  children: ReactNode
  initialUpdate?: QClawUpdateStatus | null
}) {
  const [state, setState] = useState<UpdateNotificationState>(() =>
    initialUpdate ? buildUpdateNotificationState(initialUpdate) : { ...EMPTY_UPDATE_NOTIFICATION_STATE }
  )
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)

  useEffect(() => {
    const unsubscribe = window.api.onUpdateAvailable((payload) => {
      const p = payload as QClawUpdateStatus & { source?: string }
      setState(buildUpdateNotificationState(p))

      if (p.source === 'notification-click') {
        setConfirmDialogOpen(true)
      }
    })

    return unsubscribe
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV) return

    const debugWindow = window as Window & typeof globalThis & DevUpdateMockWindow
    debugWindow.__qclawSetMockUpdate = (overrides = {}) => {
      setState(buildUpdateNotificationState(buildDevMockUpdateStatus(overrides)))
    }
    debugWindow.__qclawClearMockUpdate = () => {
      setConfirmDialogOpen(false)
      setState({ ...EMPTY_UPDATE_NOTIFICATION_STATE })
    }

    return () => {
      delete debugWindow.__qclawSetMockUpdate
      delete debugWindow.__qclawClearMockUpdate
    }
  }, [])

  const openConfirmDialog = useCallback(() => {
    setConfirmDialogOpen(true)
  }, [])

  const dismiss = useCallback(() => {
    setConfirmDialogOpen(false)
  }, [])

  return (
    <UpdateNotificationContext.Provider value={{ state, openConfirmDialog, dismiss }}>
      {children}
      <UpdateConfirmDialog
        open={confirmDialogOpen}
        onClose={() => setConfirmDialogOpen(false)}
        availableVersion={state.availableVersion}
        releaseNotes={state.releaseNotes}
      />
    </UpdateNotificationContext.Provider>
  )
}

export function useUpdateNotification(): UpdateNotificationContextValue {
  const ctx = useContext(UpdateNotificationContext)
  if (!ctx) {
    throw new Error('useUpdateNotification must be used within UpdateNotificationProvider')
  }
  return ctx
}
