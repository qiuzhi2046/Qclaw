const childProcess = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

import { probePlatformCommandCapability } from './command-capabilities'
import {
  detectNvmDir,
  detectNvmWindowsDir,
  listInstalledNvmNodeBinDirs,
  listInstalledNvmWindowsNodeExePaths,
} from './nvm-node-runtime'
import {
  DEFAULT_BUNDLED_NODE_REQUIREMENT,
  resolveNodeInstallPlan,
  resolveOpenClawNodeRequirement,
} from './node-installation-policy'
import { isNodeVersionAtLeast } from './node-runtime'
import { resolveNodeInstallStrategy, selectPreferredNodeRuntime } from './node-runtime-selection'
import { buildCliPathWithCandidates, listExecutablePathCandidates } from './runtime-path-discovery'
import { MAIN_RUNTIME_POLICY } from './runtime-policy'
import { resolveSafeWorkingDirectory } from './runtime-working-directory'

export interface QualifiedNodeRuntime {
  executablePath: string
  version: string
  installStrategy: 'nvm' | 'installer'
  source: 'shell' | 'nvm' | 'candidate'
  requiredVersion: string
  targetVersion: string
}

export interface QualifiedNodeRuntimeFailure {
  ok: false
  reason: 'node-unavailable' | 'node-version-unsupported'
  message: string
  requiredVersion: string
  targetVersion: string
  detectedVersions: string[]
}

export type QualifiedNodeRuntimeResult =
  | {
      ok: true
      runtime: QualifiedNodeRuntime
    }
  | QualifiedNodeRuntimeFailure

export interface NodeEvalExecutionResult {
  ok: boolean
  kind: 'completed' | 'script-failed' | 'executor-error' | 'executor-unavailable'
  stdout: string
  stderr: string
  code: number | null
  runtime?: QualifiedNodeRuntime
  runtimeFailure?: QualifiedNodeRuntimeFailure
  timedOut?: boolean
}

// In Electron main-process code, process.execPath points at the Electron host binary,
// not a guaranteed standalone Node executable. Any child task that must run under
// plain Node semantics should resolve a qualified Node runtime through this module
// instead of reusing process.execPath directly.

interface RuntimeCandidateWithPath {
  version: string
  binDir: string | null
  executablePath: string
}

interface ProbeNodeRuntimeOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  currentPath?: string
  detectedNodeBinDir?: string | null
  timeoutMs?: number
}

interface ProbeNodeRuntimeDependencies {
  probeCapability?: typeof probePlatformCommandCapability
  probeVersion?: (
    executablePath: string,
    options: {
      timeoutMs: number
      env: NodeJS.ProcessEnv
      cwd: string
    }
  ) => Promise<string | null>
  resolveRequirement?: typeof resolveOpenClawNodeRequirement
  resolveInstallPlan?: typeof resolveNodeInstallPlan
  detectNvmDir?: typeof detectNvmDir
  detectNvmWindowsDir?: typeof detectNvmWindowsDir
  listInstalledNvmNodeBinDirs?: typeof listInstalledNvmNodeBinDirs
  listInstalledNvmWindowsNodeExePaths?: typeof listInstalledNvmWindowsNodeExePaths
  listExecutablePathCandidates?: typeof listExecutablePathCandidates
  cwdResolver?: typeof resolveSafeWorkingDirectory
}

interface RunNodeEvalOptions extends ProbeNodeRuntimeOptions {
  script: string
  args?: string[]
  timeoutMs?: number
  maxBuffer?: number
}

interface RunNodeEvalDependencies extends ProbeNodeRuntimeDependencies {
  execFile?: typeof childProcess.execFile
}

export function buildNodeSubprocessInstallPlanOptions(
  platform: NodeJS.Platform
): { skipDynamicOpenClawRequirementProbe?: boolean } {
  if (platform === 'win32') {
    return { skipDynamicOpenClawRequirementProbe: true }
  }
  return {}
}

function normalizeVersion(version: string | null | undefined): string {
  return String(version || '').trim()
}

function buildLookupEnv(options: ProbeNodeRuntimeOptions): NodeJS.ProcessEnv {
  const env = options.env || process.env
  return {
    ...env,
    PATH: buildCliPathWithCandidates({
      platform: options.platform || process.platform,
      currentPath:
        options.currentPath !== undefined ? options.currentPath : String(env.PATH || ''),
      detectedNodeBinDir: options.detectedNodeBinDir ?? null,
      env,
    }),
  }
}

async function defaultProbeNodeVersion(
  executablePath: string,
  options: {
    timeoutMs: number
    env: NodeJS.ProcessEnv
    cwd: string
  }
): Promise<string | null> {
  return await new Promise((resolve) => {
    childProcess.execFile(
      executablePath,
      ['--version'],
      {
        env: options.env,
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 256 * 1024,
      },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const version = normalizeVersion(stdout)
        resolve(version || null)
      }
    )
  })
}

