/**
 * Knowledge Base management — lets users mount local Markdown folders
 * as memory sources for OpenClaw via `memorySearch.extraPaths`.
 *
 * Key design decisions (from OpenClaw docs):
 * - `memorySearch.extraPaths` supports absolute paths and recursively scans .md files.
 * - **Symlinks are explicitly ignored** by OpenClaw, so we register absolute paths directly.
 * - Git sync = git pull (download) + git add/commit/push (upload).
 */

import { app, dialog } from 'electron'
import { readConfig } from './cli'
import { applyConfigPatchGuarded } from './openclaw-config-coordinator'
import { runShell } from './cli'

const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const fsPromises = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const crypto = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')

// ── Types ──────────────────────────────────────────────────────────

export interface KnowledgeBaseEntry {
  id: string
  name: string
  localPath: string
  gitRemote: string
  createdAt: string
}

export interface KnowledgeBaseConfig {
  version: number
  bases: KnowledgeBaseEntry[]
}

export interface KnowledgeBaseStatus {
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

export interface KnowledgeBaseSyncResult {
  ok: boolean
  pullOutput: string
  pushOutput: string
  message: string
}

// ── Paths ──────────────────────────────────────────────────────────

function getConfigFilePath(): string {
  const homeDir = os.homedir()
  return path.join(homeDir, '.openclaw', 'qclaw-knowledge-bases.json')
}

function getOpenClawConfigDir(): string {
  return path.join(os.homedir(), '.openclaw')
}

// ── Config CRUD ────────────────────────────────────────────────────

async function readKnowledgeBaseConfig(): Promise<KnowledgeBaseConfig> {
  const configPath = getConfigFilePath()
  try {
    const raw = await fsPromises.readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.bases)) {
      return parsed as KnowledgeBaseConfig
    }
  } catch {
    // File missing or corrupt — return default
  }
  return { version: 1, bases: [] }
}

async function writeKnowledgeBaseConfig(config: KnowledgeBaseConfig): Promise<void> {
  const configPath = getConfigFilePath()
  const dir = path.dirname(configPath)
  await fsPromises.mkdir(dir, { recursive: true })
  await fsPromises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8')
}

// ── OpenClaw config integration ────────────────────────────────────

function deepGet(obj: any, keyPath: string[]): any {
  let cursor = obj
  for (const key of keyPath) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = cursor[key]
  }
  return cursor
}

function deepSet(obj: any, keyPath: string[], value: any): void {
  let cursor = obj
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i]
    if (!cursor[key] || typeof cursor[key] !== 'object') {
      cursor[key] = {}
    }
    cursor = cursor[key]
  }
  cursor[keyPath[keyPath.length - 1]] = value
}

/**
 * Sync the `agents.defaults.memorySearch.extraPaths` in openclaw.json
 * to match the current knowledge base entries. This is the key integration
 * point: OpenClaw will index these absolute paths for vector memory search.
 */
async function syncExtraPathsToOpenClawConfig(bases: KnowledgeBaseEntry[]): Promise<{ ok: boolean; message: string }> {
  try {
    const beforeConfig = (await readConfig().catch(() => null)) as Record<string, any> | null
    if (!beforeConfig) {
      return { ok: false, message: '无法读取 OpenClaw 配置' }
    }

    const afterConfig = JSON.parse(JSON.stringify(beforeConfig))

    // Build extraPaths from knowledge base entries
    const extraPaths = bases
      .map((b) => b.localPath)
      .filter((p) => {
        try {
          return fs.existsSync(p) && fs.statSync(p).isDirectory()
        } catch {
          return false
        }
      })

    // Set agents.defaults.memorySearch.extraPaths
    deepSet(afterConfig, ['agents', 'defaults', 'memorySearch', 'extraPaths'], extraPaths)

    // Ensure memorySearch is enabled
    const currentEnabled = deepGet(afterConfig, ['agents', 'defaults', 'memorySearch', 'enabled'])
    if (currentEnabled === undefined) {
      deepSet(afterConfig, ['agents', 'defaults', 'memorySearch', 'enabled'], true)
    }

    const writeResult = await applyConfigPatchGuarded({
      beforeConfig,
      afterConfig,
      reason: 'knowledge-base-sync',
    })

    if (!writeResult.ok) {
      return { ok: false, message: writeResult.message || '写入 OpenClaw 配置失败' }
    }

    return { ok: true, message: '已更新 OpenClaw 记忆搜索路径' }
  } catch (e: any) {
    return { ok: false, message: e.message || '同步配置时出错' }
  }
}

