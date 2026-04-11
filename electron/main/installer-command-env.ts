import type { WindowsActiveRuntimeSnapshot } from './platforms/windows/windows-runtime-policy'
import { getDetectedNodeBinDir } from './detected-node-bin'
import { buildCliPathWithCandidates } from './runtime-path-discovery'
import { getSelectedWindowsActiveRuntimeSnapshot } from './windows-active-runtime'

interface BuildInstallerCommandEnvOptions {
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
  detectedNodeBinDir?: string | null
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

export function buildInstallerCommandEnv(
  options: BuildInstallerCommandEnvOptions = {}
): NodeJS.ProcessEnv {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const activeRuntimeSnapshot =
    options.activeRuntimeSnapshot === undefined
      ? platform === 'win32'
        ? getSelectedWindowsActiveRuntimeSnapshot()
        : null
      : options.activeRuntimeSnapshot
  const detectedNodeBinDir =
    options.detectedNodeBinDir === undefined
      ? getDetectedNodeBinDir()
      : options.detectedNodeBinDir

  return {
    ...env,
    PATH: buildCliPathWithCandidates({
      activeRuntimeSnapshot: activeRuntimeSnapshot || undefined,
      detectedNodeBinDir: detectedNodeBinDir || undefined,
      platform,
      currentPath: String(env.PATH || ''),
      env,
    }),
  }
}