function buildUnsupportedNodeFailure(
  requiredVersion: string,
  targetVersion: string,
  detectedVersions: string[]
): QualifiedNodeRuntimeFailure {
  return {
    ok: false,
    reason: detectedVersions.length > 0 ? 'node-version-unsupported' : 'node-unavailable',
    message:
      detectedVersions.length > 0
        ? `已发现 Node (${detectedVersions.join(', ')})，但没有版本满足当前 OpenClaw 最低要求 ${requiredVersion}。`
        : '未能解析可用的 Node.js 可执行文件。',
    requiredVersion,
    targetVersion,
    detectedVersions,
  }
}

async function probeRuntimeCandidate(
  executablePath: string,
  options: {
    timeoutMs: number
    env: NodeJS.ProcessEnv
    cwd: string
  },
  probeVersion: NonNullable<ProbeNodeRuntimeDependencies['probeVersion']>
): Promise<RuntimeCandidateWithPath | null> {
  const version = normalizeVersion(await probeVersion(executablePath, options))
  if (!version) return null
  return {
    version,
    binDir: path.dirname(executablePath),
    executablePath,
  }
}

function candidateMeetsRequirement(
  candidate: RuntimeCandidateWithPath | null,
  requiredVersion: string
): boolean {
  return Boolean(candidate && isNodeVersionAtLeast(candidate.version, requiredVersion))
}

export async function resolveQualifiedNodeRuntime(
  options: ProbeNodeRuntimeOptions = {},
  dependencies: ProbeNodeRuntimeDependencies = {}
): Promise<QualifiedNodeRuntimeResult> {
  const platform = options.platform || process.platform
  const timeoutMs = options.timeoutMs ?? MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs
  const lookupEnv = buildLookupEnv(options)
  const cwdResolver = dependencies.cwdResolver || resolveSafeWorkingDirectory
  const cwd = cwdResolver({ env: lookupEnv, platform })
  const probeCapability = dependencies.probeCapability || probePlatformCommandCapability
  const probeVersion = dependencies.probeVersion || defaultProbeNodeVersion
  const resolveRequirement =
    dependencies.resolveRequirement ||
    (async () => ({ minVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT, source: 'bundled-fallback' as const }))
  const resolveInstallPlan =
    dependencies.resolveInstallPlan ||
    (() => resolveNodeInstallPlan(buildNodeSubprocessInstallPlanOptions(platform)))
  const detectNvmDirImpl = dependencies.detectNvmDir || detectNvmDir
  const detectNvmWindowsDirImpl = dependencies.detectNvmWindowsDir || detectNvmWindowsDir
  const listInstalledNvmNodeBinDirsImpl =
    dependencies.listInstalledNvmNodeBinDirs || listInstalledNvmNodeBinDirs
  const listInstalledNvmWindowsNodeExePathsImpl =
    dependencies.listInstalledNvmWindowsNodeExePaths || listInstalledNvmWindowsNodeExePaths
  const listExecutablePathCandidatesImpl =
    dependencies.listExecutablePathCandidates || listExecutablePathCandidates

  const requirement = await resolveRequirement().catch(() => ({
    minVersion: DEFAULT_BUNDLED_NODE_REQUIREMENT,
    source: 'bundled-fallback' as const,
  }))
  const installPlan = await resolveInstallPlan().catch(() => null)
  const requiredVersion = installPlan?.requiredVersion || requirement.minVersion
  const targetVersion = installPlan?.version || ''
  const detectedVersions = new Set<string>()

  const capability = await probeCapability('node', {
    platform,
    env: lookupEnv,
  })
  const shellCandidate =
    capability.available && capability.resolvedPath
      ? await probeRuntimeCandidate(
          capability.resolvedPath,
          { timeoutMs, env: lookupEnv, cwd },
          probeVersion
        )
      : null
  if (shellCandidate?.version) detectedVersions.add(shellCandidate.version)

  const nvmDir =
    platform !== 'win32'
      ? await detectNvmDirImpl({ env: lookupEnv }).catch(() => null)
      : null
  const nvmWindowsDir =
    platform === 'win32'
      ? await detectNvmWindowsDirImpl({ env: lookupEnv }).catch(() => null)
      : null
  let nvmCandidate: RuntimeCandidateWithPath | null = null

  if (nvmDir) {
    const candidateBins = Array.from(
      new Set(
        [
          targetVersion
            ? path.join(nvmDir, 'versions', 'node', `v${targetVersion.replace(/^v/, '')}`, 'bin')
            : '',
          ...(await listInstalledNvmNodeBinDirsImpl(nvmDir).catch(() => [])),
        ].filter(Boolean)
      )
    )

    for (const candidateBin of candidateBins) {
      const executablePath = path.join(candidateBin, 'node')
      nvmCandidate = await probeRuntimeCandidate(
        executablePath,
        { timeoutMs, env: lookupEnv, cwd },
        probeVersion
      )
      if (nvmCandidate) {
        detectedVersions.add(nvmCandidate.version)
        break
      }
    }
  } else if (nvmWindowsDir) {
    const candidateExePaths = Array.from(
      new Set(
        [
          targetVersion
            ? path.join(nvmWindowsDir, `v${targetVersion.replace(/^v/, '')}`, 'node.exe')
            : '',
          ...(await listInstalledNvmWindowsNodeExePathsImpl(nvmWindowsDir).catch(() => [])),
        ].filter(Boolean)
      )
    )

    for (const executablePath of candidateExePaths) {
      nvmCandidate = await probeRuntimeCandidate(
        executablePath,
        { timeoutMs, env: lookupEnv, cwd },
        probeVersion
      )
      if (nvmCandidate) {
        detectedVersions.add(nvmCandidate.version)
        break
      }
    }
  }

  const effectiveNvmDir = nvmWindowsDir ?? nvmDir
  const preferred = selectPreferredNodeRuntime({
    shellNode: shellCandidate
      ? {
          version: shellCandidate.version,
          binDir: shellCandidate.binDir,
        }
      : null,
    nvmNode: nvmCandidate
      ? {
          version: nvmCandidate.version,
          binDir: nvmCandidate.binDir,
        }
      : null,
    requiredVersion,
    nvmDir: effectiveNvmDir,
  })

  if (preferred) {
    const preferredCandidate =
      shellCandidate &&
      preferred.candidate.version === shellCandidate.version &&
      preferred.candidate.binDir === shellCandidate.binDir
        ? shellCandidate
        : nvmCandidate &&
            preferred.candidate.version === nvmCandidate.version &&
            preferred.candidate.binDir === nvmCandidate.binDir
          ? nvmCandidate
          : null

    if (candidateMeetsRequirement(preferredCandidate, requiredVersion) && preferredCandidate) {
      return {
        ok: true,
        runtime: {
          executablePath: preferredCandidate.executablePath,
          version: preferredCandidate.version,
          installStrategy: preferred.installStrategy,
          source: preferredCandidate === shellCandidate ? 'shell' : 'nvm',
          requiredVersion,
          targetVersion,
        },
      }
    }
  }

  const executableCandidates = listExecutablePathCandidatesImpl('node', {
    platform,
    env: lookupEnv,
    currentPath: String(lookupEnv.PATH || ''),
    detectedNodeBinDir: options.detectedNodeBinDir ?? null,
  })

  for (const executablePath of executableCandidates) {
    const probedCandidate = await probeRuntimeCandidate(
      executablePath,
      { timeoutMs, env: lookupEnv, cwd },
      probeVersion
    )
    if (!probedCandidate) continue
    detectedVersions.add(probedCandidate.version)
    if (!candidateMeetsRequirement(probedCandidate, requiredVersion)) continue

    return {
      ok: true,
      runtime: {
        executablePath: probedCandidate.executablePath,
        version: probedCandidate.version,
        installStrategy: resolveNodeInstallStrategy(probedCandidate.binDir, effectiveNvmDir),
        source: 'candidate',
        requiredVersion,
        targetVersion,
      },
    }
  }

  return buildUnsupportedNodeFailure(requiredVersion, targetVersion, Array.from(detectedVersions))
}