/**
 * Write knowledge base usage instructions into AGENTS.md in the workspace
 * so OpenClaw knows how to use the knowledge base for answering questions.
 */
async function ensureAgentsKnowledgeInstructions(bases: KnowledgeBaseEntry[]): Promise<void> {
  const workspacePath = path.join(getOpenClawConfigDir(), 'workspace')
  const agentsFilePath = path.join(workspacePath, 'AGENTS.md')

  const KB_MARKER_START = '<!-- QCLAW_KNOWLEDGE_BASE_START -->'
  const KB_MARKER_END = '<!-- QCLAW_KNOWLEDGE_BASE_END -->'

  // Build instructions block
  const activeBases = bases.filter((b) => {
    try {
      return fs.existsSync(b.localPath) && fs.statSync(b.localPath).isDirectory()
    } catch {
      return false
    }
  })

  let kbBlock = ''
  if (activeBases.length > 0) {
    const pathsList = activeBases.map((b) => `- **${b.name}**: \`${b.localPath}\``).join('\n')
    kbBlock = `${KB_MARKER_START}

## 知识库

以下目录已挂载为知识库，包含 Markdown 参考文档。当用户提问时，请优先使用 \`memory_search\` 工具在知识库中搜索相关内容，再结合搜索结果回答。

${pathsList}

**使用方式：**
- 用户提问时，先用 \`memory_search\` 搜索知识库内容
- 基于搜索到的文档片段来回答用户的问题
- 如果知识库中没有相关内容，再使用你自身的知识回答
- 回答时注明参考来源（文件路径）

${KB_MARKER_END}`
  }

  try {
    await fsPromises.mkdir(workspacePath, { recursive: true })

    let existingContent = ''
    try {
      existingContent = await fsPromises.readFile(agentsFilePath, 'utf8')
    } catch {
      // File doesn't exist yet
    }

    // Remove old block if present
    const markerRegex = new RegExp(
      `${escapeRegex(KB_MARKER_START)}[\\s\\S]*?${escapeRegex(KB_MARKER_END)}`,
      'g'
    )
    const cleanedContent = existingContent.replace(markerRegex, '').trim()

    // Append new block
    const newContent = kbBlock
      ? `${cleanedContent}\n\n${kbBlock}\n`
      : cleanedContent
        ? `${cleanedContent}\n`
        : ''

    await fsPromises.writeFile(agentsFilePath, newContent, 'utf8')
  } catch {
    // Non-critical: don't fail the whole operation
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Count markdown files ───────────────────────────────────────────

async function countMarkdownFiles(dirPath: string): Promise<number> {
  let count = 0
  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        count += await countMarkdownFiles(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        count += 1
      }
    }
  } catch {
    // Ignore unreadable directories
  }
  return count
}

// ── Public API ─────────────────────────────────────────────────────

export async function listKnowledgeBases(): Promise<KnowledgeBaseEntry[]> {
  const config = await readKnowledgeBaseConfig()
  return config.bases
}

export async function selectKnowledgeBaseFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '选择知识库文件夹',
    message: '选择一个包含 Markdown 文档的文件夹作为知识库',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选择此文件夹',
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  return result.filePaths[0]
}

export async function addKnowledgeBase(localPath: string): Promise<{
  ok: boolean
  entry?: KnowledgeBaseEntry
  message: string
}> {
  const normalizedPath = path.resolve(localPath)

  // Validate path
  try {
    const stat = await fsPromises.stat(normalizedPath)
    if (!stat.isDirectory()) {
      return { ok: false, message: '所选路径不是一个文件夹' }
    }
  } catch {
    return { ok: false, message: '所选路径不存在或无法访问' }
  }

  const config = await readKnowledgeBaseConfig()

  // Check duplicate
  if (config.bases.some((b) => b.localPath === normalizedPath)) {
    return { ok: false, message: '该文件夹已添加为知识库' }
  }

  const entry: KnowledgeBaseEntry = {
    id: crypto.randomUUID(),
    name: path.basename(normalizedPath),
    localPath: normalizedPath,
    gitRemote: '',
    createdAt: new Date().toISOString(),
  }

  config.bases.push(entry)
  await writeKnowledgeBaseConfig(config)

  // Sync to OpenClaw config
  await syncExtraPathsToOpenClawConfig(config.bases)
  await ensureAgentsKnowledgeInstructions(config.bases)

  return { ok: true, entry, message: '知识库添加成功' }
}

