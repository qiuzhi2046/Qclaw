import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
  Tooltip,
  ActionIcon,
  useComputedColorScheme,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import {
  IconPlus,
  IconRefresh,
  IconTrash,
  IconGitBranch,
  IconCloudUpload,
  IconFolder,
  IconFileText,
  IconCheck,
  IconX,
  IconBook2,
  IconInfoCircle,
} from '@tabler/icons-react'
import tooltips from '@/constants/tooltips.json'

interface KnowledgeBaseStatus {
  id: string
  name: string
  localPath: string
  exists: boolean
  gitRemote: string
  gitInitialized: boolean
  hasRemote: boolean
  mdFileCount: number
  lastSyncMessage: string
}

export default function KnowledgeBasePage() {
  const computedColorScheme = useComputedColorScheme('dark')
  const isDark = computedColorScheme === 'dark'

  const [statuses, setStatuses] = useState<KnowledgeBaseStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [editingGit, setEditingGit] = useState<string | null>(null)
  const [gitUrlDraft, setGitUrlDraft] = useState('')
  const [savingGit, setSavingGit] = useState(false)
  const [adding, setAdding] = useState(false)

  const fetchStatuses = useCallback(async (options?: { background?: boolean }) => {
    const background = Boolean(options?.background)
    try {
      if (!background) setLoading(true)
      setError('')
      const result = await window.api.knowledgeStatuses()
      setStatuses(Array.isArray(result) ? result : [])
    } catch (e: any) {
      setError(e.message || '获取知识库列表失败')
    } finally {
      if (!background) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchStatuses()
  }, [fetchStatuses])

  const handleAdd = async () => {
    try {
      setAdding(true)
      setError('')
      const folderPath = await window.api.knowledgeSelectFolder()
      if (!folderPath) {
        setAdding(false)
        return
      }
      const result = await window.api.knowledgeAdd(folderPath)
      if (result.ok) {
        setNotice(result.message || '知识库添加成功')
        await fetchStatuses({ background: true })
      } else {
        setError(result.message || '添加知识库失败')
      }
    } catch (e: any) {
      setError(e.message || '添加知识库失败')
    } finally {
      setAdding(false)
    }
  }

  const handleRemove = (status: KnowledgeBaseStatus) => {
    modals.openConfirmModal({
      title: '确认移除知识库',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            确定要移除知识库 <Code>{status.name}</Code> 吗？
          </Text>
          <Text size="xs" c="dimmed">
            此操作只会取消挂载，不会删除原始文件夹中的文件。
          </Text>
        </Stack>
      ),
      labels: { confirm: '移除', cancel: '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const result = await window.api.knowledgeRemove(status.id)
          if (result.ok) {
            setNotice(result.message || '知识库已移除')
            await fetchStatuses({ background: true })
          } else {
            setError(result.message || '移除知识库失败')
          }
        } catch (e: any) {
          setError(e.message || '移除知识库失败')
        }
      },
    })
  }

  const handleSaveGit = async (id: string) => {
    try {
      setSavingGit(true)
      const result = await window.api.knowledgeSetGit(id, gitUrlDraft)
      if (result.ok) {
        setNotice(result.message || 'Git 地址已保存')
        setEditingGit(null)
        setGitUrlDraft('')
        await fetchStatuses({ background: true })
      } else {
        setError(result.message || '保存 Git 地址失败')
      }
    } catch (e: any) {
      setError(e.message || '保存 Git 地址失败')
    } finally {
      setSavingGit(false)
    }
  }

  const handleSync = async (id: string) => {
    try {
      setSyncing(id)
      setError('')
      setNotice('')
      const result = await window.api.knowledgeSync(id)
      if (result.ok) {
        setNotice(result.message || '同步完成')
      } else {
        setError(result.message || '同步失败')
      }
      await fetchStatuses({ background: true })
    } catch (e: any) {
      setError(e.message || '同步失败')
    } finally {
      setSyncing(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader size="md" />
      </div>
    )
  }

  return (
    <div className="p-6 h-full overflow-y-auto">
      {/* Header */}
      <Group justify="space-between" mb="xs">
        <div>
          <Tooltip label={tooltips.knowledgePage.overview} withArrow multiline maw={360}>
            <h1 className="text-xl font-bold app-text-primary inline-block">知识库</h1>
          </Tooltip>
          <Text size="xs" c="dimmed">管理本地 Markdown 知识库，让 AI 能参考你的文档</Text>
        </div>
        <Group gap="xs">
          <Tooltip label={tooltips.knowledgePage.refresh} withArrow>
            <ActionIcon
              variant="subtle"
              size="lg"
              loading={refreshing}
              onClick={async () => {
                setRefreshing(true)
                try {
                  await fetchStatuses({ background: true })
                } finally {
                  setRefreshing(false)
                }
              }}
              className="cursor-pointer"
            >
              <IconRefresh size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={tooltips.knowledgePage.addFolder} withArrow>
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              loading={adding}
              onClick={handleAdd}
              className="cursor-pointer"
            >
              添加知识库
            </Button>
          </Tooltip>
        </Group>
      </Group>

      {/* Alerts */}
      {error && (
        <Alert color="red" mb="md" onClose={() => setError('')} withCloseButton>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert color="blue" mb="md" onClose={() => setNotice('')} withCloseButton>
          {notice}
        </Alert>
      )}

      {/* How it works */}
      <Paper
        withBorder
        radius="lg"
        mb="md"
        p="md"
        bg={isDark ? 'dark.6' : 'gray.0'}
      >
        <Group gap="xs" mb={6}>
          <IconInfoCircle size={16} className="app-text-muted" />
          <Text size="sm" fw={600} className="app-text-primary">
            使用说明
          </Text>
        </Group>
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            1. 点击「添加知识库」选择一个包含 Markdown 文件的文件夹
          </Text>
          <Text size="xs" c="dimmed">
            2. 文件夹路径会自动注册到 OpenClaw 的记忆搜索路径（extraPaths）
          </Text>
          <Text size="xs" c="dimmed">
            3. OpenClaw 对话时会通过向量搜索自动参考知识库中的文档内容
          </Text>
          <Text size="xs" c="dimmed">
            4. 可选：配置 Git 地址后，点击「同步」可一键拉取远程更新 + 推送本地变更
          </Text>
        </Stack>
      </Paper>

      {/* Knowledge Base List */}
      {statuses.length === 0 ? (
        <Paper
          withBorder
          radius="lg"
          p="xl"
          className="flex flex-col items-center justify-center"
          bg={isDark ? 'dark.6' : 'gray.0'}
        >
          <IconBook2 size={48} className="app-text-muted mb-3" stroke={1.2} />
          <Text size="sm" fw={500} className="app-text-secondary mb-1">
            暂无知识库
          </Text>
          <Text size="xs" c="dimmed" ta="center" maw={300}>
            添加一个包含 Markdown 文件的文件夹，让 OpenClaw 在对话时自动搜索参考你的文档。
          </Text>
          <Button
            mt="md"
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            loading={adding}
            onClick={handleAdd}
            className="cursor-pointer"
          >
            添加第一个知识库
          </Button>
        </Paper>
      ) : (
        <Stack gap="sm">
          {statuses.map((status) => (
            <Paper
              key={status.id}
              withBorder
              radius="lg"
              p="md"
              bg={isDark ? 'dark.6' : 'gray.0'}
              style={{ transition: 'border-color 0.2s ease, box-shadow 0.2s ease' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--app-hover-border)'
                e.currentTarget.style.boxShadow = '0 0 12px var(--app-hover-glow)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = ''
                e.currentTarget.style.boxShadow = ''
              }}
            >
              {/* Row 1: Name + status + actions */}
              <Group justify="space-between" mb={8}>
                <Group gap="sm">
                  <IconFolder size={18} className="app-text-muted" />
                  <Text size="sm" fw={600} className="app-text-primary">
                    {status.name}
                  </Text>
                  {status.exists ? (
                    <Badge size="xs" variant="light" color="green" leftSection={<IconCheck size={10} />}>
                      可用
                    </Badge>
                  ) : (
                    <Badge size="xs" variant="light" color="red" leftSection={<IconX size={10} />}>
                      路径无效
                    </Badge>
                  )}
                  <Badge size="xs" variant="light" color="gray">
                    <IconFileText size={10} style={{ marginRight: 4, display: 'inline' }} />
                    {status.mdFileCount} 个 Markdown 文件
                  </Badge>
                </Group>
                <Group gap="xs">
                  {status.gitRemote && (
                    <Tooltip label={tooltips.knowledgePage.syncButton} withArrow>
                      <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconCloudUpload size={14} />}
                        loading={syncing === status.id}
                        disabled={!status.exists}
                        onClick={() => handleSync(status.id)}
                        className="cursor-pointer"
                      >
                        同步
                      </Button>
                    </Tooltip>
                  )}
                  <Tooltip label={tooltips.knowledgePage.removeKb} withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="sm"
                      onClick={() => handleRemove(status)}
                      className="cursor-pointer"
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>

              {/* Row 2: Path */}
              <Text size="xs" c="dimmed" mb={6}>
                <Code>{status.localPath}</Code>
              </Text>

              {/* Row 3: Git config */}
              {editingGit === status.id ? (
                <Group gap="xs">
                  <TextInput
                    size="xs"
                    placeholder="https://github.com/user/repo.git"
                    value={gitUrlDraft}
                    onChange={(e) => setGitUrlDraft(e.target.value)}
                    style={{ flex: 1 }}
                    classNames={{ input: 'app-input' }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveGit(status.id)
                      if (e.key === 'Escape') {
                        setEditingGit(null)
                        setGitUrlDraft('')
                      }
                    }}
                  />
                  <Button
                    size="xs"
                    variant="light"
                    loading={savingGit}
                    onClick={() => handleSaveGit(status.id)}
                    className="cursor-pointer"
                  >
                    保存
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => {
                      setEditingGit(null)
                      setGitUrlDraft('')
                    }}
                    className="cursor-pointer"
                  >
                    取消
                  </Button>
                </Group>
              ) : (
                <Group gap="xs">
                  <IconGitBranch size={14} className="app-text-muted" />
                  {status.gitRemote ? (
                    <>
                      <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                        <Code>{status.gitRemote}</Code>
                      </Text>
                      <Tooltip label={tooltips.knowledgePage.gitConfig} withArrow>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          onClick={() => {
                            setEditingGit(status.id)
                            setGitUrlDraft(status.gitRemote)
                          }}
                          className="cursor-pointer"
                        >
                          修改
                        </Button>
                      </Tooltip>
                    </>
                  ) : (
                    <Tooltip label={tooltips.knowledgePage.gitConfig} withArrow>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() => {
                          setEditingGit(status.id)
                          setGitUrlDraft('')
                        }}
                        className="cursor-pointer"
                      >
                        配置 Git 地址
                      </Button>
                    </Tooltip>
                  )}
                </Group>
              )}
            </Paper>
          ))}
        </Stack>
      )}
    </div>
  )
}
