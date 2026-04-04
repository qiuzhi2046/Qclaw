import { useEffect, useState } from 'react'
import { Alert, Button, Group, Loader, Modal, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import type { QClawUpdateActionResult, QClawUpdateStatus } from '../shared/openclaw-phase4'

function statusLabel(status: QClawUpdateStatus['status']): string {
  if (status === 'disabled') return '未启用'
  if (status === 'idle') return '待检查'
  if (status === 'checking') return '检查中'
  if (status === 'available') return '可更新'
  if (status === 'unavailable') return '已最新'
  if (status === 'downloading') return '下载中'
  if (status === 'downloaded') return '已下载'
  if (status === 'installing') return '安装中'
  return '错误'
}

export default function QClawUpdateDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const isMac = window.api.platform === 'darwin'
  const [status, setStatus] = useState<QClawUpdateStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [openingDownloadUrl, setOpeningDownloadUrl] = useState(false)
  const [actionResult, setActionResult] = useState<QClawUpdateActionResult | null>(null)
  const [error, setError] = useState('')

  const refreshStatus = async (activeCheck = false) => {
    setLoading(true)
    setError('')
    try {
      const nextStatus = activeCheck ? await window.api.checkQClawUpdate() : await window.api.getQClawUpdateStatus()
      setStatus(nextStatus)
    } catch (e: any) {
      setError(e?.message || '读取 Qclaw 更新状态失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setActionResult(null)
    void refreshStatus(true)
  }, [open])

  useEffect(() => {
    if (!open || (!downloading && !installing)) return
    const timer = window.setInterval(() => {
      void refreshStatus(false)
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [open, downloading, installing])

  if (!open) return null

  const canTryManualDownload = Boolean(status?.availableVersion || status?.manualDownloadUrl)

  return (
    <Modal
      opened={open}
      onClose={onClose}
      size="xl"
      centered
      title={
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.24em' }}>
            Qclaw Update
          </Text>
          <Title order={3} mt="xs">只更新 Qclaw</Title>
        </div>
      }
    >
      {!status || loading ? (
        <Alert color="green" variant="light" mt="md">
          <Group gap="sm">
            <Loader size="sm" />
            <Text size="sm">正在检查 Qclaw 更新状态...</Text>
          </Group>
        </Alert>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" mt="md">
            <Paper withBorder radius="xl" p="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.2em' }}>
                版本信息
              </Text>
              <Stack gap={8} mt="md">
                <Text size="sm">当前版本：{status.currentVersion}</Text>
                <Text size="sm">可用版本：{status.availableVersion || '暂无'}</Text>
                <Text size="sm">手动下载：{canTryManualDownload ? '可用' : '暂无'}</Text>
                <Text size="sm">状态：{statusLabel(status.status)}</Text>
                {typeof status.progressPercent === 'number' && <Text size="sm">下载进度：{status.progressPercent}%</Text>}
              </Stack>
            </Paper>

            <Paper withBorder radius="xl" p="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.2em' }}>
                影响范围
              </Text>
              <Stack gap={8} mt="md">
                <Text size="sm">不会改动 OpenClaw 程序本体</Text>
                <Text size="sm">不会改动 OpenClaw 配置和记忆数据</Text>
                <Text size="sm">不会主动停止当前 OpenClaw 运行状态</Text>
                <Text size="sm">{status.configured ? '自动更新配置已接通' : '当前自动更新配置尚未接通'}</Text>
              </Stack>
            </Paper>
          </SimpleGrid>

          {(status.message || status.error || error) && (
            <Alert color={status.ok && !status.error && !error ? 'yellow' : 'red'} variant="light" mt="md">
              <Text size="sm">{error || status.error || status.message}</Text>
            </Alert>
          )}

          {actionResult?.message && (
            <Alert color="green" variant="light" mt="md">
              {actionResult.message}
            </Alert>
          )}

          <Group mt="xl">
            <Button
              variant="default"
              size="sm"
              onClick={() => void refreshStatus(true)}
              disabled={loading || downloading || installing || openingDownloadUrl}
            >
              重新检查
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleOpenDownloadUrl()}
              disabled={
                loading ||
                downloading ||
                installing ||
                openingDownloadUrl ||
                status.status === 'checking' ||
                !canTryManualDownload
              }
            >
              {openingDownloadUrl ? '打开中...' : '直接下载最新安装包'}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleDownload()}
              disabled={
                downloading ||
                installing ||
                openingDownloadUrl ||
                status.status === 'downloaded' ||
                status.status === 'installing' ||
                status.status === 'disabled' ||
                status.status === 'unavailable' ||
                !status.configured
              }
            >
              {downloading ? '下载中...' : status.status === 'downloaded' ? '更新包已下载' : '下载更新包'}
            </Button>
            <Button
              color="green"
              size="sm"
              onClick={() => void handleInstall()}
              disabled={installing || status.status !== 'downloaded'}
            >
              {installing ? '安装中...' : '安装更新'}
            </Button>
          </Group>
        </>
      )}
    </Modal>
  )

  async function tryOpenManualFallback(fallbackMessage: string) {
    if (!isMac || !canTryManualDownload) return false

    setOpeningDownloadUrl(true)
    try {
      const result = await window.api.openQClawUpdateDownloadUrl()
      if (!result.ok) return false
      setActionResult({ ...result, message: fallbackMessage })
      setStatus(result.status)
      return true
    } catch {
      return false
    } finally {
      setOpeningDownloadUrl(false)
      await refreshStatus(false)
    }
  }

  async function handleDownload() {
    setDownloading(true)
    setActionResult(null)
    setError('')
    try {
      const result = await window.api.downloadQClawUpdate()
      setActionResult(result)
      setStatus(result.status)
      if (!result.ok) {
        await tryOpenManualFallback('自动更新失败，已为你打开 dmg 安装包下载链接，请改为手动安装。')
      }
    } catch (e: any) {
      const fallbackOpened = await tryOpenManualFallback('自动更新失败，已为你打开 dmg 安装包下载链接，请改为手动安装。')
      if (!fallbackOpened) {
        setError(e?.message || '下载 Qclaw 更新失败')
      }
    } finally {
      setDownloading(false)
      await refreshStatus(false)
    }
  }

  async function handleInstall() {
    setInstalling(true)
    setActionResult(null)
    setError('')
    try {
      const result = await window.api.installQClawUpdate()
      setActionResult(result)
      setStatus(result.status)
      if (!result.ok) {
        setInstalling(false)
        await tryOpenManualFallback('自动安装不可用，已为你打开 dmg 安装包下载链接，请改为手动安装。')
      }
    } catch (e: any) {
      const fallbackOpened = await tryOpenManualFallback('自动安装失败，已为你打开 dmg 安装包下载链接，请改为手动安装。')
      if (!fallbackOpened) {
        setError(e?.message || '安装 Qclaw 更新失败')
      }
      setInstalling(false)
    }
  }

  async function handleOpenDownloadUrl() {
    setOpeningDownloadUrl(true)
    setActionResult(null)
    setError('')
    try {
      const result = await window.api.openQClawUpdateDownloadUrl()
      setActionResult(result)
      setStatus(result.status)
    } catch (e: any) {
      setError(e?.message || '打开 Qclaw 下载链接失败')
    } finally {
      setOpeningDownloadUrl(false)
      await refreshStatus(false)
    }
  }
}