export async function removeKnowledgeBase(id: string): Promise<{
  ok: boolean
  message: string
}> {
  const config = await readKnowledgeBaseConfig()
  const index = config.bases.findIndex((b) => b.id === id)
  if (index === -1) {
    return { ok: false, message: '未找到该知识库' }
  }

  config.bases.splice(index, 1)
  await writeKnowledgeBaseConfig(config)

  // Sync to OpenClaw config
  await syncExtraPathsToOpenClawConfig(config.bases)
  await ensureAgentsKnowledgeInstructions(config.bases)

  return { ok: true, message: '知识库已移除（原始文件夹未删除）' }
}

export async function setKnowledgeBaseGitRemote(
  id: string,
  gitUrl: string
): Promise<{ ok: boolean; message: string }> {
  const config = await readKnowledgeBaseConfig()
  const entry = config.bases.find((b) => b.id === id)
  if (!entry) {
    return { ok: false, message: '未找到该知识库' }
  }

  entry.gitRemote = gitUrl.trim()
  await writeKnowledgeBaseConfig(config)

  // If git remote is set and the folder has a git repo, configure the remote
  if (entry.gitRemote && fs.existsSync(path.join(entry.localPath, '.git'))) {
    // Check if origin exists
    const remoteCheck = await runShell('git', ['remote', 'get-url', 'origin'], 10_000, {
      cwd: entry.localPath,
      controlDomain: 'knowledge-base',
    })

    if (remoteCheck.ok) {
      // Update existing remote
      await runShell('git', ['remote', 'set-url', 'origin', entry.gitRemote], 10_000, {
        cwd: entry.localPath,
        controlDomain: 'knowledge-base',
      })
    } else {
      // Add new remote
      await runShell('git', ['remote', 'add', 'origin', entry.gitRemote], 10_000, {
        cwd: entry.localPath,
        controlDomain: 'knowledge-base',
      })
    }
  }

  return { ok: true, message: 'Git 远程地址已保存' }
}

/**
 * Resolve the git remote name to use for sync operations.
 * Strategy:
 * 1. Find a remote whose URL matches the configured gitRemote
 * 2. Fall back to the tracking remote of the current branch
 * 3. Fall back to 'origin'
 */
async function resolveGitRemoteName(repoPath: string, configuredUrl: string): Promise<string> {
  // Strategy 1: Find remote matching the configured URL
  const remoteVerbose = await runShell('git', ['remote', '-v'], 10_000, {
    cwd: repoPath,
    controlDomain: 'knowledge-base',
  })

  if (remoteVerbose.ok && remoteVerbose.stdout) {
    const lines = remoteVerbose.stdout.trim().split('\n')
    // Normalize URL for comparison (remove trailing .git, credentials, etc.)
    const normalizeUrl = (url: string) =>
      url.replace(/\.git$/, '').replace(/https?:\/\/[^@]*@/, 'https://').trim()
    const normalizedConfigUrl = normalizeUrl(configuredUrl)

    for (const line of lines) {
      const parts = line.split(/\s+/)
      if (parts.length >= 2) {
        const remoteName = parts[0]
        const remoteUrl = parts[1]
        if (normalizeUrl(remoteUrl) === normalizedConfigUrl) {
          return remoteName
        }
      }
    }
  }

  // Strategy 2: Use the tracking remote of the current branch
  const trackingRemote = await runShell(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    10_000,
    {
      cwd: repoPath,
      controlDomain: 'knowledge-base',
    }
  )
  if (trackingRemote.ok && trackingRemote.stdout?.trim()) {
    // Output is like "origin/master" — extract the remote name
    const upstream = trackingRemote.stdout.trim()
    const slashIndex = upstream.indexOf('/')
    if (slashIndex > 0) {
      return upstream.substring(0, slashIndex)
    }
  }

  // Strategy 3: If there's only one remote, use it
  if (remoteVerbose.ok && remoteVerbose.stdout) {
    const remoteNames = new Set<string>()
    for (const line of remoteVerbose.stdout.trim().split('\n')) {
      const name = line.split(/\s+/)[0]
      if (name) remoteNames.add(name)
    }
    if (remoteNames.size === 1) {
      return remoteNames.values().next().value as string
    }
  }

  // Fallback: 'origin'
  return 'origin'
}

