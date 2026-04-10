import { useEffect, useRef, useState } from 'react'
import { Button, Group, Progress, Stack, Text, Title } from '@mantine/core'
import type { QClawUpdateStatus } from '../shared/openclaw-phase4'
import { shouldKeepInstallingState } from '../shared/qclaw-update-install-state'

type CheckPhase = 'checking' | 'intercept' | 'done'

interface UpdateInterceptPageProps {
  onCheckComplete: (status: QClawUpdateStatus | null) => void
  updateInfo: QClawUpdateStatus | null
  onUpdate: () => void
  onSkip: () => void
}

const STARTUP_CHECK_TIMEOUT_MS = 30_000

export default function UpdateInterceptPage({
  onCheckComplete,
  updateInfo,
  onUpdate,
  onSkip,
}: UpdateInterceptPageProps) {
  const isMac = window.api.platform === 'darwin'
  const [phase, setPhase] = useState<CheckPhase>('checking')
  const [downloading, setDownloading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const pollRef = useRef<number | null>(null)
  const onCheckCompleteRef = useRef(onCheckComplete)
  onCheckCompleteRef.current = onCheckComplete

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

  // 启动时主动检查更新，超时 30s 仅在 checking 阶段生效
  useEffect(() => {
    let cancelled = false

    const timer = setTimeout(() => {
      if (!cancelled) {
        onCheckCompleteRef.current(null)
      }
    }, STARTUP_CHECK_TIMEOUT_MS)

    window.api.checkQClawUpdateOnStartup()
      .then((status) => {
        if (cancelled) return
        clearTimeout(timer)
        onCheckCompleteRef.current(status)
      })
      .catch(() => {
        if (cancelled) return
        clearTimeout(timer)
        onCheckCompleteRef.current(null)
      })

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  // 当 updateInfo 到达时切换到 intercept 阶段
  useEffect(() => {
    if (updateInfo) {
      setPhase('intercept')
    }
  }, [updateInfo])

  if (phase === 'checking') {
    return (
      <Stack align="center" gap="md" className="w-full max-w-md">
        <Title order={3}>正在检查更新...</Title>
        <Text size="sm" c="dimmed">请稍候</Text>
      </Stack>
    )
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

  return (
    <Stack align="center" gap="lg" className="w-full max-w-md">
      <Title order={3}>已发现 Qclaw 新版本</Title>

      {updateInfo?.availableVersion && (
        <Text size="sm" c="dimmed">新版本：{updateInfo.availableVersion}</Text>
      )}

      {updateInfo?.releaseNotes && (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{updateInfo.releaseNotes}</Text>
      )}

      {downloading && (
        <Progress
          value={progress ?? 0}
          size="sm"
          animated
          color="blue"
          className="w-full"
        />
      )}

      {installing && (
        <Text size="sm" c="blue">正在安装更新...</Text>
      )}

      {error && (
        <Text size="sm" c="red">{error}</Text>
      )}

      <Group>
        <Button
          variant="default"
          size="sm"
          onClick={onSkip}
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
  )
}
