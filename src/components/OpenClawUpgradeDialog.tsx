import { useEffect, useState } from 'react'
import { Alert, Button, Group, Loader, Modal, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import type { OpenClawUpgradeCheckResult, OpenClawUpgradeRunResult } from '../shared/openclaw-phase4'

export default function OpenClawUpgradeDialog({
  open,
  onClose,
  onUpdated,
}: {
  open: boolean
  onClose: () => void
  onUpdated?: () => void
}) {
  const [check, setCheck] = useState<OpenClawUpgradeCheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<OpenClawUpgradeRunResult | null>(null)
  const [error, setError] = useState('')

  const loadCheck = async () => {
    setLoading(true)
    setError('')
    try {
      const nextCheck = await window.api.checkOpenClawUpgrade()
      setCheck(nextCheck)
    } catch (e: any) {
      setError(e?.message || '读取 OpenClaw 升级状态失败')
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

  const canRun = Boolean(
    check &&
      check.enforcement === 'optional_upgrade' &&
      check.targetVersion
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
            OpenClaw Upgrade
          </Text>
          <Title order={3} mt="xs">只升级 OpenClaw</Title>
        </div>
      }
    >
      {!check || loading ? (
        <Alert color="green" variant="light" mt="md">
          <Group gap="sm">
            <Loader size="sm" />
            <Text size="sm">正在检查 OpenClaw 升级状态...</Text>
          </Group>
        </Alert>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" mt="md">
            <Paper withBorder radius="xl" p="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.2em' }}>
                当前安装
              </Text>
              <Stack gap={8} mt="md">
                <Text size="sm">当前版本：{check.currentVersion || '未知'}</Text>
                <Text size="sm">目标版本：{check.targetVersion || '未知'}</Text>
                <Text size="sm">安装来源：{check.activeCandidate?.installSource || '未知'}</Text>
                <Text size="sm" style={{ wordBreak: 'break-all' }}>
                  当前路径：{check.activeCandidate?.binaryPath || '未检测到'}
                </Text>
              </Stack>
            </Paper>

            <Paper withBorder radius="xl" p="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.2em' }}>
                升级承诺
              </Text>
              <Stack gap={8} mt="md">
                <Text size="sm">不新装第二份 OpenClaw</Text>
                <Text size="sm">不迁移数据目录和配置路径</Text>
                <Text size="sm">升级前自动创建配置快照</Text>
                <Text size="sm">
                  {check.gatewayRunning ? '升级后会尝试恢复 Gateway 运行态' : '当前 Gateway 未运行，不需要恢复'}
                </Text>
              </Stack>
            </Paper>
          </SimpleGrid>

          {check.policyState === 'supported_target' && (
            <Alert color="green" variant="light" mt="md">
              当前 OpenClaw 版本正常，无需升级。
            </Alert>
          )}

          {check.policyState === 'supported_not_target' && (
            <Alert color="blue" variant="light" mt="md">
              当前版本受支持，可按需升级到 {check.targetVersion || '2026.3.24'}。
            </Alert>
          )}

          {check.enforcement === 'auto_correct' && (
            <Alert color="yellow" variant="light" mt="md">
              当前版本超出受支持策略，请先回到环境检查页，由启动阶段完成备份后再自动纠偏到 {check.targetVersion || '2026.3.24'}。
            </Alert>
          )}

          {(check.warnings.length > 0 || check.manualHint || error) && (
            <Alert color="yellow" variant="light" mt="md">
              {check.warnings.map((warning) => (
                <Text key={warning} size="sm" lh={1.6}>
                  {warning}
                </Text>
              ))}
              {check.manualHint && <Text size="sm" lh={1.6}>{check.manualHint}</Text>}
              {error && <Text size="sm" lh={1.6}>{error}</Text>}
            </Alert>
          )}

          {result && (
            <Alert color={result.ok ? 'green' : 'red'} variant="light" mt="md">
              <Text size="sm" fw={500}>{result.message || (result.ok ? '升级完成。' : '升级失败。')}</Text>
              {result.backupCreated && (
                <Text size="xs" mt="xs" style={{ wordBreak: 'break-all' }}>
                  升级前快照：{result.backupCreated.archivePath}
                </Text>
              )}
              {result.warnings.map((warning) => (
                <Text key={warning} size="xs" mt={4} lh={1.5}>
                  {warning}
                </Text>
              ))}
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
              onClick={() => void handleRunUpgrade()}
              disabled={running || !canRun}
            >
              {running ? '处理中...' : '升级当前 OpenClaw'}
            </Button>
          </Group>
        </>
      )}
    </Modal>
  )

  async function handleRunUpgrade() {
    setRunning(true)
    setResult(null)
    setError('')
    try {
      const nextResult = await window.api.runOpenClawUpgrade()
      setResult(nextResult)
      if (nextResult.ok) {
        onUpdated?.()
        await loadCheck()
      }
    } catch (e: any) {
      setError(e?.message || '执行 OpenClaw 升级失败')
    } finally {
      setRunning(false)
    }
  }
}
