const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
import { buildAppleScriptDoShellScript, buildMacNpmCommand } from './node-runtime'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import { withManagedOperationLock } from './managed-operation-lock'
import type { CliResult } from './cli'

export type OAuthExternalDependencyId = 'gemini-cli'
export type OAuthExternalDependencyInstallMethod = 'brew' | 'npm'
export type OAuthExternalDependencyWarningId = 'google-cloud-project-missing'

export interface OAuthExternalDependencyInstallOption {
  method: OAuthExternalDependencyInstallMethod
  label: string
  commandPreview: string
}

export interface OAuthExternalDependencyWarning {
  id: OAuthExternalDependencyWarningId
  title: string
  message: string
}

export interface OAuthExternalDependencyPreflightAction {
  dependencyId: OAuthExternalDependencyId
  title: string
  message: string
  commandName: string
  recommendedMethod?: OAuthExternalDependencyInstallMethod
  installOptions: OAuthExternalDependencyInstallOption[]
}

export interface OAuthExternalDependencyInspectionResult {
  ready: boolean
  satisfiedBy?: 'env' | 'command'
  action?: OAuthExternalDependencyPreflightAction
  warnings?: OAuthExternalDependencyWarning[]
}

export interface InstallOAuthExternalDependencyRequest {
  dependencyId: OAuthExternalDependencyId
  method?: OAuthExternalDependencyInstallMethod
}

export interface InstallOAuthExternalDependencyResult extends CliResult {
  dependencyId: OAuthExternalDependencyId
  method?: OAuthExternalDependencyInstallMethod
  message?: string
}

interface OAuthDependencyRuntimeOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  readEnvFile?: () => Promise<Record<string, string>>
  runShell?: (command: string, args: string[], timeout?: number) => Promise<CliResult>
  runDirect?: (command: string, args: string[], timeout?: number) => Promise<CliResult>
  refreshEnvironment?: () => Promise<{ ok: boolean; newPath?: string }>
  waitForCommandAvailable?: (
    command: string,
    args?: string[],
    maxWait?: number,
    interval?: number
  ) => Promise<{ ok: boolean; stdout?: string; stderr?: string }>
  checkPathWritable?: (targetPath: string) => Promise<boolean>
}

const GEMINI_CLIENT_ID_KEYS = ['OPENCLAW_GEMINI_OAUTH_CLIENT_ID', 'GEMINI_CLI_OAUTH_CLIENT_ID']
const GEMINI_PROJECT_KEYS = ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID']
const GEMINI_NPM_PACKAGE = '@google/gemini-cli'
const RUNTIME_INSTALL_LOCK_KEY = 'runtime-install'

function resolvePlatform(options: OAuthDependencyRuntimeOptions): NodeJS.Platform {
  return options.platform || process.platform
}

function resolveRuntimeEnv(options: OAuthDependencyRuntimeOptions): NodeJS.ProcessEnv {
  return options.env || process.env
}

async function defaultReadEnvFile(): Promise<Record<string, string>> {
  const cli = await import('./cli')
  return cli.readEnvFile()
}

async function defaultRunShell(command: string, args: string[], timeout?: number): Promise<CliResult> {
  const cli = await import('./cli')
  return cli.runShell(command, args, timeout, 'oauth')
}

async function defaultRunDirect(command: string, args: string[], timeout?: number): Promise<CliResult> {
  const cli = await import('./cli')
  return cli.runDirect(command, args, timeout, 'oauth')
}

async function defaultRefreshEnvironment(): Promise<{ ok: boolean; newPath?: string }> {
  const cli = await import('./cli')
  return cli.refreshEnvironment()
}

async function defaultWaitForCommandAvailable(
  command: string,
  args?: string[],
  maxWait?: number,
  interval?: number
): Promise<{ ok: boolean; stdout?: string; stderr?: string }> {
  const cli = await import('./cli')
  return cli.waitForCommandAvailable(command, args, maxWait, interval, 'oauth')
}

function firstPresentEnvValue(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = String(env[key] || '').trim()
    if (value) return value
  }
  return undefined
}

function buildGeminiCliMissingMessage(): string {
  return [
    '未检测到 Gemini 命令行工具。',
    'Google Gemini 浏览器授权登录依赖本机安装 gemini 命令行工具，或显式设置 GEMINI_CLI_OAUTH_CLIENT_ID / GEMINI_CLI_OAUTH_CLIENT_SECRET。',
    'Qclaw 会先静默探测 npm / Homebrew 是否可用，只展示当前机器可执行的一键安装入口。',
  ].join(' ')
}

