import type { CommandControlDomain } from './command-control'
import { probePlatformCommandCapability } from './command-capabilities'

interface ManagedNpxCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  canceled?: boolean
}

interface ManagedNpxFailureResult {
  ok: false
  stdout: string
  stderr: string
  code: 1
}

interface ResolveManagedNpxCommandDependencies {
  buildEnv?: () => NodeJS.ProcessEnv
  probeCapability?: typeof probePlatformCommandCapability
  platform?: NodeJS.Platform
  unavailableMessage?: string
}

type ResolveManagedNpxCommandResult =
  | {
      ok: true
      command: string
    }
  | {
      ok: false
      result: ManagedNpxFailureResult
    }

interface RunManagedNpxOptions {
  cwd?: string
  timeout?: number
  controlDomain?: CommandControlDomain
}

interface RunManagedNpxDependencies extends ResolveManagedNpxCommandDependencies {
  runShellImpl: (
    command: string,
    args: string[],
    timeout?: number,
    options?: {
      cwd?: string
      controlDomain?: CommandControlDomain
    }
  ) => Promise<ManagedNpxCommandResult>
}

export async function resolveManagedNpxCommand(
  dependencies: ResolveManagedNpxCommandDependencies = {}
): Promise<ResolveManagedNpxCommandResult> {
  const buildEnv = dependencies.buildEnv || (() => process.env)
  const probeCapability = dependencies.probeCapability || probePlatformCommandCapability
  const platform = dependencies.platform || process.platform

  const capability = await probeCapability('npx', {
    platform,
    env: buildEnv(),
  })
  if (!capability.available) {
    return {
      ok: false,
      result: {
        ok: false,
        stdout: '',
        stderr: dependencies.unavailableMessage || capability.message || 'npx 命令不可用，无法继续执行。',
        code: 1,
      },
    }
  }

  return {
    ok: true,
    command: String(capability.resolvedPath || '').trim() || 'npx',
  }
}

export async function runManagedNpxCommand(
  args: string[],
  options: RunManagedNpxOptions = {},
  dependencies: RunManagedNpxDependencies
): Promise<ManagedNpxCommandResult> {
  const resolution = await resolveManagedNpxCommand(dependencies)
  if (!resolution.ok) {
    return resolution.result
  }

  return dependencies.runShellImpl(resolution.command, args, options.timeout, {
    cwd: options.cwd,
    controlDomain: options.controlDomain,
  })
}