export async function syncKnowledgeBase(id: string): Promise<KnowledgeBaseSyncResult> {
  const config = await readKnowledgeBaseConfig()
  const entry = config.bases.find((b) => b.id === id)
  if (!entry) {
    return { ok: false, pullOutput: '', pushOutput: '', message: '未找到该知识库' }
  }

  if (!fs.existsSync(entry.localPath)) {
    return { ok: false, pullOutput: '', pushOutput: '', message: '知识库文件夹不存在' }
  }

  const gitDir = path.join(entry.localPath, '.git')
  const isGitRepo = fs.existsSync(gitDir)

  // Initialize git repo if not exists
  if (!isGitRepo) {
    const initResult = await runShell('git', ['init'], 30_000, {
      cwd: entry.localPath,
      controlDomain: 'knowledge-base',
    })
    if (!initResult.ok) {
      return { ok: false, pullOutput: '', pushOutput: '', message: `Git 初始化失败: ${initResult.stderr}` }
    }

    // Set up remote if configured
    if (entry.gitRemote) {
      await runShell('git', ['remote', 'add', 'origin', entry.gitRemote], 10_000, {
        cwd: entry.localPath,
        controlDomain: 'knowledge-base',
      })
    }
  }

  if (!entry.gitRemote) {
    return { ok: false, pullOutput: '', pushOutput: '', message: '未配置 Git 远程地址，请先设置' }
  }

  // ── Resolve remote name ──
  // The user might have a pre-existing repo with a non-"origin" remote name.
  // Detect the remote that matches the configured gitRemote URL, or fall back
  // to the first available remote, or "origin".
  const remoteName = await resolveGitRemoteName(entry.localPath, entry.gitRemote)

  // Ensure the remote URL matches what we have configured
  if (isGitRepo) {
    const remoteUrlCheck = await runShell('git', ['remote', 'get-url', remoteName], 10_000, {
      cwd: entry.localPath,
      controlDomain: 'knowledge-base',
    })
    if (!remoteUrlCheck.ok) {
      // Remote doesn't exist, add it
      await runShell('git', ['remote', 'add', remoteName, entry.gitRemote], 10_000, {
        cwd: entry.localPath,
        controlDomain: 'knowledge-base',
      })
    }
  }

  // ── Resolve current branch name ──
  const branchResult = await runShell('git', ['rev-parse', '--abbrev-ref', 'HEAD'], 10_000, {
    cwd: entry.localPath,
    controlDomain: 'knowledge-base',
  })
  const branchName = branchResult.ok && branchResult.stdout?.trim()
    ? branchResult.stdout.trim()
    : 'master'

  let pullOutput = ''
  let pushOutput = ''

  // Step 1: Pull remote changes
  const pullResult = await runShell('git', ['pull', '--rebase', remoteName, branchName], 120_000, {
    cwd: entry.localPath,
    controlDomain: 'knowledge-base',
  })
  pullOutput = pullResult.stdout || pullResult.stderr || ''

  // Pull might fail if there's nothing to pull (new repo), that's OK
  if (!pullResult.ok) {
    // Try without --rebase in case of fresh repo
    const pullFallback = await runShell('git', ['pull', remoteName, branchName], 120_000, {
      cwd: entry.localPath,
      controlDomain: 'knowledge-base',
    })
    if (pullFallback.ok) {
      pullOutput = pullFallback.stdout || pullFallback.stderr || ''
    } else {
      // It's OK if pull fails on a brand new repo
      pullOutput = `(拉取跳过: ${pullFallback.stderr || '远程可能为空'})`
    }
  }

  // Step 2: Push local changes
  // Check for uncommitted changes (new/modified/deleted files)
  const statusResult = await runShell('git', ['status', '--porcelain'], 10_000, {
    cwd: entry.localPath,
    controlDomain: 'knowledge-base',
  })
  const hasUncommittedChanges = statusResult.ok && statusResult.stdout && statusResult.stdout.trim().length > 0

  if (hasUncommittedChanges) {
    // Stage all changes
    const addResult = await runShell('git', ['add', '-A'], 30_000, {
      cwd: entry.localPath,
      controlDomain: 'knowledge-base',
    })
    if (!addResult.ok) {
      return {
        ok: false,
        pullOutput,
        pushOutput: '',
        message: `暂存变更失败: ${addResult.stderr}`,
      }
    }

    // Commit with timestamp
    const timestamp = new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const commitMessage = `Qclaw 知识库同步 ${timestamp}`

    const commitResult = await runShell(
      'git',
      ['commit', '-m', commitMessage],
      30_000,
      {
        cwd: entry.localPath,
        controlDomain: 'knowledge-base',
      }
    )
    if (!commitResult.ok) {
      return {
        ok: false,
        pullOutput,
        pushOutput: '',
        message: `提交变更失败: ${commitResult.stderr}`,
      }
    }
  }

  // Check for unpushed commits (already committed but not pushed)
  const unpushedCheck = await runShell(
    'git',
    ['log', `${remoteName}/${branchName}..HEAD`, '--oneline'],
    10_000,
    {
      cwd: entry.localPath,
      controlDomain: 'knowledge-base',
    }
  )
  const hasUnpushedCommits = unpushedCheck.ok && unpushedCheck.stdout && unpushedCheck.stdout.trim().length > 0

  // Also check if upstream is not set (brand new repo)
  const hasUpstream = unpushedCheck.ok || (unpushedCheck.stderr || '').includes('unknown revision')
  const needsPush = hasUncommittedChanges || hasUnpushedCommits || !hasUpstream

  if (needsPush) {
    // Push to remote
    const pushResult = await runShell(
      'git',
      ['push', '-u', remoteName, branchName],
      120_000,
      {
        cwd: entry.localPath,
        controlDomain: 'knowledge-base',
      }
    )
    pushOutput = pushResult.stdout || pushResult.stderr || ''

    if (!pushResult.ok) {
      return {
        ok: false,
        pullOutput,
        pushOutput,
        message: `推送失败: ${pushResult.stderr || '请检查远程仓库权限'}`,
      }
    }

    return {
      ok: true,
      pullOutput,
      pushOutput,
      message: '同步完成：已拉取远程更新并推送本地变更',
    }
  }

  return {
    ok: true,
    pullOutput,
    pushOutput: '(无本地变更需要推送)',
    message: '同步完成：已拉取远程更新，本地无变更需要推送',
  }
}

