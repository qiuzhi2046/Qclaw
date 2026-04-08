import { pruneStalePluginConfigEntries } from './openclaw-config-warnings'
import { runNodeEvalWithQualifiedRuntime } from './node-subprocess-runtime'
import { formatDisplayPath } from './openclaw-paths'
import {
  getManagedChannelPluginByPluginId,
  isOfficialManagedPluginId,
  listManagedChannelPluginRecords,
} from '../../src/shared/managed-channel-plugin-registry'

const { createRequire } = process.getBuiltinModule('node:module') as typeof import('node:module')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const { mkdir, readFile, readdir, rename, stat } =
  process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')

export interface IncompatibleExtensionPlugin {
  pluginId: string
  packageName: string
  installPath: string
  displayInstallPath: string
  reason: string
}

export interface ReconcileIncompatibleExtensionsResult {
  incompatiblePlugins: IncompatibleExtensionPlugin[]
  quarantinedPluginIds: string[]
  prunedPluginIds: string[]
  failureKind?: 'permission-denied' | 'filesystem-write-failed' | 'partial-quarantine'
  failedPluginIds?: string[]
  failedPaths?: string[]
}

export interface RepairIncompatibleExtensionsResult extends ReconcileIncompatibleExtensionsResult {
  ok: boolean
  repaired: boolean
  summary: string
  stderr: string
}

interface PluginInstallSafetyOptions {
  homeDir: string
  readConfig?: () => Promise<Record<string, any> | null>
  writeConfig?: (config: Record<string, any>) => Promise<void>
  now?: () => number
  runNodeEval?: typeof runNodeEvalWithQualifiedRuntime
  scopePluginIds?: string[]
  quarantineOfficialManagedPlugins?: boolean
  mkdirDirectory?: typeof mkdir
  renameDirectory?: typeof rename
}

interface ExtensionPackageManifest {
  name?: string
  openclaw?: {
    extensions?: string[]
  }
}

const MANAGED_CHANNEL_PLUGIN_RECORDS = listManagedChannelPluginRecords()

function normalizePluginIds(values: string[] | undefined): string[] {
  return [...new Set((values || []).map((item) => String(item || '').trim()).filter(Boolean))]
}

function getManagedPluginRecord(pluginId: string) {
  const normalizedPluginId = String(pluginId || '').trim().toLowerCase()
  return MANAGED_CHANNEL_PLUGIN_RECORDS.find((record) => record.pluginId.toLowerCase() === normalizedPluginId)
}

function shouldQuarantineOfficialManagedPlugin(
  pluginId: string,
  options: Pick<PluginInstallSafetyOptions, 'scopePluginIds' | 'quarantineOfficialManagedPlugins'>
): boolean {
  if (!isOfficialManagedPluginId(pluginId)) return true
  if (options.quarantineOfficialManagedPlugins !== true) return false

  const record = getManagedPluginRecord(pluginId)
  if (!record) return true

  const scopedPluginIds = normalizePluginIds(options.scopePluginIds)
  const isScopedRepair = scopedPluginIds.length > 0
  if (isScopedRepair) return true

  return record.smokeTestPolicy === 'strict'
}

function hasOwnRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeComparablePath(value: string): string {
  return value ? path.resolve(value) : ''
}

function looksLikePluginSdkResolutionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /Cannot find module ['"]openclaw\/plugin-sdk['"]/.test(message)
}

function looksLikePluginSdkCompatibilityFailure(detail: string): boolean {
  const text = String(detail || '').toLowerCase()
  if (!text) return false
  const mentionsPluginSdk = /plugin-sdk|pluginsdk/.test(text)
  if (!mentionsPluginSdk) return false
  return (
    /is not a function/.test(text)
    || /does not provide an export named/.test(text)
    || /named export .* not found/.test(text)
    || /cannot read (?:properties|property) of undefined/.test(text)
  )
}