function buildGeminiProjectEnvWarningMessage(): string {
  return [
    '部分 Google 账号在网页授权成功后，仍需要设置 GOOGLE_CLOUD_PROJECT 或 GOOGLE_CLOUD_PROJECT_ID。',
    '如果缺少项目 ID，Gemini 浏览器授权登录可能会在 Google Cloud project 发现阶段失败，导致凭证无法落盘。',
  ].join(' ')
}

function buildGeminiProjectEnvFailureMessage(): string {
  return [
    'Gemini 浏览器授权登录回调已完成，但当前环境未设置 GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_PROJECT_ID。',
    '部分 Google 账号会在 Google Cloud project 发现阶段失败，因此凭证不会落盘。',
    '请先在 OpenClaw 的 .env 或系统环境中设置项目 ID 后重试。',
  ].join(' ')
}

export {
  buildGeminiCliMissingMessage,
  buildGeminiProjectEnvFailureMessage,
  buildGeminiProjectEnvWarningMessage,
}

function buildGeminiProjectEnvWarning(): OAuthExternalDependencyWarning {
  return {
    id: 'google-cloud-project-missing',
    title: '可能需要 Google Cloud 项目 ID',
    message: buildGeminiProjectEnvWarningMessage(),
  }
}

function buildGeminiInstallOptions(platform: NodeJS.Platform, methods: OAuthExternalDependencyInstallMethod[]): OAuthExternalDependencyInstallOption[] {
  return methods.map((method) => {
    if (method === 'brew') {
      return {
        method,
        label: '使用 Homebrew 安装',
        commandPreview: 'brew install gemini-cli',
      }
    }

    return {
      method,
      label: platform === 'darwin' ? '使用 npm 全局安装（需要授权）' : '使用 npm 全局安装',
      commandPreview: `npm install -g ${GEMINI_NPM_PACKAGE}`,
    }
  })
}

async function resolveInstallMethods(options: OAuthDependencyRuntimeOptions): Promise<OAuthExternalDependencyInstallMethod[]> {
  const runShell = options.runShell || defaultRunShell
  const checkPathWritable =
    options.checkPathWritable ||
    (async (targetPath: string) => {
      try {
        await fs.promises.access(targetPath, fs.constants.W_OK)
        return true
      } catch {
        return false
      }
    })
  const methods: OAuthExternalDependencyInstallMethod[] = []
  const platform = resolvePlatform(options)

  const npmResult = await runShell('npm', ['--version'], MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs)
  if (npmResult.ok && String(npmResult.stdout || '').trim()) {
    methods.push('npm')
  }

  if (platform === 'darwin') {
    const brewResult = await runShell('brew', ['--version'], MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs)
    if (brewResult.ok && String(brewResult.stdout || '').trim()) {
      const prefixResult = await runShell('brew', ['--prefix'], MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs)
      const prefixPath = String(prefixResult.stdout || '').trim()
      if (prefixResult.ok && prefixPath && (await checkPathWritable(prefixPath))) {
        methods.push('brew')
      }
    }
  }

  return methods
}

export async function inspectOAuthDependencyForAuthChoice(
  authChoice: string,
  options: OAuthDependencyRuntimeOptions = {}
): Promise<OAuthExternalDependencyInspectionResult> {
  if (String(authChoice || '').trim().toLowerCase() !== 'google-gemini-cli') {
    return { ready: true }
  }

  const readEnvFile = options.readEnvFile || defaultReadEnvFile
  const runShell = options.runShell || defaultRunShell
  const runtimeEnv = resolveRuntimeEnv(options)
  const envFromFile = await readEnvFile()
  const mergedEnv = {
    ...runtimeEnv,
    ...envFromFile,
  }
  const warnings = firstPresentEnvValue(mergedEnv, GEMINI_PROJECT_KEYS)
    ? []
    : [buildGeminiProjectEnvWarning()]

  if (firstPresentEnvValue(mergedEnv, GEMINI_CLIENT_ID_KEYS)) {
    return {
      ready: true,
      satisfiedBy: 'env',
      warnings,
    }
  }

  const geminiResult = await runShell('gemini', ['--version'], MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs)
  if (geminiResult.ok) {
    return {
      ready: true,
      satisfiedBy: 'command',
      warnings,
    }
  }

  const platform = resolvePlatform(options)
  const installMethods = await resolveInstallMethods(options)
  const installOptions = buildGeminiInstallOptions(platform, installMethods)
  const recommendedMethod = installOptions[0]?.method

  return {
    ready: false,
    warnings,
    action: {
      dependencyId: 'gemini-cli',
      title: '安装 Gemini 命令行工具',
      message: buildGeminiCliMissingMessage(),
      commandName: 'gemini',
      ...(recommendedMethod ? { recommendedMethod } : {}),
      installOptions,
    },
  }
}

