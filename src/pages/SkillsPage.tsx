import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Modal,
  Group,
  Stack,
  Text,
  Anchor,
  Loader,
  Alert,
  Switch,
  Tooltip,
  ActionIcon,
  Code,
  TextInput,
  Button,
  Collapse,
  Paper,
  useComputedColorScheme,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import {
  IconTrash,
  IconSearch,
  IconRefresh,
  IconChevronRight,
  IconDownload,
  IconSparkles,
  IconWorld,
  IconTerminal2,
  IconKey,
  IconCopy,
  IconCheck,
} from '@tabler/icons-react'
import { createPageDataCache } from '../lib/page-data-cache'
import { toUserFacingCliFailureMessage, toUserFacingUnknownErrorMessage } from '../lib/user-facing-cli-feedback'
import tooltips from '@/constants/tooltips.json'

interface SkillMissing {
  bins: string[]
  anyBins: string[]
  env: string[]
  config: string[]
  os: string[]
}

interface SkillInstallStep {
  id: string
  kind: string
  label: string
  bins: string[]
}

interface SkillInfo {
  name: string
  description: string
  source: string
  eligible: boolean
  disabled: boolean
  skillKey: string
  blockedByAllowlist?: boolean
  bundled?: boolean
  homepage?: string
  emoji?: string
  primaryEnv?: string
  apiKeys?: string[]
  configKeys?: string[]
  requires?: string[]
  installTarget?: string
  location?: string
  path?: string
  missing?: SkillMissing
  install?: SkillInstallStep[]
}

interface SkillLocations {
  workspaceDir?: string
  workspaceSkillsDir?: string
  managedSkillsDir?: string
  clawhubWorkdir?: string
  clawhubDir?: string
}

interface ActiveSkillInstall {
  key: string
  label: string
}

interface SkillsPageSnapshot {
  skills: SkillInfo[]
  locations?: SkillLocations
}

const SOURCE_LABELS: Record<string, string> = {
  'openclaw-bundled': '内置 Skills',
  'openclaw-extra': '插件扩展 Skills',
  'openclaw-managed': '共享已安装 Skills',
  'openclaw-workspace': '当前工作区 Skills',
  'openclaw-personal': '个人 Skills',
  'agents-skills-personal': '.agents 个人 Skills',
  'agents-skills-project': '.agents 项目 Skills',
}

const SOURCE_TOOLTIPS: Record<string, string> = {
  'openclaw-bundled': tooltips.skillsPage.sources.bundled,
  'openclaw-extra': tooltips.skillsPage.sources.extra,
  'openclaw-workspace': tooltips.skillsPage.sources.workspace,
}

interface RecommendedSkill {
  name: string
  slug: string
  description: string
}

const RECOMMENDED_SKILLS: RecommendedSkill[] = [
  {
    name: 'token-optimizer',
    slug: 'token-optimizer',
    description: '智能优化 Token 使用，节省 API 费用',
  },
  {
    name: 'prompt-injection-guard',
    slug: 'prompt-injection-guard',
    description: '检测和拦截恶意 Prompt 注入攻击',
  },
]

const SKILLS_PAGE_CACHE_TTL_MS = 60 * 1000
const skillsPageCache = createPageDataCache<SkillsPageSnapshot>({ ttlMs: SKILLS_PAGE_CACHE_TTL_MS })

function normalizeSkillLocations(input: unknown): SkillLocations {
  if (!input || typeof input !== 'object') return {}

  const value = input as Record<string, unknown>
  return {
    workspaceDir: typeof value.workspaceDir === 'string' ? value.workspaceDir : undefined,
    workspaceSkillsDir: typeof value.workspaceSkillsDir === 'string' ? value.workspaceSkillsDir : undefined,
    managedSkillsDir: typeof value.managedSkillsDir === 'string' ? value.managedSkillsDir : undefined,
    clawhubWorkdir: typeof value.clawhubWorkdir === 'string' ? value.clawhubWorkdir : undefined,
    clawhubDir: typeof value.clawhubDir === 'string' ? value.clawhubDir : undefined,
  }
}

