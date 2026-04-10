import { readConfig } from './cli'
import { resolveOpenClawEnvValue } from './openclaw-legacy-env-migration'
import { resolveOpenClawPathsForRead } from './openclaw-runtime-readonly'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

export interface WeixinAccountState {
  accountId: string
  configured: boolean
  baseUrl?: string
  userId?: string
  enabled: boolean
  name?: string
}

interface WeixinStoredAccountData {
  token?: string
  baseUrl?: string
  userId?: string
}

function cloneConfig(config: Record<string, any> | null | undefined): Record<string, any> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  return JSON.parse(JSON.stringify(config)) as Record<string, any>
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function resolveOpenClawStateDir(): Promise<string> {
  const envStateDir = resolveOpenClawEnvValue(process.env, 'OPENCLAW_STATE_DIR').value
  if (envStateDir) return envStateDir

  const openClawPaths = await resolveOpenClawPathsForRead().catch(() => null)
  const homeDir = String(openClawPaths?.homeDir || '').trim()
  if (homeDir) return homeDir

  return path.join(process.env.HOME || process.env.USERPROFILE || '', '.openclaw')
}

async function resolveWeixinStatePaths(): Promise<{
  stateDir: string
  weixinStateDir: string
  accountsDir: string
  accountIndexPath: string
  credentialsDir: string
}> {
  const stateDir = await resolveOpenClawStateDir()
  const weixinStateDir = path.join(stateDir, 'openclaw-weixin')
  return {
    stateDir,
    weixinStateDir,
    accountsDir: path.join(weixinStateDir, 'accounts'),
    accountIndexPath: path.join(weixinStateDir, 'accounts.json'),
    credentialsDir: path.join(stateDir, 'credentials'),
  }
}

function sanitizeAccountId(raw: unknown): string {
  return String(raw || '').trim()
}

function deriveRawAccountId(normalizedId: string): string | undefined {
  if (normalizedId.endsWith('-im-bot')) {
    return `${normalizedId.slice(0, -7)}@im.bot`
  }
  if (normalizedId.endsWith('-im-wechat')) {
    return `${normalizedId.slice(0, -10)}@im.wechat`
  }
  return undefined
}

function resolveWeixinAccountConfigMap(config: Record<string, any> | null | undefined): Record<string, any> {
  const section = config?.channels?.['openclaw-weixin']
  if (!hasOwnRecord(section)) return {}
  return hasOwnRecord(section.accounts) ? section.accounts : {}
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return null
  }
}

function listIndexedAccountIds(accountIndexPath: string): string[] {
  const parsed = readJsonFile<unknown>(accountIndexPath)
  if (!Array.isArray(parsed)) return []
  return Array.from(
    new Set(
      parsed
        .map((item) => sanitizeAccountId(item))
        .filter(Boolean)
    )
  )
}

function readStoredWeixinAccount(accountsDir: string, accountId: string): WeixinStoredAccountData | null {
  const primary = readJsonFile<WeixinStoredAccountData>(path.join(accountsDir, `${accountId}.json`))
  if (primary) return primary

  const rawAccountId = deriveRawAccountId(accountId)
  if (!rawAccountId) return null
  return readJsonFile<WeixinStoredAccountData>(path.join(accountsDir, `${rawAccountId}.json`))
}

export async function listWeixinAccountState(): Promise<WeixinAccountState[]> {
  const [paths, config] = await Promise.all([resolveWeixinStatePaths(), readConfig().catch(() => null)])
  const configAccounts = resolveWeixinAccountConfigMap(config)
  const indexedAccountIds = listIndexedAccountIds(paths.accountIndexPath)
  const mergedAccountIds = new Set<string>(indexedAccountIds)

  for (const accountId of Object.keys(configAccounts)) {
    const normalized = sanitizeAccountId(accountId)
    if (normalized) mergedAccountIds.add(normalized)
  }

  const accounts: WeixinAccountState[] = []
  for (const accountId of mergedAccountIds) {
    const stored = readStoredWeixinAccount(paths.accountsDir, accountId)
    const configEntry = hasOwnRecord(configAccounts[accountId]) ? configAccounts[accountId] : {}
    accounts.push({
      accountId,
      configured: Boolean(String(stored?.token || '').trim()),
      baseUrl: String(stored?.baseUrl || '').trim() || undefined,
      userId: String(stored?.userId || '').trim() || undefined,
      enabled:
        typeof configEntry.enabled === 'boolean'
          ? configEntry.enabled
          : true,
      name: String(configEntry.name || '').trim() || undefined,
    })
  }

  accounts.sort((left, right) => left.accountId.localeCompare(right.accountId, 'zh-CN'))
  return accounts
}

export function syncWeixinAccountsIntoConfig(
  config: Record<string, any> | null | undefined,
  accounts: Array<Pick<WeixinAccountState, 'accountId' | 'name' | 'enabled'>>
): Record<string, any> {
  const nextConfig = cloneConfig(config)
  nextConfig.channels = hasOwnRecord(nextConfig.channels) ? nextConfig.channels : {}

  const existingSection = hasOwnRecord(nextConfig.channels['openclaw-weixin'])
    ? nextConfig.channels['openclaw-weixin']
    : {}
  const existingAccounts = hasOwnRecord(existingSection.accounts) ? existingSection.accounts : {}
  const nextAccounts: Record<string, any> = { ...existingAccounts }

  for (const account of accounts) {
    const accountId = sanitizeAccountId(account.accountId)
    if (!accountId) continue
    const existingEntry = hasOwnRecord(existingAccounts[accountId]) ? existingAccounts[accountId] : {}
    nextAccounts[accountId] = {
      ...existingEntry,
      enabled:
        typeof existingEntry.enabled === 'boolean'
          ? existingEntry.enabled
          : account.enabled !== false,
      name:
        String(existingEntry.name || '').trim()
        || String(account.name || '').trim()
        || accountId,
    }
  }

  nextConfig.channels['openclaw-weixin'] = {
    ...existingSection,
    enabled: true,
    accounts: nextAccounts,
  }

  return nextConfig
}

function removeFromAccountIndex(accountIndexPath: string, accountId: string): void {
  const nextIndex = listIndexedAccountIds(accountIndexPath).filter((item) => item !== accountId)
  const directory = path.dirname(accountIndexPath)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(accountIndexPath, JSON.stringify(nextIndex, null, 2), 'utf-8')
}

function safeFrameworkKey(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_')
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.promises.rm(filePath, { force: true })
  } catch {
    // Best effort only.
  }
}

export async function removeWeixinAccountState(accountIdInput: string): Promise<{ ok: boolean }> {
  const accountId = sanitizeAccountId(accountIdInput)
  if (!accountId) {
    return { ok: false }
  }

  const paths = await resolveWeixinStatePaths()
  const rawAccountId = deriveRawAccountId(accountId)
  const candidateIds = Array.from(new Set([accountId, rawAccountId].filter(Boolean) as string[]))

  await Promise.all(
    candidateIds.flatMap((candidateId) => [
      removeIfExists(path.join(paths.accountsDir, `${candidateId}.json`)),
      removeIfExists(path.join(paths.accountsDir, `${candidateId}.sync.json`)),
      removeIfExists(
        path.join(paths.credentialsDir, `${safeFrameworkKey('openclaw-weixin')}-${safeFrameworkKey(candidateId)}-allowFrom.json`)
      ),
    ])
  )

  removeFromAccountIndex(paths.accountIndexPath, accountId)
  return { ok: true }
}