export async function runNodeEvalWithQualifiedRuntime(
  options: RunNodeEvalOptions,
  dependencies: RunNodeEvalDependencies = {}
): Promise<NodeEvalExecutionResult> {
  const resolvedRuntime = await resolveQualifiedNodeRuntime(options, dependencies)
  if (!resolvedRuntime.ok) {
    return {
      ok: false,
      kind: 'executor-unavailable',
      stdout: '',
      stderr: resolvedRuntime.message,
      code: null,
      runtimeFailure: resolvedRuntime,
    }
  }

  const execFile = dependencies.execFile || childProcess.execFile
  const env = {
    ...buildLookupEnv(options),
  }
  const cwd = (dependencies.cwdResolver || resolveSafeWorkingDirectory)({
    env,
    platform: options.platform || process.platform,
  })

  return await new Promise((resolve) => {
    execFile(
      resolvedRuntime.runtime.executablePath,
      ['--input-type=module', '--eval', options.script, ...(options.args || [])],
      {
        env,
        cwd,
        timeout: options.timeoutMs ?? MAIN_RUNTIME_POLICY.cli.lightweightProbeTimeoutMs,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const normalizedStdout = String(stdout || '')
        const normalizedStderr = String(stderr || '')
        if (!error) {
          resolve({
            ok: true,
            kind: 'completed',
            stdout: normalizedStdout,
            stderr: normalizedStderr,
            code: 0,
            runtime: resolvedRuntime.runtime,
          })
          return
        }

        const execError = error as NodeJS.ErrnoException & { code?: string | number | null; killed?: boolean }
        const timedOut = execError.killed || execError.code === 'ETIMEDOUT'
        const executorError = typeof execError.code === 'string' && execError.code !== 'ETIMEDOUT'
        const exitCode =
          typeof execError.code === 'number'
            ? execError.code
            : timedOut
              ? null
              : executorError
                ? null
                : 1
        resolve({
          ok: false,
          kind: timedOut || executorError ? 'executor-error' : 'script-failed',
          stdout: normalizedStdout,
          stderr: normalizedStderr || String(execError.message || execError),
          code: exitCode,
          runtime: resolvedRuntime.runtime,
          timedOut,
        })
      }
    )
  })
}
