export type ChannelInstallerGuardrailState = 'not-run' | 'running' | 'ok' | 'failed' | 'skipped'

export type ChannelInstallerGuardrailStepId =
  | 'environment'
  | 'command'
  | 'runtime'
  | 'bridge'
  | 'config'
  | 'gateway-stop'
  | 'gateway-recovery'
  | 'spawn'
  | 'final-sync'

export type ChannelInstallerGuardrailFailureCode =
  | 'env-build-failed'
  | 'command-unavailable'
  | 'runtime-snapshot-unavailable'
  | 'runtime-context-failed'
  | 'plugin-preflight-failed'
  | 'config-reconcile-failed'
  | 'gateway-stop-failed'
  | 'gateway-recovery-failed'
  | 'spawn-failed'
  | 'final-sync-failed'

export interface ChannelInstallerGuardrailStep {
  state: ChannelInstallerGuardrailState
  code?: ChannelInstallerGuardrailFailureCode
  message?: string
}

export interface ChannelInstallerRuntimeGuardrailStep extends ChannelInstallerGuardrailStep {
  contextResolved: boolean
  platform: NodeJS.Platform | 'unknown'
}

export interface ChannelInstallerGatewayRecoveryStatus {
  ok: boolean
  recovered: boolean
  skipped: boolean
  code?: number | null
  message?: string
}

export interface ChannelInstallerGatewayGuardrail {
  stop: ChannelInstallerGuardrailStep & {
    skipped: boolean
    stopped: boolean
  }
  recovery: ChannelInstallerGatewayRecoveryStatus | null
}

export interface ChannelInstallerLockGuardrail {
  state: ChannelInstallerGuardrailState
  key?: string
  message?: string
}

export interface ChannelInstallerGuardrailFailure {
  code: ChannelInstallerGuardrailFailureCode
  message: string
  step: ChannelInstallerGuardrailStepId
}

export interface ChannelInstallerGuardrailStatus {
  channelId: string
  preflight: ChannelInstallerGuardrailStep
  environment: ChannelInstallerGuardrailStep
  command: ChannelInstallerGuardrailStep
  runtime: ChannelInstallerRuntimeGuardrailStep
  bridge: ChannelInstallerGuardrailStep
  config: ChannelInstallerGuardrailStep
  gateway: ChannelInstallerGatewayGuardrail
  lock: ChannelInstallerLockGuardrail
  spawn: ChannelInstallerGuardrailStep
  finalSync: ChannelInstallerGuardrailStep
  failure: ChannelInstallerGuardrailFailure | null
}

export interface ChannelInstallerGatewayGuardrailPatch {
  stop?: Partial<ChannelInstallerGatewayGuardrail['stop']>
  recovery?: ChannelInstallerGatewayRecoveryStatus | null
}

export interface ChannelInstallerGuardrailPatch {
  preflight?: Partial<ChannelInstallerGuardrailStep>
  environment?: Partial<ChannelInstallerGuardrailStep>
  command?: Partial<ChannelInstallerGuardrailStep>
  runtime?: Partial<ChannelInstallerRuntimeGuardrailStep>
  bridge?: Partial<ChannelInstallerGuardrailStep>
  config?: Partial<ChannelInstallerGuardrailStep>
  gateway?: ChannelInstallerGatewayGuardrailPatch
  lock?: Partial<ChannelInstallerLockGuardrail>
  spawn?: Partial<ChannelInstallerGuardrailStep>
  finalSync?: Partial<ChannelInstallerGuardrailStep>
  failure?: ChannelInstallerGuardrailFailure | null
}

function createStep(state: ChannelInstallerGuardrailState = 'not-run'): ChannelInstallerGuardrailStep {
  return { state }
}

export function createIdleChannelInstallerGuardrailStatus(channelId: string): ChannelInstallerGuardrailStatus {
  return {
    channelId,
    preflight: createStep(),
    environment: createStep(),
    command: createStep(),
    runtime: {
      state: 'not-run',
      contextResolved: false,
      platform: 'unknown',
    },
    bridge: createStep(),
    config: createStep(),
    gateway: {
      stop: {
        state: 'not-run',
        skipped: false,
        stopped: false,
      },
      recovery: null,
    },
    lock: {
      state: 'not-run',
    },
    spawn: createStep(),
    finalSync: createStep(),
    failure: null,
  }
}

export function mergeChannelInstallerGuardrailStatus(
  base: ChannelInstallerGuardrailStatus,
  patch: ChannelInstallerGuardrailPatch = {}
): ChannelInstallerGuardrailStatus {
  return {
    ...base,
    preflight: { ...base.preflight, ...patch.preflight },
    environment: { ...base.environment, ...patch.environment },
    command: { ...base.command, ...patch.command },
    runtime: { ...base.runtime, ...patch.runtime },
    bridge: { ...base.bridge, ...patch.bridge },
    config: { ...base.config, ...patch.config },
    gateway: {
      stop: { ...base.gateway.stop, ...patch.gateway?.stop },
      recovery: patch.gateway && Object.prototype.hasOwnProperty.call(patch.gateway, 'recovery')
        ? patch.gateway.recovery || null
        : base.gateway.recovery,
    },
    lock: { ...base.lock, ...patch.lock },
    spawn: { ...base.spawn, ...patch.spawn },
    finalSync: { ...base.finalSync, ...patch.finalSync },
    failure: Object.prototype.hasOwnProperty.call(patch, 'failure') ? patch.failure || null : base.failure,
  }
}

export function failChannelInstallerGuardrailStatus(params: {
  channelId: string
  step: ChannelInstallerGuardrailStepId
  code: ChannelInstallerGuardrailFailureCode
  message: string
  patch?: ChannelInstallerGuardrailPatch
}): ChannelInstallerGuardrailStatus {
  const base = mergeChannelInstallerGuardrailStatus(
    createIdleChannelInstallerGuardrailStatus(params.channelId),
    params.patch
  )
  const failure = {
    code: params.code,
    message: params.message,
    step: params.step,
  }
  const failedStep = {
    state: 'failed' as const,
    code: params.code,
    message: params.message,
  }

  if (params.step === 'runtime') {
    return mergeChannelInstallerGuardrailStatus(base, {
      runtime: failedStep,
      preflight: failedStep,
      failure,
    })
  }
  if (params.step === 'gateway-stop') {
    return mergeChannelInstallerGuardrailStatus(base, {
      gateway: {
        stop: {
          ...failedStep,
          skipped: false,
          stopped: false,
        },
      },
      failure,
    })
  }
  if (params.step === 'gateway-recovery') {
    return mergeChannelInstallerGuardrailStatus(base, {
      failure,
    })
  }
  if (params.step === 'final-sync') {
    return mergeChannelInstallerGuardrailStatus(base, {
      finalSync: failedStep,
      failure,
    })
  }

  return mergeChannelInstallerGuardrailStatus(base, {
    [params.step]: failedStep,
    preflight: params.step === 'spawn' ? base.preflight : failedStep,
    failure,
  } as ChannelInstallerGuardrailPatch)
}
