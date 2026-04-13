import { useEffect, useState } from 'react'
import { Alert, Button, Group, Loader, Modal, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import type { CombinedUpdateCheckResult, CombinedUpdateRunResult } from '../shared/openclaw-phase4'
import { PINNED_OPENCLAW_VERSION } from '../shared/openclaw-version-policy'

export default function CombinedUpdateDialog({
  open,
  onClose,
  onUpdated,
}: {
  open: boolean
  onClose: () => void
  onUpdated?: () => void
}) {
  const [check, setCheck] = useState<CombinedUpdateCheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<CombinedUpdateRunResult | null>(null)
  const [error, setError] = useState('')

  const loadCheck = async () => {
    setLoading(true)
    setError('')
    try {
      const nextCheck = await window.api.checkCombinedUpdate()
      setCheck(nextCheck)
    } catch (e: any) {
      setError(e?.message || '读取组合更新状态失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setResult(null)
    void loadCheck()
  }, [open])

  if (!open) return null

  const openclawCanRunInCombined = Boolean(
    check &&
      check.openclaw.policyState === 'supported_not_target' &&
      check.openclaw.enforcement === 'optional_upgrade' &&
      check.openclaw.targetAction === 'upgrade' &&
      check.openclaw.targetVersion
  )

  return (
    <Modal
      opened={open}
      onClose={onClose}
      size="xl"
      centered
      title={
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.24em' }}>
            Combined Update
          </Text>
          <Title order={3} mt="xs">同时更新 Qclaw 与 OpenClaw</Title>
        </div>
      }
    >
      {!check || loading ? (
        <Alert color="green" variant="light" mt="md">
          <Group gap="sm">
            <Loader size="sm" />
            <Text size="sm">正在生成组合更新计划...</Text>
          </Group>
        </Alert>
      ) : (
        <>
          <Paper withBorder radius="xl" p="md" mt="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.2em' }}>
              执行顺序
            </Text>
            <Stack gap={8} mt="md">
              <Text size="sm">1. 检查 Qclaw 和 OpenClaw 的更新状态</Text>
              <Text size="sm">2. 先下载 Qclaw Lite 安装包，但暂不安装</Text>
              <Text size="sm">3. 创建 OpenClaw 升级前快照</Text>
              <Text size="sm">4. 升级当前已接管的 OpenClaw</Text>
              <Text size="sm">5. OpenClaw 成功后再安装 Qclaw Lite 安装包</Text>
            </Stack>
          </Paper>

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" mt="md">
            <Paper withBorder radius="xl" p="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.2em' }}>
                OpenClaw
              </Text>
              <Stack gap={8} mt="md">
                <Text size="sm">当前版本：{check.openclaw.currentVersion || '未知'}</Text>
                <Text size="sm">目标版本：{check.openclaw.targetVersion || '未知'}</Text>
                <Text size="sm">组合更新资格：{openclawCanRunInCombined ? `可升级到 ${PINNED_OPENCLAW_VERSION}` : '当前不支持组合更新'}</Text>
              </Stack>
            </Paper>

            <Paper withBorder radius="xl" p="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.2em' }}>
                Qclaw
              </Text>
              <Stack gap={8} mt="md">
                <Text size="sm">当前版本：{check.qclaw.currentVersion}</Text>
                <Text size="sm">可用版本：{check.qclaw.availableVersion || '暂无'}</Text>
                <Text size="sm">自动更新：{check.qclaw.configured ? '支持' : '当前不可自动执行'}</Text>
              </Stack>
            </Paper>
          </SimpleGrid>

          {(check.warnings.length > 0 || error) && (
            <Alert color="yellow" variant="light" mt="md">
              {check.warnings.map((warning) => (
                <Text key={warning} size="sm" lh={1.6}>
                  {warning}
                </Text>
              ))}
              {error && <Text size="sm" lh={1.6}>{error}</Text>}
            </Alert>
          )}

          {result && (
            <Alert color={result.ok ? 'green' : 'red'} variant="light" mt="md">
              <Text size="sm" fw={500}>{result.message || (result.ok ? '组合更新已开始。' : '组合更新失败。')}</Text>
              {result.openclawResult?.backupCreated && (
                <Text size="xs" mt="xs" style={{ wordBreak: 'break-all' }}>
                  OpenClaw 升级前快照：{result.openclawResult.backupCreated.archivePath}
                </Text>
              )}
            </Alert>
          )}

          <Group mt="xl">
            <Button
              variant="default"
              size="sm"
              onClick={() => void loadCheck()}
              disabled={loading || running}
            >
              刷新状态
            </Button>
            <Button
              color="green"
              size="sm"
              onClick={() => void handleRun()}
              disabled={running || !check.canRun}
            >
              {running ? '执行中...' : '开始组合更新'}
            </Button>
          </Group>
        </>
      )}
    </Modal>
  )

  async function handleRun() {
    setRunning(true)
    setResult(null)
    setError('')
    try {
      const nextResult = await window.api.runCombinedUpdate()
      setResult(nextResult)
      if (nextResult.ok) {
        onUpdated?.()
      }
    } catch (e: any) {
      setError(e?.message || '执行组合更新失败')
    } finally {
      setRunning(false)
    }
  }
}
