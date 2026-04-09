import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import UpdateConfirmDialog from '../components/UpdateConfirmDialog'
import type { QClawUpdateStatus } from '../shared/openclaw-phase4'

interface UpdateNotificationState {
  hasUpdate: boolean
  availableVersion: string | null
  releaseNotes: string | null
  releaseDate: string | null
}

interface UpdateNotificationContextValue {
  state: UpdateNotificationState
  openConfirmDialog: () => void
  dismiss: () => void
}

const UpdateNotificationContext = createContext<UpdateNotificationContextValue | null>(null)

const INITIAL_STATE: UpdateNotificationState = {
  hasUpdate: false,
  availableVersion: null,
  releaseNotes: null,
  releaseDate: null,
}

export function UpdateNotificationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateNotificationState>(INITIAL_STATE)
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)

  useEffect(() => {
    const unsubscribe = window.api.onUpdateAvailable((payload) => {
      const p = payload as QClawUpdateStatus & { source?: string }
      setState({
        hasUpdate: true,
        availableVersion: p.availableVersion ?? null,
        releaseNotes: p.releaseNotes ?? null,
        releaseDate: p.releaseDate ?? null,
      })

      if (p.source === 'notification-click') {
        setConfirmDialogOpen(true)
      }
    })

    return unsubscribe
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
