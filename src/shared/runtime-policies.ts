export interface BackoffPollingPolicy {
  timeoutMs: number
  initialIntervalMs: number
  maxIntervalMs: number
  backoffFactor: number
}

export const MODEL_CATALOG_LIMITS = Object.freeze({
  backendDefaultPageSize: 50,
  maxPageSize: 200,
  dashboardPageSize: 200,
})

export const MAIN_RUNTIME_DEFAULTS = Object.freeze({
  cli: {
    defaultCommandTimeoutMs: 60_000,
    defaultShellTimeoutMs: 120_000,
    defaultDirectTimeoutMs: 120_000,
    lightweightProbeTimeoutMs: 5_000,
    gatewayHealthTimeoutMs: 10_000,
    statusTimeoutMs: 15_000,
    doctorTimeoutMs: 30_000,
    pairingApproveTimeoutMs: 30_000,
    pluginInstallTimeoutMs: 120_000,
    pluginInstallNpxTimeoutMs: 180_000,
    dashboardLaunchTimeoutMs: 10_000,
    gatewayStopTimeoutMs: 10_000,
    stateUninstallTimeoutMs: 120_000,
    npmUninstallTimeoutMs: 60_000,
    gatewayUninstallTimeoutMs: 30_000,
    removeHomeDirTimeoutMs: 30_000,
    launchctlTimeoutMs: 5_000,
    feishuApiTimeoutMs: 10_000,
    runOnboardTimeoutMs: 300_000,
  },
  node: {
    installerDownloadTimeoutMs: 300_000,
    installNodeTimeoutMs: 300_000,
    installOpenClawTimeoutMs: 180_000,
    installCombinedTimeoutMs: 300_000,
    metadataRequestTimeoutMs: 10_000,
  },
  commandAvailability: {
    timeoutMs: 45_000,
    initialIntervalMs: 500,
    maxIntervalMs: 2_000,
    backoffFactor: 1.5,
  } satisfies BackoffPollingPolicy,
  capabilities: {
    versionProbeTimeoutMs: 10_000,
    helpProbeTimeoutMs: 20_000,
    discoveryTimeoutMs: 60_000,
  },
  auth: {
    pluginEnableTimeoutMs: 30_000,
    loginTimeoutMs: 300_000,
    tokenTimeoutMs: 120_000,
    orderTimeoutMs: 30_000,
    onboardTimeoutMs: 300_000,
    persistencePoll: {
      timeoutMs: 20_000,
      initialIntervalMs: 1_500,
      maxIntervalMs: 4_000,
      backoffFactor: 1.5,
    } satisfies BackoffPollingPolicy,
  },
  modelConfig: {
    actionTimeoutMs: 20_000,
    statusTimeoutMs: 30_000,
  },
  modelCatalog: {
    fetchTimeoutMs: 60_000,
    cacheTtlMs: 5 * 60 * 1_000,
  },
  processControl: {
    cancelGracePeriodMs: 1_000,
  },
  nodeInstallerChecks: {
    groupsTimeoutMs: 5_000,
    signatureTimeoutMs: 10_000,
    policyTimeoutMs: 10_000,
  },
})

export const UI_RUNTIME_DEFAULTS = Object.freeze({
  envCheck: {
    loadingTipRotateMs: 3_000,
    progressTickMs: 50,
    progressStep: 2,
    startupDelayMs: 0,
    transitionShortMs: 300,
    transitionStandardMs: 500,
    transitionSettleMs: 800,
  },
  authVerification: {
    elapsedTickMs: 1_000,
    poll: {
      timeoutMs: 20_000,
      initialIntervalMs: 2_000,
      maxIntervalMs: 4_000,
      backoffFactor: 1.5,
    } satisfies BackoffPollingPolicy,
  },
  gatewayReadiness: {
    poll: {
      timeoutMs: 45_000,
      initialIntervalMs: 1_000,
      maxIntervalMs: 4_000,
      backoffFactor: 1.5,
    } satisfies BackoffPollingPolicy,
  },
  feishuSetupRecovery: {
    poll: {
      timeoutMs: 240_000,
      initialIntervalMs: 2_000,
      maxIntervalMs: 8_000,
      backoffFactor: 1.5,
    } satisfies BackoffPollingPolicy,
  },
  dashboard: {
    visibleStatusPollIntervalMs: 10_000,
    hiddenStatusPollIntervalMs: 60_000,
  },
  pairing: {
    approvalCountdownSeconds: 30,
    countdownTickMs: 1_000,
  },
})