export default function SkillsPage() {
  const computedColorScheme = useComputedColorScheme('dark')
  const initialSnapshotRef = useRef<SkillsPageSnapshot | null>(skillsPageCache.get()?.data || null)
  const initialSnapshot = initialSnapshotRef.current
  const [skills, setSkills] = useState<SkillInfo[]>(initialSnapshot?.skills || [])
  const [skillLocations, setSkillLocations] = useState<SkillLocations>(
    initialSnapshot?.locations || {}
  )
  const [loading, setLoading] = useState(!initialSnapshot)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showDetailModal, setShowDetailModal] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(null)
  const [uninstalling, setUninstalling] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const deferredSearch = useDeferredValue(searchQuery)
  const [installing, setInstalling] = useState<ActiveSkillInstall | null>(null)
  const [cancelingInstall, setCancelingInstall] = useState(false)
  const [searchMode, setSearchMode] = useState<'local' | 'clawhub'>('local')
  const [clawhubResults, setClawhubResults] = useState<{ slug: string; name: string; score: number }[]>([])
  const [clawhubSearching, setClawhubSearching] = useState(false)
  const [installingBin, setInstallingBin] = useState<string | null>(null)
  const [installLog, setInstallLog] = useState<string[]>([])
  const [installingBrew, setInstallingBrew] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [scanDirectoriesCollapsed, setScanDirectoriesCollapsed] = useState(true)
  const skillInstallUiLocked = Boolean(installing) || cancelingInstall

  // Collapsed state for each source
  const [collapsedSources, setCollapsedSources] = useState<Record<string, boolean>>({
    'openclaw-bundled': true,
    'openclaw-extra': true,
  })

  const fetchSkills = useCallback(async (options?: { background?: boolean }) => {
    const background = Boolean(options?.background)
    try {
      if (!background) {
        setLoading(true)
      }
      setError('')
      const result = await window.api.skillsList()
      if (result.ok && result.stdout) {
        const parsed = JSON.parse(result.stdout) as SkillsPageSnapshot & SkillLocations
        const nextSkills = Array.isArray(parsed.skills) ? parsed.skills : []
        const nextLocations = normalizeSkillLocations(parsed)
        setSkills(nextSkills)
        setSkillLocations(nextLocations)
        skillsPageCache.set({ skills: nextSkills, locations: nextLocations })
      } else {
        setError(
          toUserFacingCliFailureMessage({
            stderr: result.stderr,
            stdout: result.stdout,
            fallback: '获取 Skills 列表失败，请稍后重试。',
          })
        )
      }
    } catch (e) {
      setError(toUserFacingUnknownErrorMessage(e, '获取 Skills 列表失败，请稍后重试。'))
    } finally {
      if (!background) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void fetchSkills({ background: Boolean(initialSnapshot) })
  }, [fetchSkills, initialSnapshot])

  const handleToggle = async (skill: SkillInfo, enabled: boolean) => {
    if (skillInstallUiLocked) return
    // When enabling a skill that has missing deps, show manual install instructions
    if (enabled) {
      if (hasMissing(skill)) {
        showMissingDepsModal(skill)
        return
      }
    }
    try {
      const result = await window.api.skillsUpdate({
        skillKey: skill.skillKey,
        enabled,
      })
      if (result.ok) {
        await fetchSkills({ background: true })
      } else {
        setError(
          toUserFacingCliFailureMessage({
            stderr: result.error || '',
            fallback: '切换 Skill 失败，请稍后重试。',
          })
        )
      }
    } catch (e) {
      setError(toUserFacingUnknownErrorMessage(e, '切换 Skill 失败，请稍后重试。'))
    }
  }

  const showMissingDepsModal = (skill: SkillInfo) => {
    const missing = skill.missing!
    const missingBins = [...missing.bins, ...missing.anyBins]
    const missingEnv = missing.env
    const missingConfig = missing.config

    modals.open({
      title: `${skill.name} 缺少依赖`,
      size: 'md',
      children: (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            该 Skill 需要以下依赖才能启用，请在终端中手动安装：
          </Text>

          {missingBins.length > 0 && (
            <div>
              <Group gap="xs" mb={4}>
                <IconTerminal2 size={14} />
                <Text size="sm" fw={500}>缺少命令行工具</Text>
              </Group>
              {missingBins.map((bin) => (
                <CopyableCodeBlock
                  key={bin}
                  value={`brew install ${bin}`}
                />
              ))}
              <Text size="xs" c="dimmed" mt={4}>
                如果 brew install 找不到包，请尝试搜索正确的包名：brew search {missingBins[0]}
              </Text>
            </div>
          )}

          {missingEnv.length > 0 && (
            <div>
              <Group gap="xs" mb={4}>
                <IconKey size={14} />
                <Text size="sm" fw={500}>缺少环境变量</Text>
              </Group>
              {missingEnv.map((envKey) => (
                <CopyableCodeBlock
                  key={envKey}
                  value={`echo '${envKey}=你的值' >> ~/.openclaw/.env`}
                />
              ))}
            </div>
          )}

          {missingConfig.length > 0 && (
            <div>
              <Group gap="xs" mb={4}>
                <IconKey size={14} />
                <Text size="sm" fw={500}>缺少配置项</Text>
              </Group>
              <Text size="xs" c="dimmed">
                请在 ~/.openclaw/openclaw.json 中添加以下配置：
              </Text>
              {missingConfig.map((key) => (
                <CopyableCodeBlock
                  key={key}
                  value={key}
                />
              ))}
            </div>
          )}

          <Text size="xs" c="dimmed">
            安装完成后，点击刷新按钮重新检测依赖状态。
          </Text>
        </Stack>
      ),
    })
  }

  const handleUninstall = async (skill: SkillInfo) => {
    if (skillInstallUiLocked) return
    const identifier = skill.skillKey || skill.name
    modals.openConfirmModal({
      title: '确认删除',
      children: (
        <Text size="sm">
          确定要删除 Skill <Code>{skill.name}</Code> 吗？此操作无法撤销。
        </Text>
      ),
      labels: { confirm: '删除', cancel: '取消' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          setUninstalling(identifier)
          const result = await window.api.skillsUninstall(identifier)
          if (result.ok) {
            await fetchSkills({ background: true })
          } else {
            setError(
              toUserFacingCliFailureMessage({
                stderr: result.stderr,
                stdout: result.stdout,
                fallback: '删除 Skill 失败，请稍后重试。',
              })
            )
          }
        } catch (e) {
          setError(toUserFacingUnknownErrorMessage(e, '删除 Skill 失败，请稍后重试。'))
        } finally {
          setUninstalling(null)
        }
      },
    })
  }

  const runSkillInstall = async (skillKey: string, skillLabel: string, slug: string) => {
    const activeInstall: ActiveSkillInstall = { key: skillKey, label: skillLabel }
    try {
      setError('')
      setNotice('')
      setCancelingInstall(false)
      setInstalling(activeInstall)
      const result = await window.api.skillsInstall(slug)
      if (result.ok) {
        await fetchSkills({ background: true })
      } else if (result.canceled) {
        await fetchSkills({ background: true })
        setError('')
        setNotice(`已取消 Skill ${activeInstall.label} 的安装。`)
      } else {
        setNotice('')
        setError(
          toUserFacingCliFailureMessage({
            stderr: result.stderr,
            stdout: result.stdout,
            fallback: '安装 Skill 失败，请稍后重试。',
          })
        )
      }
    } catch (e) {
      setNotice('')
      setError(toUserFacingUnknownErrorMessage(e, '安装 Skill 失败，请稍后重试。'))
    } finally {
      setCancelingInstall(false)
      setInstalling(null)
    }
  }

  const handleInstallRecommended = async (rec: RecommendedSkill) => {
    if (skillInstallUiLocked) return
    await runSkillInstall(rec.slug, rec.name, rec.slug)
  }

  const handleClawhubSearch = async () => {
    if (skillInstallUiLocked) return
    const query = searchQuery.trim()
    if (!query) return
    try {
      setClawhubSearching(true)
      setClawhubResults([])
      const result = await window.api.clawhubSearch(query, 10)
      if (result.ok) {
        setClawhubResults(result.skills)
      } else {
        setError(
          toUserFacingCliFailureMessage({
            stderr: result.error || '',
            fallback: 'ClawHub 搜索失败，请稍后重试。',
          })
        )
      }
    } catch (e) {
      setError(toUserFacingUnknownErrorMessage(e, 'ClawHub 搜索失败，请稍后重试。'))
    } finally {
      setClawhubSearching(false)
    }
  }

  const handleInstallClawhub = async (item: { slug: string; name: string }) => {
    if (skillInstallUiLocked) return
    await runSkillInstall(item.slug, item.name || item.slug, item.slug)
  }

  const handleCancelInstall = async () => {
    if (!installing || cancelingInstall) return

    try {
      setError('')
      setNotice('')
      setCancelingInstall(true)
      const canceled = await window.api.cancelCommandDomain('plugin-install')
      if (!canceled) {
        setCancelingInstall(false)
        setError('当前没有可取消的 Skill 安装任务。')
      }
    } catch (e) {
      setCancelingInstall(false)
      setError(toUserFacingUnknownErrorMessage(e, '取消 Skill 安装失败，请稍后重试。'))
    }
  }

  const handleInstallBin = async (bin: string) => {
    // Check brew availability first on macOS
    const { installed: brewInstalled } = await window.api.depsCheckBrew()
    if (!brewInstalled) {
      modals.openConfirmModal({
        title: '需要安装 Homebrew',
        children: (
          <Stack gap="xs">
            <Text size="sm">
              安装 <Code>{bin}</Code> 可能需要 Homebrew，是否先安装 Homebrew？
            </Text>
            <Text size="xs" c="dimmed">
              注意：需要当前用户拥有管理员权限。如果自动安装失败，请在终端中手动执行：
            </Text>
            <Code block className="text-xs">
              {'/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'}
            </Code>
          </Stack>
        ),
        labels: { confirm: '安装 Homebrew', cancel: '跳过，直接安装' },
        onCancel: () => doInstallBin(bin),
        onConfirm: async () => {
          try {
            setInstallingBrew(true)
            const result = await window.api.depsInstallBrew()
            if (result.ok) {
              await doInstallBin(bin)
            } else {
              // Homebrew 安装失败，回退到直接安装依赖（npm）
              setError('Homebrew 安装失败，尝试通过 npm 安装依赖...')
              await doInstallBin(bin)
            }
          } catch (e) {
            // Homebrew 安装异常，仍尝试直接安装依赖
            await doInstallBin(bin)
          } finally {
            setInstallingBrew(false)
          }
        },
      })
      return
    }
    await doInstallBin(bin)
  }

  const doInstallBin = async (bin: string) => {
    try {
      setInstallingBin(bin)
      setInstallLog([])
      const unsub = window.api.onDepsInstallLog((msg: string) => {
        setInstallLog((prev) => [...prev, msg])
      })
      const result = await window.api.depsInstallBin(bin)
      unsub()
      if (result.ok) {
        setInstallLog((prev) => [...prev, `✓ ${bin} 安装成功`])
        await fetchSkills({ background: true })
        if (selectedSkill) {
          const infoResult = await window.api.skillsInfo(selectedSkill.name)
          if (infoResult.ok && infoResult.stdout) {
            try {
              const updated = JSON.parse(infoResult.stdout)
              setSelectedSkill(updated)
            } catch { /* ignore parse error */ }
          }
        }
      } else {
        const userMessage = toUserFacingCliFailureMessage({
          stderr: result.stderr,
          stdout: result.stdout,
          fallback: `安装 ${bin} 失败，请稍后重试。`,
        })
        setInstallLog((prev) => [...prev, `✗ ${userMessage}`])
        setError(userMessage)
      }
    } catch (e) {
      setError(toUserFacingUnknownErrorMessage(e, `安装 ${bin} 失败，请稍后重试。`))
    } finally {
      setInstallingBin(null)
    }
  }

  const handleInstallSkillDeps = async (skill: SkillInfo) => {
    try {
      setInstallingBin(skill.name)
      setInstallLog([])
      const unsub = window.api.onDepsInstallLog((msg: string) => {
        setInstallLog((prev) => [...prev, msg])
      })
      const result = await window.api.depsInstallSkillDeps(skill.name)
      unsub()
      if (result.ok) {
        setInstallLog((prev) => [...prev, '✓ 所有依赖安装成功'])
        await fetchSkills({ background: true })
        const infoResult = await window.api.skillsInfo(skill.name)
        if (infoResult.ok && infoResult.stdout) {
          try {
            const updated = JSON.parse(infoResult.stdout)
            setSelectedSkill(updated)
          } catch { /* ignore */ }
        }
      } else {
        const userMessage = toUserFacingCliFailureMessage({
          stderr: result.stderr,
          stdout: result.stdout,
          fallback: `安装 ${skill.name} 依赖失败，请稍后重试。`,
        })
        setInstallLog((prev) => [...prev, `✗ ${userMessage}`])
        setError(userMessage)
      }
    } catch (e) {
      setError(toUserFacingUnknownErrorMessage(e, '安装依赖失败，请稍后重试。'))
    } finally {
      setInstallingBin(null)
    }
  }

  const handleRowClick = (skill: SkillInfo) => {
    setSelectedSkill(skill)
    setShowDetailModal(true)
  }

  // Filter skills
  const filteredSkills = useMemo(() => {
    if (!deferredSearch.trim()) return skills
    const query = deferredSearch.toLowerCase()
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.skillKey.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query)
    )
  }, [skills, deferredSearch])

  // Group by source
  const groupedSkills = useMemo(() => {
    const groups: Record<string, SkillInfo[]> = {}
    filteredSkills.forEach((skill) => {
      if (!groups[skill.source]) groups[skill.source] = []
      groups[skill.source].push(skill)
    })
    return groups
  }, [filteredSkills])

  // Statistics
  const stats = useMemo(() => {
    const total = filteredSkills.length
    const available = filteredSkills.filter((s) => s.eligible && !s.disabled && !hasMissing(s)).length
    const disabled = filteredSkills.filter((s) => s.disabled || hasMissing(s)).length
    return { total, available, disabled }
  }, [filteredSkills])

  const toggleSource = (source: string) => {
    setCollapsedSources((prev) => ({ ...prev, [source]: !prev[source] }))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader size="md" />
      </div>
    )
  }

  const isSearching = deferredSearch.trim().length > 0

  return (
    <div className="p-6 h-full overflow-y-auto">
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

      {/* Search */}
      <TextInput
        placeholder={searchMode === 'local' ? '搜索本地 Skills...' : '在 ClawHub 中搜索 Skills...'}
        leftSection={<IconSearch size={16} />}
        rightSection={
          <Tooltip label={searchMode === 'local' ? '切换到 ClawHub 搜索' : '切换到本地搜索'} withArrow>
            <ActionIcon
              variant={searchMode === 'clawhub' ? 'filled' : 'subtle'}
              size="sm"
              disabled={skillInstallUiLocked}
              onClick={() => {
                if (searchMode === 'local') {
                  setSearchMode('clawhub')
                } else {
                  setSearchMode('local')
                  setClawhubResults([])
                }
              }}
              className="cursor-pointer"
            >
              <IconWorld size={14} />
            </ActionIcon>
          </Tooltip>
        }
        value={searchQuery}
        disabled={skillInstallUiLocked}
        onChange={(e) => setSearchQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && searchMode === 'clawhub' && !skillInstallUiLocked) handleClawhubSearch()
        }}
        mb="xs"
        classNames={{ input: 'app-input' }}
      />

      {searchMode === 'clawhub' && (
        <Group justify="flex-end" mb="xs">
          <Button
            size="xs"
            variant="light"
            leftSection={<IconSearch size={14} />}
            onClick={handleClawhubSearch}
            loading={clawhubSearching}
            disabled={skillInstallUiLocked || !searchQuery.trim()}
            className="cursor-pointer"
          >
            搜索
          </Button>
        </Group>
      )}

      {/* ClawHub search results */}
      {searchMode === 'clawhub' && (
        <div className="mb-4">
          {clawhubSearching && (
            <div className="flex items-center justify-center py-8">
              <Loader size="sm" />
              <Text size="sm" c="dimmed" ml="xs">正在搜索 ClawHub...</Text>
            </div>
          )}
          {!clawhubSearching && clawhubResults.length > 0 && (
            <>
              <Text size="xs" c="dimmed" mb="xs">找到 {clawhubResults.length} 个结果</Text>
              <div className="space-y-2">
                {clawhubResults.map((item) => {
                  const alreadyInstalled = skills.some(
                    (s) => s.skillKey === item.slug || s.name === item.slug || s.name === item.name
                  )
                  return (
                    <div
                      key={item.slug}
                      className="flex items-center justify-between rounded-lg app-bg-secondary px-4 py-3"
                    >
                      <div className="flex-1 min-w-0 mr-3">
                        <Group gap="xs">
                          <Text size="sm" fw={500} className="app-text-primary">{item.slug}</Text>
                          <Badge size="xs" variant="light" color="gray">{item.score.toFixed(1)}</Badge>
                        </Group>
                        <Text size="xs" className="app-text-secondary">{item.name}</Text>
                      </div>
                      {alreadyInstalled ? (
                        <Badge size="sm" variant="light" color="green">已安装</Badge>
                      ) : (
                        <Button
                          size="xs"
                          variant="light"
                          leftSection={<IconDownload size={14} />}
                          loading={installing?.key === item.slug}
                          disabled={skillInstallUiLocked}
                          onClick={() => handleInstallClawhub(item)}
                          className="cursor-pointer flex-shrink-0"
                        >
                          安装
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
          {!clawhubSearching && clawhubResults.length === 0 && searchQuery.trim() && (
            <Text size="sm" c="dimmed" className="text-center py-8">
              输入关键词后按回车或点击"搜索"在 ClawHub 中查找 Skills
            </Text>
          )}
        </div>
      )}

      {/* Statistics */}
      <Group justify="space-between" mb="md">
        <Text size="xs" c="dimmed">
          共 {stats.total} 个 · {stats.available} 可用 · {stats.disabled} 已禁用
        </Text>
        <Tooltip label="刷新" withArrow>
          <ActionIcon
            variant="subtle"
            size="sm"
            loading={refreshing}
            disabled={skillInstallUiLocked}
            onClick={async () => {
              setRefreshing(true)
              try {
                await fetchSkills({ background: true })
              } finally {
                setRefreshing(false)
              }
            }}
            className="cursor-pointer"
          >
            <IconRefresh size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {/* Recommended Skills */}
      {(() => {
        const installedNames = new Set(skills.flatMap((s) => [s.name, s.skillKey]))
        const notInstalled = RECOMMENDED_SKILLS.filter((r) => !installedNames.has(r.name) && !installedNames.has(r.slug))
        if (notInstalled.length === 0) return null
        return (
          <div className="mb-4">
            <Group gap="xs" mb="xs">
              <IconSparkles size={16} className="app-text-warning" />
              <Text fw={600} size="sm" className="app-text-primary">推荐 Skills</Text>
            </Group>
            <div className="space-y-2">
              {notInstalled.map((rec) => (
                <div
                  key={rec.name}
                  className="flex items-center justify-between rounded-lg app-bg-secondary px-4 py-3"
                >
                  <div className="flex-1 min-w-0 mr-3">
                    <Text size="sm" fw={500} className="app-text-primary">{rec.name}</Text>
                    <Text size="xs" className="app-text-secondary">{rec.description}</Text>
                  </div>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconDownload size={14} />}
                    loading={installing?.key === rec.slug}
                    disabled={skillInstallUiLocked}
                    onClick={() => handleInstallRecommended(rec)}
                    className="cursor-pointer flex-shrink-0"
                  >
                    安装
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Empty state: no skills at all */}
      {skills.length === 0 && (
        <div className="text-center py-12">
          <Text size="lg" mb="xs">📦 暂无 Skills</Text>
          <Text size="sm" c="dimmed">
            先用上方市场搜索安装，或把 Skill 放到当前 workspace 的 `skills/` 目录后点击刷新。
          </Text>
        </div>
      )}

      {/* Empty state: search no results */}
      {skills.length > 0 && filteredSkills.length === 0 && (
        <div className="text-center py-12">
          <Text size="lg" mb="xs">🔍 未找到匹配 "{deferredSearch}" 的 Skills</Text>
          <Button
            variant="subtle"
            size="xs"
            disabled={skillInstallUiLocked}
            onClick={() => setSearchQuery('')}
            className="cursor-pointer"
          >
            清除搜索
          </Button>
        </div>
      )}

      {/* Skills list */}
      {filteredSkills.length > 0 && (
        <div className="space-y-3">
          {isSearching ? (
            // Flat list when searching
            <div className="border app-border rounded-lg overflow-hidden">
              {filteredSkills.map((skill, idx) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  isLast={idx === filteredSkills.length - 1}
                  onRowClick={handleRowClick}
                  onToggle={handleToggle}
                  onUninstall={handleUninstall}
                  uninstalling={uninstalling}
                  actionsDisabled={skillInstallUiLocked}
                />
              ))}
            </div>
          ) : (
            // Grouped by source
            Object.entries(groupedSkills).map(([source, sourceSkills]) => {
              const isCollapsed = collapsedSources[source] ?? false
              return (
                <div key={source}>
                  {/* Source header */}
                  <Group
                    gap="xs"
                    mb="xs"
                    onClick={() => toggleSource(source)}
                    className="cursor-pointer select-none"
                  >
                    <IconChevronRight
                      size={14}
                      style={{
                        transform: isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                        transition: 'transform 0.2s',
                      }}
                      className="app-text-muted"
                    />
                    <Tooltip
                      label={SOURCE_TOOLTIPS[source] || (SOURCE_LABELS[source] || source)}
                      withArrow
                      multiline
                      maw={280}
                    >
                      <Text size="sm" fw={600} className="app-text-primary">
                        {SOURCE_LABELS[source] || source}
                      </Text>
                    </Tooltip>
                    <Badge size="xs" variant="outline" color="gray">
                      {sourceSkills.length}
                    </Badge>
                  </Group>

                  {/* Skills rows */}
                  <Collapse in={!isCollapsed}>
                    <div className="border app-border rounded-lg overflow-hidden mb-2">
                      {sourceSkills.map((skill, idx) => (
                        <SkillRow
                          key={skill.name}
                          skill={skill}
                          isLast={idx === sourceSkills.length - 1}
                          onRowClick={handleRowClick}
                          onToggle={handleToggle}
                          onUninstall={handleUninstall}
                          uninstalling={uninstalling}
                          actionsDisabled={skillInstallUiLocked}
                        />
                      ))}
                    </div>
                  </Collapse>
                </div>
              )
            })
          )}
        </div>
      )}

      {(skillLocations.managedSkillsDir || skillLocations.workspaceSkillsDir) && (
        <Paper
          withBorder
          radius="md"
          mt="md"
          bg={computedColorScheme === 'dark' ? 'dark.6' : 'gray.0'}
          style={{ overflow: 'hidden' }}
        >
          <div
            role="button"
            tabIndex={0}
            onClick={() => setScanDirectoriesCollapsed((value) => !value)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setScanDirectoriesCollapsed((value) => !value) }}
            className="w-full cursor-pointer"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--mantine-spacing-md)', gap: 'var(--mantine-spacing-sm)' }}
          >
            <Text size="sm" fw={600}>当前 Skills 扫描目录</Text>
            <IconChevronRight
              size={16}
              className="app-text-muted"
              style={{
                transform: scanDirectoriesCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                transition: 'transform 0.2s',
                flexShrink: 0,
              }}
            />
          </div>

          <Collapse in={!scanDirectoriesCollapsed}>
            <div className="px-4 pb-3" style={{ borderTop: '1px solid var(--app-border-light)' }}>
              <Stack gap={4} mt="sm">
                {skillLocations.managedSkillsDir && (
                  <Text size="xs">
                    共享安装目录：<Code>{skillLocations.managedSkillsDir}</Code>
                  </Text>
                )}
                {skillLocations.workspaceSkillsDir && (
                  <Text size="xs">
                    工作区目录：<Code>{skillLocations.workspaceSkillsDir}</Code>
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  本页面安装 Skill 时会优先走官方 `openclaw skills install`，不可用时再回退到 ClawHub，并优先安装到当前 OpenClaw workspace。
                </Text>
              </Stack>
            </div>
          </Collapse>
        </Paper>
      )}

      {/* Detail Modal */}
      <Modal
        opened={showDetailModal}
        onClose={() => setShowDetailModal(false)}
        title={selectedSkill ? [selectedSkill.emoji, selectedSkill.name].filter(Boolean).join(' ') : ''}
        size="lg"
      >
        {selectedSkill && (
          <Stack gap="md">
            <div>
              <Text size="sm" fw={500} c="dimmed" mb={4}>
                描述
              </Text>
              <Text size="sm">{selectedSkill.description}</Text>
            </div>

            <Group gap="md">
              <div>
                <Text size="sm" fw={500} c="dimmed" mb={4}>
                  来源
                </Text>
                <Badge variant="light" size="sm">
                  {SOURCE_LABELS[selectedSkill.source] || selectedSkill.source}
                </Badge>
              </div>
              <div>
                <Text size="sm" fw={500} c="dimmed" mb={4}>
                  状态
                </Text>
                {getStatusBadge(selectedSkill)}
              </div>
            </Group>

            <Group gap="md" align="flex-start">
              <div>
                <Text size="sm" fw={500} c="dimmed" mb={4}>
                  Skill Key
                </Text>
                <Code>{selectedSkill.skillKey}</Code>
              </div>
              {selectedSkill.installTarget && (
                <div>
                  <Text size="sm" fw={500} c="dimmed" mb={4}>
                    安装目标
                  </Text>
                  <Badge variant="outline" size="sm">
                    {selectedSkill.installTarget}
                  </Badge>
                </div>
              )}
            </Group>

            {selectedSkill.homepage && (
              <div>
                <Text size="sm" fw={500} c="dimmed" mb={4}>
                  主页
                </Text>
                <Anchor href={selectedSkill.homepage} target="_blank" rel="noreferrer" size="sm">
                  {selectedSkill.homepage}
                </Anchor>
              </div>
            )}

            {(selectedSkill.primaryEnv || selectedSkill.apiKeys?.length || selectedSkill.configKeys?.length) && (
              <div>
                <Text size="sm" fw={500} c="dimmed" mb={6}>
                  官方元数据
                </Text>
                <Stack gap={6}>
                  {selectedSkill.primaryEnv && (
                    <Text size="sm">
                      主环境变量：<Code>{selectedSkill.primaryEnv}</Code>
                    </Text>
                  )}
                  {selectedSkill.apiKeys?.length ? (
                    <Text size="sm">
                      API Key 字段：{selectedSkill.apiKeys.map((key) => <Code key={key}>{key}</Code>)}
                    </Text>
                  ) : null}
                  {selectedSkill.configKeys?.length ? (
                    <Text size="sm">
                      配置键：{selectedSkill.configKeys.map((key) => <Code key={key}>{key}</Code>)}
                    </Text>
                  ) : null}
                </Stack>
              </div>
            )}

            {selectedSkill.requires?.length ? (
              <div>
                <Text size="sm" fw={500} c="dimmed" mb={4}>
                  运行要求
                </Text>
                <Group gap="xs">
                  {selectedSkill.requires.map((item) => (
                    <Badge key={item} variant="light" color="gray" size="sm">
                      {item}
                    </Badge>
                  ))}
                </Group>
              </div>
            ) : null}

            {selectedSkill.blockedByAllowlist && (
              <Alert color="yellow" title="被 Allowlist 阻止">
                此 Skill 未在允许列表中
              </Alert>
            )}

            {hasMissing(selectedSkill) && (
              <Alert color="yellow" title="当前缺少依赖">
                <Stack gap={6}>
                  {selectedSkill.missing?.bins.length ? (
                    <Text size="sm">缺少命令：{selectedSkill.missing.bins.map((bin) => <Code key={bin}>{bin}</Code>)}</Text>
                  ) : null}
                  {selectedSkill.missing?.anyBins.length ? (
                    <Text size="sm">任选其一：{selectedSkill.missing.anyBins.map((bin) => <Code key={bin}>{bin}</Code>)}</Text>
                  ) : null}
                  {selectedSkill.missing?.env.length ? (
                    <Text size="sm">缺少环境变量：{selectedSkill.missing.env.map((envKey) => <Code key={envKey}>{envKey}</Code>)}</Text>
                  ) : null}
                  {selectedSkill.missing?.config.length ? (
                    <Text size="sm">缺少配置：{selectedSkill.missing.config.map((key) => <Code key={key}>{key}</Code>)}</Text>
                  ) : null}
                  {selectedSkill.missing?.os.length ? (
                    <Text size="sm">平台限制：{selectedSkill.missing.os.map((item) => <Code key={item}>{item}</Code>)}</Text>
                  ) : null}
                </Stack>
              </Alert>
            )}

            {selectedSkill.install?.length ? (
              <div>
                <Text size="sm" fw={500} c="dimmed" mb={4}>
                  安装步骤
                </Text>
                <Stack gap="xs">
                  {selectedSkill.install.map((step) => (
                    <div key={step.id} className="rounded-md app-bg-secondary px-3 py-2">
                      <Text size="sm" fw={500}>{step.label}</Text>
                      <Text size="xs" c="dimmed">{step.kind}</Text>
                      {step.bins.length ? (
                        <Group gap="xs" mt={6}>
                          {step.bins.map((bin) => (
                            <Code key={bin}>{bin}</Code>
                          ))}
                        </Group>
                      ) : null}
                    </div>
                  ))}
                </Stack>
              </div>
            ) : null}

            {(selectedSkill.location || selectedSkill.path) && (
              <div>
                <Text size="sm" fw={500} c="dimmed" mb={4}>
                  发现位置
                </Text>
                <Stack gap={4}>
                  {selectedSkill.location ? <Code>{selectedSkill.location}</Code> : null}
                  {selectedSkill.path ? <Code>{selectedSkill.path}</Code> : null}
                </Stack>
              </div>
            )}


          </Stack>
        )}
      </Modal>

      <Modal
        opened={Boolean(installing)}
        onClose={() => {}}
        title={cancelingInstall ? '正在取消安装...' : '正在安装 Skill'}
        size="sm"
        centered
        withCloseButton={false}
        closeOnClickOutside={false}
        closeOnEscape={false}
      >
        <Stack gap="md" align="center">
          <Loader size="sm" />
          <Stack gap={4} align="center">
            <Text fw={600}>{installing?.label || 'Skill'}</Text>
            <Text size="sm" c="dimmed" ta="center">
              {cancelingInstall
                ? '系统正在中断当前安装命令，请稍候。'
                : '安装期间会暂时锁定当前页面的 Skill 操作，避免并发安装或卸载造成状态冲突。'}
            </Text>
          </Stack>
          <Button
            color="red"
            variant="light"
            onClick={handleCancelInstall}
            loading={cancelingInstall}
          >
            {cancelingInstall ? '取消中...' : '取消安装'}
          </Button>
        </Stack>
      </Modal>
    </div>
  )
}

// Helper: Check if skill has missing dependencies
function hasMissing(skill: SkillInfo): boolean {
  if (!skill.missing) return false
  return (
    skill.missing.bins.length > 0 ||
    skill.missing.anyBins.length > 0 ||
    skill.missing.env.length > 0 ||
    skill.missing.config.length > 0 ||
    skill.missing.os.length > 0
  )
}

// Helper: Get status badge
function getStatusBadge(skill: SkillInfo) {
  if (hasMissing(skill)) {
    return <Badge color="yellow" size="sm">缺少依赖</Badge>
  }
  if (skill.disabled) {
    return <Badge color="yellow" size="sm">已禁用</Badge>
  }
  if (skill.eligible) {
    return <Badge color="green" size="sm">可用</Badge>
  }
  return <Badge color="gray" size="sm">不可用</Badge>
}

function CopyableCodeBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => {
      setCopied(false)
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('当前环境不支持复制')
      }
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setCopyError('')
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : '复制失败，请稍后重试。')
    }
  }

  return (
    <div className="mb-2">
      <div className="flex items-start gap-2">
        <Code block className="text-xs flex-1 mb-0">
          {value}
        </Code>
        <Button
          variant="light"
          size="compact-xs"
          onClick={() => void handleCopy()}
          leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        >
          {copied ? '已复制' : '复制'}
        </Button>
      </div>
      {copyError ? (
        <Text size="xs" c="red" mt={4}>
          {copyError}
        </Text>
      ) : null}
    </div>
  )
}

// Skill row component
function SkillRow({
  skill,
  isLast,
  onRowClick,
  onToggle,
  onUninstall,
  uninstalling,
  actionsDisabled,
}: {
  skill: SkillInfo
  isLast: boolean
  onRowClick: (skill: SkillInfo) => void
  onToggle: (skill: SkillInfo, enabled: boolean) => void
  onUninstall: (skill: SkillInfo) => void
  uninstalling: string | null
  actionsDisabled: boolean
}) {
  const canDelete = !skill.bundled

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2 transition-colors ${
        actionsDisabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-gray-50/50 cursor-pointer'
      } ${
        !isLast ? 'border-b app-border' : ''
      }`}
      onClick={() => {
        if (!actionsDisabled) {
          onRowClick(skill)
        }
      }}
      style={{ minHeight: '44px' }}
    >
      {/* Name */}
      <Text size="sm" fw={500} className="app-text-primary" style={{ minWidth: '128px' }}>
        {[skill.emoji, skill.name].filter(Boolean).join(' ')}
      </Text>

      {/* Description */}
      <Text size="xs" c="dimmed" className="flex-1 truncate">
        {skill.description}
      </Text>

      {/* Toggle switch */}
      <div onClick={(e) => e.stopPropagation()}>
        <Switch
          size="sm"
          checked={!skill.disabled && !hasMissing(skill)}
          disabled={actionsDisabled}
          onChange={(e) => onToggle(skill, e.currentTarget.checked)}
          styles={() => ({
            track: {
              backgroundColor: !skill.disabled && !hasMissing(skill)
                ? 'var(--app-text-success)'
                : 'var(--app-text-danger)',
              opacity: 0.8,
            },
            thumb: {
              backgroundColor: 'var(--mantine-color-white)',
            },
          })}
        />
      </div>

      {/* Delete button */}
      <div onClick={(e) => e.stopPropagation()}>
        {canDelete ? (
          <Tooltip label="删除" withArrow>
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              disabled={actionsDisabled}
              onClick={() => onUninstall(skill)}
              loading={uninstalling === (skill.skillKey || skill.name)}
              className="cursor-pointer"
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
        ) : (
          <div style={{ width: '28px' }} />
        )}
      </div>
    </div>
  )
}
