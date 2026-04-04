import { isNodeVersionAtLeast } from './node-runtime'

export interface DetectedNodeRuntimeCandidate {
  version: string
  binDir: string | null
}

function isNodeVersionGreater(leftVersion: string, rightVersion: string): boolean {
  return (
    isNodeVersionAtLeast(leftVersion, rightVersion) &&
    !isNodeVersionAtLeast(rightVersion, leftVersion)
  )
}

export function resolveNodeInstallStrategy(
  binDir: string | null | undefined,
  nvmDir: string | null | undefined
): 'nvm' | 'installer' {
  const normalizedBinDir = String(binDir || '').trim().replace(/\\/g, '/').toLowerCase()
  if (!normalizedBinDir) return 'installer'
  if (normalizedBinDir.includes('/.nvm/')) return 'nvm'

  const normalizedNvmDir = String(nvmDir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  if (!normalizedNvmDir) return 'installer'
  return normalizedBinDir.startsWith(`${normalizedNvmDir}/`) ? 'nvm' : 'installer'
}

export function selectPreferredNodeRuntime(options: {
  shellNode?: DetectedNodeRuntimeCandidate | null
  nvmNode?: DetectedNodeRuntimeCandidate | null
  requiredVersion: string
  nvmDir?: string | null
}): {
  candidate: DetectedNodeRuntimeCandidate
  installStrategy: 'nvm' | 'installer'
} | null {
  const shellNode = options.shellNode || null
  const nvmNode = options.nvmNode || null
  const shellInstallStrategy = resolveNodeInstallStrategy(shellNode?.binDir, options.nvmDir)

  if (nvmNode) {
    const shellMeetsRequirement = shellNode
      ? isNodeVersionAtLeast(shellNode.version, options.requiredVersion)
      : false
    const nvmMeetsRequirement = isNodeVersionAtLeast(nvmNode.version, options.requiredVersion)
    const shouldKeepShellNode =
      Boolean(shellNode) &&
      (
        (shellInstallStrategy === 'installer' && shellMeetsRequirement && !nvmMeetsRequirement) ||
        (shellInstallStrategy === 'nvm' &&
          ((shellMeetsRequirement && !nvmMeetsRequirement) ||
            isNodeVersionGreater(shellNode!.version, nvmNode.version)))
      )

    if (shouldKeepShellNode && shellNode) {
      return {
        candidate: shellNode,
        installStrategy: shellInstallStrategy,
      }
    }

    return {
      candidate: nvmNode,
      installStrategy: 'nvm',
    }
  }

  if (!shellNode) return null
  return {
    candidate: shellNode,
    installStrategy: shellInstallStrategy,
  }
}

export function shouldFallbackToInstallerAfterNvmInstall(
  result: Pick<{ ok: boolean; canceled?: boolean }, 'ok' | 'canceled'>
): boolean {
  return !result.ok && !result.canceled
}
