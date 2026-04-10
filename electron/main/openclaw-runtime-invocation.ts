import type { WindowsActiveRuntimeSnapshot } from './platforms/windows/windows-runtime-policy'
import { resolveOpenClawCliEntrypointPath } from './openclaw-package'
import { resolveOpenClawCommand, type ResolvedCliCommand } from './openclaw-spawn'
import { getSelectedWindowsActiveRuntimeSnapshot } from './windows-active-runtime'

interface ResolveBoundOpenClawCommandOptions {
  activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
  commandPath?: string
  expectAvailable?: boolean
  expectWarning?: string
  scriptAvailable?: boolean
  scriptWarning?: string
  platform?: NodeJS.Platform
  resolveEntrypointPath?: (options?: {
    activeRuntimeSnapshot?: WindowsActiveRuntimeSnapshot | null
    binaryPath?: string
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
  }) => Promise<string>
}

export async function resolveBoundOpenClawCommand(
  args: string[],
  options: ResolveBoundOpenClawCommandOptions = {}
): Promise<ResolvedCliCommand> {
  const platform = options.platform || process.platform
  const explicitCommandPath = String(options.commandPath || '').trim()
  const activeRuntimeSnapshot =
    platform === 'win32'
      ? (options.activeRuntimeSnapshot ?? getSelectedWindowsActiveRuntimeSnapshot())
      : null

  if (!explicitCommandPath && platform === 'win32' && activeRuntimeSnapshot?.nodePath) {
    const entryPath = await (
      options.resolveEntrypointPath || resolveOpenClawCliEntrypointPath
    )({
      activeRuntimeSnapshot,
      platform,
    }).catch(() => '')

    if (entryPath) {
      return {
        command: activeRuntimeSnapshot.nodePath,
        args: [entryPath, ...args],
        shell: false,
      }
    }
  }

  return resolveOpenClawCommand(args, {
    platform,
    expectAvailable: options.expectAvailable,
    expectWarning: options.expectWarning,
    scriptAvailable: options.scriptAvailable,
    scriptWarning: options.scriptWarning,
    commandPath: explicitCommandPath || activeRuntimeSnapshot?.openclawPath || undefined,
  })
}