export async function getKnowledgeBaseStatus(id: string): Promise<KnowledgeBaseStatus | null> {
  const config = await readKnowledgeBaseConfig()
  const entry = config.bases.find((b) => b.id === id)
  if (!entry) return null

  const exists = fs.existsSync(entry.localPath)
  const gitInitialized = exists && fs.existsSync(path.join(entry.localPath, '.git'))

  let hasRemote = false
  if (gitInitialized) {
    const remoteResult = await runShell('git', ['remote', '-v'], 10_000, {
      cwd: entry.localPath,
      controlDomain: 'knowledge-base',
    })
    hasRemote = remoteResult.ok && Boolean(remoteResult.stdout?.trim())
  }

  const mdFileCount = exists ? await countMarkdownFiles(entry.localPath) : 0

  return {
    id: entry.id,
    name: entry.name,
    localPath: entry.localPath,
    exists,
    gitRemote: entry.gitRemote,
    gitInitialized,
    hasRemote,
    mdFileCount,
    lastSyncMessage: '',
  }
}

export async function getAllKnowledgeBaseStatuses(): Promise<KnowledgeBaseStatus[]> {
  const config = await readKnowledgeBaseConfig()
  const statuses: KnowledgeBaseStatus[] = []

  for (const entry of config.bases) {
    const status = await getKnowledgeBaseStatus(entry.id)
    if (status) statuses.push(status)
  }

  return statuses
}
