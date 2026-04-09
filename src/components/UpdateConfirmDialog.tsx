import { useEffect, useRef, useState } from 'react'
import { Button, Group, Modal, Progress, Stack, Text, Title } from '@mantine/core'
import { shouldKeepInstallingState } from '../shared/qclaw-update-install-state'

interface UpdateConfirmDialogProps {
  open: boolean
  onClose: () => void
  availableVersion: string | null
  releaseNotes?: string | null
}

export default function UpdateConfirmDialog({
  open,
  onClose,
  availableVersion,
  releaseNotes,
}: UpdateConfirmDialogProps) {
  const isMac = window.api.platform === 'darwin'
  const [downloading, setDownloading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const pollRef = useRef<number | null>(null)

  // 组件卸载时清除轮询
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
  }, [])

  const busy = downloading || installing

  const clearPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const handleUpdate = async () => {
    setError('')
    setDownloading(true)
    setProgress(null)
    let keepInstalling = false

    pollRef.current = window.setInterval(async () => {
      try {
        const s = await window.api.getQClawUpdateStatus()
        if (typeof s.progressPercent === 'number') {
          setProgress(s.progressPercent)
        }
      } catch {
        // 轮询失败不影响下载流程
      }
    }, 1000)

    try {
      const result = await window.api.downloadQClawUpdate()
      clearPoll()
      setDownloading(false)

      if (!result.ok) {
        if (isMac) {
          const fallback = await tryManualFallback('自动更新失败，已为你打开安装包下载链接，请手动安装。')
          if (fallback) return
        }
        setError(result.error || '下载更新失败')
        return
      }

      setInstalling(true)
      const installResult = await window.api.installQClawUpdate()
      keepInstalling = shouldKeepInstallingState(installResult)
      if (keepInstalling) return // 即将重启，保持 installing 状态
      if (!installResult.ok) {
        if (isMac) {
          const fallback = await tryManualFallback('自动安装不可用，已为你打开安装包下载链接，请手动安装。')
          if (fallback) return
        }
        setError(installResult.error || '安装更新失败')
      }
    } catch (e: unknown) {
      clearPoll()
      setDownloading(false)

      if (isMac) {
        const fallback = await tryManualFallback('自动更新失败，已为你打开安装包下载链接，请手动安装。')
        if (fallback) return
      }
      setError(e instanceof Error ? e.message : '更新失败')
    } finally {
      clearPoll()
      if (!keepInstalling) {
        setInstalling(false)
      }
    }
  }

  const tryManualFallback = async (message: string): Promise<boolean> => {
    try {
      const result = await window.api.openQClawUpdateDownloadUrl()
      if (result.ok) {
        setError(message)
        return true
      }
    } catch {
      // 回退失败，继续显示原始错误
    }
    return false
  }

  const handleClose = () => {
    if (busy) return
    setError('')
    setProgress(null)
    onClose()
  }

  return (
    <Modal
      opened={open}
      onClose={handleClose}
      size="sm"
      centered
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      title={
        <Title order={4}>已发现 Qclaw 新版本，是否更新？</Title>
      }
    >
      <Stack gap="md">
        {availableVersion && (
          <Text size="sm" c="dimmed">新版本：{availableVersion}</Text>
        )}

        {releaseNotes && (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{releaseNotes}</Text>
        )}

        {downloading && (
          <Progress
            value={progress ?? 0}
            size="sm"
            animated
            color="blue"
          />
        )}

        {installing && (
          <Text size="sm" c="blue">正在安装更新...</Text>
        )}

        {error && (
          <Text size="sm" c="red">{error}</Text>
        )}

        <Group justify="flex-end">
          <Button
            variant="default"
            size="sm"
            onClick={handleClose}
            disabled={busy}
          >
            稍后再说
          </Button>
          <Button
            color="blue"
            size="sm"
            onClick={() => void handleUpdate()}
            disabled={busy}
          >
            {downloading ? '下载中...' : installing ? '安装中...' : '立即更新'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