function successInstallResult(
  dependencyId: OAuthExternalDependencyId,
  method: OAuthExternalDependencyInstallMethod | undefined,
  stdout: string,
  message: string
): InstallOAuthExternalDependencyResult {
  return {
    ok: true,
    stdout,
    stderr: '',
    code: 0,
    dependencyId,
    method,
    message,
  }
}

function failureInstallResult(
  dependencyId: OAuthExternalDependencyId,
  method: OAuthExternalDependencyInstallMethod | undefined,
  stderr: string,
  code: number | null = 1
): InstallOAuthExternalDependencyResult {
  return {
    ok: false,
    stdout: '',
    stderr,
    code,
    dependencyId,
    method,
    message: stderr,
  }
}

export async function installOAuthExternalDependency(
  request: InstallOAuthExternalDependencyRequest,
  options: OAuthDependencyRuntimeOptions = {}
): Promise<InstallOAuthExternalDependencyResult> {
  if (request.dependencyId !== 'gemini-cli') {
    return failureInstallResult(request.dependencyId, request.method, `Unsupported dependency: ${request.dependencyId}`)
  }

  const inspection = await inspectOAuthDependencyForAuthChoice('google-gemini-cli', options)
  if (inspection.ready) {
    return successInstallResult('gemini-cli', request.method, '', 'Gemini 命令行工具已可用，无需重复安装。')
  }

  const installOptions = inspection.action?.installOptions || []
  const method =
    request.method ||
    inspection.action?.recommendedMethod ||
    installOptions[0]?.method

  if (!method) {
    return failureInstallResult(
      'gemini-cli',
      request.method,
      '当前环境未发现可用的一键安装方式。请先确认 npm 命令可用；如果计划使用 Homebrew，请先修复其安装目录权限后再试。'
    )
  }

  if (!installOptions.some((option) => option.method === method)) {
    return failureInstallResult(
      'gemini-cli',
      method,
      `当前环境不可用安装方式：${method}。请使用 Qclaw 当前推荐的可用安装方式。`
    )
  }

  const runShell = options.runShell || defaultRunShell
  const runDirect = options.runDirect || defaultRunDirect
  const refreshEnvironment = options.refreshEnvironment || defaultRefreshEnvironment
  const waitForCommandAvailable = options.waitForCommandAvailable || defaultWaitForCommandAvailable
  const platform = resolvePlatform(options)

  const installResult: CliResult = await withManagedOperationLock(RUNTIME_INSTALL_LOCK_KEY, async () => {
    if (method === 'brew') {
      return runShell(
        'brew',
        ['install', 'gemini-cli'],
        MAIN_RUNTIME_POLICY.node.installOpenClawTimeoutMs
      )
    }

    if (platform === 'darwin') {
      const cmd = buildMacNpmCommand(['install', '-g', GEMINI_NPM_PACKAGE], {
        user: os.userInfo().username,
        npmCacheDir: path.join(os.homedir(), '.npm'),
      })
      return runDirect(
        'osascript',
        [
          '-e',
          buildAppleScriptDoShellScript(cmd, {
            prompt:
              'Qclaw 需要安装 Gemini 命令行工具。\n\n这是 Google Gemini 浏览器授权登录的前置依赖。\n\n请输入您的 Mac 登录密码以继续。',
          })
        ],
        MAIN_RUNTIME_POLICY.node.installOpenClawTimeoutMs
      )
    }

    return runShell(
      'npm',
      ['install', '-g', GEMINI_NPM_PACKAGE],
      MAIN_RUNTIME_POLICY.node.installOpenClawTimeoutMs
    )
  })

  if (!installResult.ok) {
    return failureInstallResult(
      'gemini-cli',
      method,
      String(installResult.stderr || installResult.stdout || 'Gemini command-line tool install failed').trim(),
      installResult.code
    )
  }

  await refreshEnvironment()
  const availabilityResult = await waitForCommandAvailable('gemini', ['--version'])
  if (!availabilityResult.ok) {
    return failureInstallResult(
      'gemini-cli',
      method,
      availabilityResult.stderr || 'Gemini 命令行工具安装完成，但当前环境暂未检测到 gemini 命令。'
    )
  }

  return successInstallResult(
    'gemini-cli',
    method,
    String(installResult.stdout || availabilityResult.stdout || '').trim(),
    `Gemini 命令行工具已安装完成（${method}）。请重新发起 Google Gemini 浏览器授权登录。`
  )
}