function looksLikeHostPluginSdkImportFailure(detail: string): boolean {
  const text = String(detail || '')
  return /cannot find module ['"]openclaw\/plugin-sdk(?:\/[^'"]+)?['"]|cannot find package ['"]openclaw['"]|err_module_not_found[\s\S]*openclaw(?:\/plugin-sdk)?/i.test(text)
}

function shouldSkipManagedPluginQuarantine(params: {
  pluginId: string
  pluginSdkResolutionFailure: boolean
  pluginSdkCompatibilityFailure: boolean
  smokeTestFailure: string
}): boolean {
  const { pluginId, pluginSdkResolutionFailure, pluginSdkCompatibilityFailure, smokeTestFailure } = params
  const managedPlugin = getManagedChannelPluginByPluginId(pluginId)
  if (!managedPlugin) return false

  // Personal Weixin is shipped as an interactive-installer plugin whose entry imports
  // host-only OpenClaw runtime helpers. The generic Node smoke test in this file is not
  // a reliable compatibility signal for that package, so quarantining it causes false
  // positives and breaks unrelated features such as skills listing/install.
  return managedPlugin.channelId === 'openclaw-weixin'
    || (
      (managedPlugin.channelId === 'wecom' || managedPlugin.channelId === 'dingtalk')
      && pluginSdkResolutionFailure
      && !pluginSdkCompatibilityFailure
      && looksLikeHostPluginSdkImportFailure(smokeTestFailure)
    )
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

async function pluginTreeReferencesPluginSdk(rootPath: string): Promise<boolean> {
  let rootStat: Awaited<ReturnType<typeof stat>>
  try {
    rootStat = await stat(rootPath)
  } catch {
    return false
  }

  if (rootStat.isFile()) {
    try {
      const source = await readFile(rootPath, 'utf8')
      return /\bopenclaw\/plugin-sdk\b/.test(source)
    } catch {
      return false
    }
  }

  if (!rootStat.isDirectory()) return false

  let entries: Array<import('node:fs').Dirent<string>>
  try {
    entries = await readdir(rootPath, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return false
  }

  for (const entry of entries) {
    const childPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      if (await pluginTreeReferencesPluginSdk(childPath)) return true
      continue
    }
    if (await pluginTreeReferencesPluginSdk(childPath)) return true
  }

  return false
}

async function smokeTestPluginEntry(
  entryPath: string,
  options: Pick<PluginInstallSafetyOptions, 'runNodeEval'>
): Promise<{ ok: boolean; stderr: string }> {
  const script = `
    import { pathToFileURL } from 'node:url'
    try {
      await import(pathToFileURL(process.argv[1]).href)
    } catch (error) {
      console.error(error?.stack || error?.message || String(error))
      process.exit(1)
    }
  `

  const runNodeEval = options.runNodeEval || runNodeEvalWithQualifiedRuntime
  const result = await runNodeEval({
    script,
    args: [entryPath],
  })
  const mergedStderr = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()

  if (result.ok) {
    return {
      ok: true,
      stderr: mergedStderr,
    }
  }

  if (result.kind === 'script-failed') {
    return {
      ok: false,
      stderr: mergedStderr || '插件入口导入失败',
    }
  }

  const detail = result.runtimeFailure?.message || mergedStderr || '未知执行器错误'
  if (result.kind === 'executor-unavailable') {
    throw new Error(`插件导入 smoke test 执行器不可用: ${detail}`)
  }
  if (result.timedOut) {
    throw new Error(`插件导入 smoke test 超时: ${entryPath}`)
  }
  throw new Error(`插件导入 smoke test 执行失败: ${detail}`)
}

async function findIncompatibleExtensionPlugins(
  options: Pick<
    PluginInstallSafetyOptions,
    'homeDir' | 'runNodeEval' | 'scopePluginIds' | 'quarantineOfficialManagedPlugins'
  >
): Promise<IncompatibleExtensionPlugin[]> {
  const homeDir = options.homeDir
  const scopedPluginIds = normalizePluginIds(options.scopePluginIds)
  const extensionsDir = path.join(homeDir, 'extensions')
  let entries: Array<import('node:fs').Dirent<string>>

  try {
    entries = await readdir(extensionsDir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }

  const incompatible: IncompatibleExtensionPlugin[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (scopedPluginIds.length > 0 && !scopedPluginIds.includes(entry.name)) continue

    const pluginDir = path.join(extensionsDir, entry.name)
    const packageJsonPath = path.join(pluginDir, 'package.json')
    const manifest = await readJsonFile<ExtensionPackageManifest>(packageJsonPath)
    if (!manifest) continue

    const extensionEntries = Array.isArray(manifest.openclaw?.extensions)
      ? manifest.openclaw?.extensions.filter((item) => typeof item === 'string' && item.trim())
      : []
    if (extensionEntries.length === 0) continue
    const referencesPluginSdk = await pluginTreeReferencesPluginSdk(pluginDir)
    if (!referencesPluginSdk) continue

    let smokeTestFailure: string | null = null
    for (const extensionEntry of extensionEntries) {
      const entryPath = path.join(pluginDir, extensionEntry)
      const smokeTest = await smokeTestPluginEntry(entryPath, options)
      if (smokeTest.ok) continue
      smokeTestFailure = smokeTest.stderr
      const pluginSdkCompatibilityFailure = looksLikePluginSdkCompatibilityFailure(smokeTestFailure || '')
      let pluginSdkResolutionFailure = false
      try {
        createRequire(packageJsonPath).resolve('openclaw/plugin-sdk')
      } catch (error) {
        if (!looksLikePluginSdkResolutionFailure(error)) {
          continue
        }
        pluginSdkResolutionFailure = true
      }
      if (!pluginSdkResolutionFailure && !pluginSdkCompatibilityFailure) {
        continue
      }
      if (!shouldQuarantineOfficialManagedPlugin(entry.name, options)) {
        break
      }
      if (
        shouldSkipManagedPluginQuarantine({
          pluginId: entry.name,
          pluginSdkResolutionFailure,
          pluginSdkCompatibilityFailure,
          smokeTestFailure: smokeTestFailure || '',
        })
      ) {
        break
      }
      incompatible.push({
        pluginId: entry.name,
        packageName: String(manifest.name || entry.name).trim() || entry.name,
        installPath: pluginDir,
        displayInstallPath: formatDisplayPath(pluginDir),
        reason: `插件导入 smoke test 失败：${smokeTestFailure || "无法加载插件入口"} `,
      })
      break
    }
  }

  return incompatible
}

async function loadCurrentConfig(
  options: Pick<PluginInstallSafetyOptions, 'readConfig'>
): Promise<Record<string, any> | null> {
  if (options.readConfig) {
    return options.readConfig().catch(() => null)
  }

  const cli = await import('./cli')
  return cli.readConfig().catch(() => null)
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

async function findOrphanedManagedPluginConfigIds(
  homeDir: string,
  config: Record<string, any> | null | undefined,
  scopePluginIds: string[] = []
): Promise<string[]> {
  if (!config || typeof config !== 'object') return []

  const normalizedScopePluginIds = normalizePluginIds(scopePluginIds)
  const installs = hasOwnRecord(config.plugins?.installs) ? config.plugins.installs : {}
  const entries = hasOwnRecord(config.plugins?.entries) ? config.plugins.entries : {}
  const channels = hasOwnRecord(config.channels) ? config.channels : {}
  const orphanedPluginIds: string[] = []

  for (const record of MANAGED_CHANNEL_PLUGIN_RECORDS) {
    const pluginId = record.pluginId
    const channelIds = record.cleanupChannelIds
    if (
      normalizedScopePluginIds.length > 0
      && !normalizePluginIds([pluginId, ...record.cleanupPluginIds]).some((candidate) =>
        normalizedScopePluginIds.includes(candidate)
      )
    ) {
      continue
    }

    const hasInstall = hasOwnRecord(installs) && Object.prototype.hasOwnProperty.call(installs, pluginId)
    const hasEntry = hasOwnRecord(entries) && Object.prototype.hasOwnProperty.call(entries, pluginId)
    const hasChannel = channelIds.some((channelId) => Object.prototype.hasOwnProperty.call(channels, channelId))
    if (!hasInstall && !hasEntry && !hasChannel) continue

    const canonicalInstallPath = path.join(homeDir, 'extensions', pluginId)
    const canonicalInstallPathComparable = normalizeComparablePath(canonicalInstallPath)
    const configuredInstallPaths = [
      String(installs?.[pluginId]?.installPath || '').trim(),
      String(entries?.[pluginId]?.installPath || '').trim(),
    ].filter(Boolean)
    const hasNonCanonicalInstallPath = configuredInstallPaths.some(
      (configuredInstallPath) => normalizeComparablePath(configuredInstallPath) !== canonicalInstallPathComparable
    )

    if (hasNonCanonicalInstallPath) {
      orphanedPluginIds.push(pluginId)
      continue
    }

    const expectedInstallPath = configuredInstallPaths[0] || canonicalInstallPath
    if (await pathExists(expectedInstallPath)) continue

    orphanedPluginIds.push(pluginId)
  }

  return orphanedPluginIds
}

async function quarantinePlugins(
  incompatiblePlugins: IncompatibleExtensionPlugin[],
  homeDir: string,
  now: () => number,
  options: Pick<PluginInstallSafetyOptions, 'mkdirDirectory' | 'renameDirectory'>
): Promise<ReconcileIncompatibleExtensionsResult> {
  if (incompatiblePlugins.length === 0) {
    return {
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
    }
  }

  const quarantineRoot = path.join(homeDir, 'qclaw-quarantined-extensions')
  const mkdirDirectory = options.mkdirDirectory || mkdir
  const renameDirectory = options.renameDirectory || rename
  try {
    await mkdirDirectory(quarantineRoot, { recursive: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = (error as NodeJS.ErrnoException | undefined)?.code || ''
    return {
      incompatiblePlugins,
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      failureKind: /eacces|eperm/i.test(code) || /permission denied|operation not permitted/i.test(message)
        ? 'permission-denied'
        : 'filesystem-write-failed',
      failedPluginIds: incompatiblePlugins.map((plugin) => plugin.pluginId),
      failedPaths: incompatiblePlugins.map((plugin) => plugin.installPath),
    }
  }

  const quarantinedPluginIds: string[] = []
  for (const plugin of incompatiblePlugins) {
    const timestamp = now()
    const targetPath = path.join(quarantineRoot, `${plugin.pluginId}-${timestamp}`)
    try {
      await renameDirectory(plugin.installPath, targetPath)
      quarantinedPluginIds.push(plugin.pluginId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = (error as NodeJS.ErrnoException | undefined)?.code || ''
      return {
        incompatiblePlugins,
        quarantinedPluginIds,
        prunedPluginIds: [],
        failureKind: quarantinedPluginIds.length > 0
          ? 'partial-quarantine'
          : /eacces|eperm/i.test(code) || /permission denied|operation not permitted/i.test(message)
            ? 'permission-denied'
            : 'filesystem-write-failed',
        failedPluginIds: [plugin.pluginId],
        failedPaths: [plugin.installPath],
      }
    }
  }

  return {
    incompatiblePlugins,
    quarantinedPluginIds,
    prunedPluginIds: [],
  }
}

export async function reconcileIncompatibleExtensionPlugins(
  options: PluginInstallSafetyOptions
): Promise<ReconcileIncompatibleExtensionsResult> {
  const now = options.now || (() => Date.now())
  const normalizedScopePluginIds = normalizePluginIds(options.scopePluginIds)
  const incompatiblePlugins = await findIncompatibleExtensionPlugins(options)
  const quarantineResult = incompatiblePlugins.length > 0
    ? await quarantinePlugins(incompatiblePlugins, options.homeDir, now, options)
    : {
        incompatiblePlugins,
        quarantinedPluginIds: [],
        prunedPluginIds: [],
      }
  const quarantinedPluginIds = quarantineResult.quarantinedPluginIds
  const currentConfig = await loadCurrentConfig(options)
  if (quarantineResult.failureKind) {
    return {
      ...quarantineResult,
      incompatiblePlugins,
      prunedPluginIds: [],
    }
  }
  const orphanedPluginIds = normalizedScopePluginIds.length > 0
    ? await findOrphanedManagedPluginConfigIds(
        options.homeDir,
        currentConfig,
        normalizedScopePluginIds
      )
    : []
  const stalePluginIds = normalizePluginIds([...quarantinedPluginIds, ...orphanedPluginIds])
  let prunedPluginIds: string[] = []

  if (stalePluginIds.length > 0) {
    const pruneResult = await pruneStalePluginConfigEntries(stalePluginIds, {
      readConfig: options.readConfig || (async () => currentConfig),
      writeConfig: options.writeConfig,
    })
    prunedPluginIds =
      pruneResult.removedPluginIds.length > 0
        ? pruneResult.removedPluginIds
        : pruneResult.changed
          ? stalePluginIds
          : []
  }

  return {
    incompatiblePlugins,
    quarantinedPluginIds,
    prunedPluginIds,
  }
}

export function buildIncompatiblePluginRepairSummary(
  reconcileResult: ReconcileIncompatibleExtensionsResult
): string {
  if (reconcileResult.quarantinedPluginIds.length > 0) {
    return `已自动隔离 ${reconcileResult.quarantinedPluginIds.length} 个损坏插件并清理相关配置。`
  }
  if (reconcileResult.prunedPluginIds.length > 0) {
    return `已自动清理 ${reconcileResult.prunedPluginIds.length} 个损坏插件残留配置。`
  }
  if (reconcileResult.quarantinedPluginIds.length === 0) {
    return '未发现损坏插件。'
  }
  return '未发现损坏插件。'
}

export async function repairIncompatibleExtensionPlugins(
  options: PluginInstallSafetyOptions
): Promise<RepairIncompatibleExtensionsResult> {
  try {
    const reconcileResult = await reconcileIncompatibleExtensionPlugins(options)
    if (reconcileResult.failureKind) {
      return {
        ok: false,
        repaired: reconcileResult.quarantinedPluginIds.length > 0 || reconcileResult.prunedPluginIds.length > 0,
        summary: reconcileResult.failureKind === 'permission-denied'
          ? '损坏插件隔离失败，请检查本机权限后重试。'
          : reconcileResult.failureKind === 'partial-quarantine'
            ? '损坏插件隔离未完成，请重试。'
            : '损坏插件隔离失败，请重试。',
        stderr: '',
        ...reconcileResult,
      }
    }

    return {
      ok: true,
      repaired: reconcileResult.quarantinedPluginIds.length > 0 || reconcileResult.prunedPluginIds.length > 0,
      summary: buildIncompatiblePluginRepairSummary(reconcileResult),
      stderr: '',
      ...reconcileResult,
    }
  } catch (error) {
    return {
      ok: false,
      repaired: false,
      incompatiblePlugins: [],
      quarantinedPluginIds: [],
      prunedPluginIds: [],
      summary: '修复损坏插件环境失败，请重试。',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}

export function finalizePluginInstallSafetyResult(
  installResult: {
    ok: boolean
    stdout: string
    stderr: string
    code: number | null
  },
  reconcileResult: ReconcileIncompatibleExtensionsResult,
  expectedPluginIds: string[] = []
): {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
} {
  if (reconcileResult.quarantinedPluginIds.length === 0) {
    return installResult
  }

  const expectedIds = normalizePluginIds(expectedPluginIds)
  const affectedExpectedPlugin = expectedIds.some((pluginId) =>
    reconcileResult.quarantinedPluginIds.includes(pluginId)
  )

  const summary = buildIncompatiblePluginRepairSummary(reconcileResult)

  if (affectedExpectedPlugin) {
    return {
      ok: false,
      stdout: installResult.stdout,
      stderr: [installResult.stderr, summary].filter(Boolean).join('\n\n'),
      code: 1,
    }
  }

  return {
    ...installResult,
    stdout: [installResult.stdout, summary].filter(Boolean).join('\n\n'),
  }
}
