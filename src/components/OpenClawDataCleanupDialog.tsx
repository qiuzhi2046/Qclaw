import { useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Checkbox, Group, Loader, Modal, ScrollArea, Text, Title } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconRefresh } from '@tabler/icons-react'
import type { OpenClawDiscoveryResult } from '../shared/openclaw-phase1'
import type { OpenClawBackupEntry, OpenClawBackupListResult } from '../shared/openclaw-phase3'

function backupTypeLabel(type: OpenClawBackupEntry['type']): string {
  if (type === 'baseline-backup') return '基线备份'
  if (type === 'manual-backup') return '手动备份'
  if (type === 'config-snapshot') return '配置快照'
  if (type === 'cleanup-backup') return '清理前备份'
  if (type === 'restore-preflight') return '恢复前快照'
  if (type === 'upgrade-preflight') return '升级前快照'
  return '未知类型'
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes()
    ).padStart(2, '0')}`
  } catch {
    return iso
  }
}

function hasBaselineBackup(entries: Array<Pick<OpenClawBackupEntry, 'type'>>): boolean {
  return entries.some((entry) => entry.type === 'baseline-backup')
}

export function buildBackupDeleteConfirmMessage(
  backup: Pick<OpenClawBackupEntry, 'type' | 'createdAt'>
): string {
  const baseMessage = `将删除备份「${backupTypeLabel(backup.type)} · ${formatTime(backup.createdAt)}」。删除后不可恢复。`
  if (backup.type !== 'baseline-backup') return baseMessage
  return `${baseMessage} 删除后系统会转为手动备份责任，后续配置文件仍可修改，但基线恢复需由您自行负责。`
}

export function buildDeleteAllBackupsConfirmMessage(
  backups: Array<Pick<OpenClawBackupEntry, 'type'>>
): string {
  const baseMessage = '将删除全部 OpenClaw 备份。此操作不可恢复。'
  if (!hasBaselineBackup(backups)) return baseMessage
  return `${baseMessage} 其中包含基线备份；删除后系统会转为手动备份责任，后续配置文件仍可修改，但基线恢复需由您自行负责。`
}

function notifyDeleteWarnings(warnings: string[]) {
  if (warnings.length === 0) return
  notifications.show({
    title: '需要注意',
    message: warnings.join('；'),
    color: 'yellow',
  })
}

type DataTarget = {
  key: string
  path: string
  displayPath: string
  active: boolean
  source: 'candidate' | 'history'
  candidateCount: number
  installSources: string[]
}

type ConfirmState =
  | { kind: 'path'; target: DataTarget }
  | { kind: 'backup'; backup: OpenClawBackupEntry }
  | { kind: 'all-backups' }
  | null

function normalizePathKey(value: string): string {
  return window.navigator.userAgent.includes('Windows')
    ? String(value || '').trim().toLowerCase()
    : String(value || '').trim()
}

function buildDataTargets(discovery: OpenClawDiscoveryResult | null): DataTarget[] {
  const targets = new Map<string, DataTarget>()

  for (const candidate of discovery?.candidates || []) {
    const path = String(candidate.stateRoot || '').trim()
    if (!path) continue
    const key = normalizePathKey(path)
    const existing = targets.get(key)
    if (existing) {
      existing.active = existing.active || candidate.isPathActive
      existing.candidateCount += 1
      if (!existing.installSources.includes(candidate.installSource)) {
        existing.installSources.push(candidate.installSource)
      }
      continue
    }

    targets.set(key, {
      key,
      path,
      displayPath: String(candidate.displayStateRoot || path).trim() || path,
      active: candidate.isPathActive,
      source: 'candidate',
      candidateCount: 1,
      installSources: [candidate.installSource],
    })
  }

  for (const item of discovery?.historyDataCandidates || []) {
    const path = String(item.path || '').trim()
    if (!path) continue
    const key = normalizePathKey(path)
    if (targets.has(key)) continue
    targets.set(key, {
      key,
      path,
      displayPath: String(item.displayPath || path).trim() || path,
      active: false,
      source: 'history',
      candidateCount: 0,
      installSources: [],
    })
  }

  return Array.from(targets.values()).sort((left, right) => {
    if (left.active && !right.active) return -1
    if (!left.active && right.active) return 1
    return left.displayPath.localeCompare(right.displayPath)
  })
}

export default function OpenClawDataCleanupDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [discovery, setDiscovery] = useState<OpenClawDiscoveryResult | null>(null)
  const [backupData, setBackupData] = useState<OpenClawBackupListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [deletingPath, setDeletingPath] = useState<string | null>(null)
  const [deletingBackupId, setDeletingBackupId] = useState<string | null>(null)
  const [deletingAllBackups, setDeletingAllBackups] = useState(false)
  const [confirmState, setConfirmState] = useState<ConfirmState>(null)
  const [backupBeforeDelete, setBackupBeforeDelete] = useState(true)

  const loadData = async () => {
    setLoading(true)
    setError('')
    try {
      const [nextDiscovery, nextBackups] = await Promise.all([
        window.api.discoverOpenClaw().catch(() => null),
        window.api.listOpenClawBackups(),
      ])
      setDiscovery(nextDiscovery)
      setBackupData(nextBackups)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void loadData()
  }, [open])

  const dataTargets = useMemo(() => buildDataTargets(discovery), [discovery])
  const backupEntries = backupData?.entries || []

  if (!open) return null

  const handleDeletePath = async (target: DataTarget) => {
    setDeletingPath(target.path)
    setError('')
    try {
      const result = await window.api.runOpenClawDataCleanup({
        targetPath: target.path,
        backupBeforeDelete,
      })
      if (!result.ok) {
        setError(result.message || '删除 OpenClaw 数据失败')
        return
      }

      notifications.show({
        title: '删除完成',
        message:
          result.message ||
          (result.backupCreated
            ? `已为 ${target.displayPath} 创建清理前备份并完成删除`
            : `已删除 ${target.displayPath}`),
        color: 'brand',
      })
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingPath(null)
    }
  }

  const handleDeleteBackup = async (entry: OpenClawBackupEntry) => {
    setDeletingBackupId(entry.backupId)
    setError('')
    try {
      const result = await window.api.deleteOpenClawBackup(entry.backupId)
      if (!result.ok) {
        setError(result.message || result.errors[0] || '删除备份失败')
        return
      }

      notifications.show({
        title: '删除完成',
        message: result.message || '备份已删除',
        color: 'brand',
      })
      notifyDeleteWarnings(result.warnings || [])
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingBackupId(null)
    }
  }

  const handleDeleteAllBackups = async () => {
    setDeletingAllBackups(true)
    setError('')
    try {
      const result = await window.api.deleteAllOpenClawBackups()
      if (!result.ok) {
        setError(result.message || result.errors[0] || '删除全部备份失败')
        return
      }

      notifications.show({
        title: '删除完成',
        message: result.message || '已删除全部备份',
        color: 'brand',
      })
      notifyDeleteWarnings(result.warnings || [])
      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingAllBackups(false)
    }
  }

  const confirmTitle =
    confirmState?.kind === 'path'
      ? '确认删除 OpenClaw 数据'
      : confirmState?.kind === 'backup'
        ? '确认删除备份'
        : '确认删除全部备份'
  const confirmMessage =
    confirmState?.kind === 'path'
      ? `将删除 ${confirmState.target.displayPath} 下的 OpenClaw 数据目录。此操作不会卸载 OpenClaw 程序，且删除后不可恢复。${
          backupBeforeDelete ? '执行前会额外创建一次清理前备份。' : ''
        }`
      : confirmState?.kind === 'backup'
        ? buildBackupDeleteConfirmMessage(confirmState.backup)
        : buildDeleteAllBackupsConfirmMessage(backupEntries)
  const confirmLoading =
    confirmState?.kind === 'path'
      ? deletingPath === confirmState.target.path
      : confirmState?.kind === 'backup'
        ? deletingBackupId === confirmState.backup.backupId
        : deletingAllBackups

  const handleConfirm = async () => {
    if (!confirmState) return

    if (confirmState.kind === 'path') {
      await handleDeletePath(confirmState.target)
    } else if (confirmState.kind === 'backup') {
      await handleDeleteBackup(confirmState.backup)
    } else {
      await handleDeleteAllBackups()
    }

    setConfirmState(null)
  }

  return (
    <Modal opened={open} onClose={onClose} title="清理 OpenClaw 数据" size="xl" centered>
      <Group justify="space-between" mb="sm">
        <Text size="sm" c="dimmed">
          这里只处理数据目录与备份，不会卸载 OpenClaw 程序。
        </Text>
        <Button
          variant="subtle"
          size="compact-sm"
          leftSection={<IconRefresh size={14} />}
          onClick={() => void loadData()}
          loading={loading}
        >
          刷新
        </Button>
      </Group>

      {error && (
        <Alert color="red" variant="light" mb="sm" onClose={() => setError('')} withCloseButton>
          {error}
        </Alert>
      )}

      {loading ? (
        <div className="flex items-center gap-3 py-8">
          <Loader size="sm" color="brand" />
          <Text size="sm" c="dimmed">正在读取数据目录与备份信息...</Text>
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <Group justify="space-between" mb="xs">
              <Title order={4} size="sm">OpenClaw 数据目录</Title>
            </Group>
            <Checkbox
              mb="sm"
              label="删除数据目录前先额外创建一次清理前备份"
              checked={backupBeforeDelete}
              onChange={(event) => setBackupBeforeDelete(event.currentTarget.checked)}
              size="sm"
            />
            <ScrollArea.Autosize mah={240}>
              {dataTargets.length === 0 ? (
                <Text size="sm" c="dimmed" py="md">
                  当前未检测到可删除的 OpenClaw 数据目录。
                </Text>
              ) : (
                <div className="space-y-2">
                  {dataTargets.map((target) => (
                    <Group
                      key={target.key}
                      justify="space-between"
                      align="flex-start"
                      wrap="nowrap"
                      className="rounded-lg border app-border px-3 py-3"
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <Group gap="xs" wrap="wrap" mb={4}>
                          <Text size="sm" fw={600} className="app-text-primary">
                            {target.displayPath}
                          </Text>
                          {target.active && <Badge size="xs" variant="light" color="green">当前生效</Badge>}
                          {target.source === 'history' && (
                            <Badge size="xs" variant="light" color="gray">历史残留</Badge>
                          )}
                          {target.candidateCount > 1 && (
                            <Badge size="xs" variant="light" color="yellow">多个安装共用</Badge>
                          )}
                        </Group>
                        {target.installSources.length > 0 && (
                          <Text size="xs" c="dimmed">
                            安装来源：{target.installSources.join(' / ')}
                          </Text>
                        )}
                      </div>
                      <Button
                        color="red"
                        variant="light"
                        size="compact-sm"
                        loading={deletingPath === target.path}
                        onClick={() => setConfirmState({ kind: 'path', target })}
                      >
                        删除数据
                      </Button>
                    </Group>
                  ))}
                </div>
              )}
            </ScrollArea.Autosize>
          </div>

          <div>
            <Group justify="space-between" mb="xs">
              <Title order={4} size="sm">备份</Title>
              <Button
                color="red"
                variant="light"
                size="compact-sm"
                loading={deletingAllBackups}
                disabled={backupEntries.length === 0}
                onClick={() => setConfirmState({ kind: 'all-backups' })}
              >
                删除全部备份
              </Button>
            </Group>
            <ScrollArea.Autosize mah={280}>
              {backupEntries.length === 0 ? (
                <Text size="sm" c="dimmed" py="md">
                  当前没有可删除的备份。
                </Text>
              ) : (
                <div className="space-y-2">
                  {backupEntries.map((entry) => (
                    <Group
                      key={entry.backupId}
                      justify="space-between"
                      wrap="nowrap"
                      className="rounded-lg border app-border px-3 py-3"
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <Text size="sm" fw={600} className="app-text-primary">
                          {backupTypeLabel(entry.type)}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {formatTime(entry.createdAt)}
                        </Text>
                      </div>
                      <Button
                        color="red"
                        variant="light"
                        size="compact-sm"
                        loading={deletingBackupId === entry.backupId}
                        onClick={() => setConfirmState({ kind: 'backup', backup: entry })}
                      >
                        删除备份
                      </Button>
                    </Group>
                  ))}
                </div>
              )}
            </ScrollArea.Autosize>
          </div>
        </div>
      )}

      <Modal
        opened={Boolean(confirmState)}
        onClose={() => setConfirmState(null)}
        centered
        size="sm"
        title={
          <Text fw={600} c="red">
            {confirmTitle}
          </Text>
        }
      >
        <Text size="sm" className="app-text-secondary">
          {confirmMessage}
        </Text>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="default" size="sm" onClick={() => setConfirmState(null)} disabled={confirmLoading}>
            取消
          </Button>
          <Button color="red" size="sm" loading={confirmLoading} onClick={() => void handleConfirm()}>
            确认删除
          </Button>
        </div>
      </Modal>
    </Modal>
  )
}
