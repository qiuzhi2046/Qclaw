import { MAIN_RUNTIME_DEFAULTS } from '../../src/shared/runtime-policies'

function readEnvNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min = 1
): number {
  const raw = String(env[key] || '').trim()
  if (!raw) return fallback

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.floor(parsed))
}

function readEnvFloat(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min = 1
): number {
  const raw = String(env[key] || '').trim()
  if (!raw) return fallback

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, parsed)
}

export const MAIN_RUNTIME_POLICY = Object.freeze({
  cli: {
    defaultCommandTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_CLI_COMMAND_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.defaultCommandTimeoutMs,
      1_000
    ),
    defaultShellTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_SHELL_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.defaultShellTimeoutMs,
      1_000
    ),
    defaultDirectTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_DIRECT_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.defaultDirectTimeoutMs,
      1_000
    ),
    lightweightProbeTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_LIGHTWEIGHT_PROBE_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.lightweightProbeTimeoutMs,
      500
    ),
    gatewayHealthTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_GATEWAY_HEALTH_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.gatewayHealthTimeoutMs,
      1_000
    ),
    statusTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_STATUS_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.statusTimeoutMs,
      1_000
    ),
    doctorTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_DOCTOR_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.doctorTimeoutMs,
      1_000
    ),
    pairingApproveTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_PAIRING_APPROVE_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.pairingApproveTimeoutMs,
      1_000
    ),
    pluginInstallTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_PLUGIN_INSTALL_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.pluginInstallTimeoutMs,
      1_000
    ),
    pluginInstallNpxTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_PLUGIN_INSTALL_NPX_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.pluginInstallNpxTimeoutMs,
      1_000
    ),
    dashboardLaunchTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_DASHBOARD_LAUNCH_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.dashboardLaunchTimeoutMs,
      1_000
    ),
    gatewayStopTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_GATEWAY_STOP_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.gatewayStopTimeoutMs,
      1_000
    ),
    stateUninstallTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_STATE_UNINSTALL_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.stateUninstallTimeoutMs,
      1_000
    ),
    npmUninstallTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_NPM_UNINSTALL_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.npmUninstallTimeoutMs,
      1_000
    ),
    gatewayUninstallTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_GATEWAY_UNINSTALL_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.gatewayUninstallTimeoutMs,
      1_000
    ),
    removeHomeDirTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_REMOVE_HOME_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.removeHomeDirTimeoutMs,
      1_000
    ),
    launchctlTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_LAUNCHCTL_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.launchctlTimeoutMs,
      500
    ),
    feishuApiTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_FEISHU_API_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.feishuApiTimeoutMs,
      1_000
    ),
    runOnboardTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_ONBOARD_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.cli.runOnboardTimeoutMs,
      1_000
    ),
  },
  node: {
    installerDownloadTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_NODE_DOWNLOAD_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.node.installerDownloadTimeoutMs,
      1_000
    ),
    installNodeTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_NODE_INSTALL_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.node.installNodeTimeoutMs,
      1_000
    ),
    installOpenClawTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_OPENCLAW_INSTALL_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.node.installOpenClawTimeoutMs,
      1_000
    ),
    installCombinedTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_ENV_INSTALL_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.node.installCombinedTimeoutMs,
      1_000
    ),
    metadataRequestTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_METADATA_REQUEST_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.node.metadataRequestTimeoutMs,
      1_000
    ),
  },
  commandAvailability: {
    timeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_COMMAND_AVAILABILITY_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.commandAvailability.timeoutMs,
      1_000
    ),
    initialIntervalMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_COMMAND_AVAILABILITY_INITIAL_INTERVAL_MS',
      MAIN_RUNTIME_DEFAULTS.commandAvailability.initialIntervalMs,
      100
    ),
    maxIntervalMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_COMMAND_AVAILABILITY_MAX_INTERVAL_MS',
      MAIN_RUNTIME_DEFAULTS.commandAvailability.maxIntervalMs,
      100
    ),
    backoffFactor: readEnvFloat(
      process.env,
      'QCLAW_RUNTIME_COMMAND_AVAILABILITY_BACKOFF_FACTOR',
      MAIN_RUNTIME_DEFAULTS.commandAvailability.backoffFactor,
      1
    ),
  },
  capabilities: {
    versionProbeTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_CAPABILITY_VERSION_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.capabilities.versionProbeTimeoutMs,
      500
    ),
    helpProbeTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_CAPABILITY_HELP_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.capabilities.helpProbeTimeoutMs,
      500
    ),
    discoveryTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_CAPABILITY_DISCOVERY_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.capabilities.discoveryTimeoutMs,
      1_000
    ),
  },
  auth: {
    pluginEnableTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_AUTH_PLUGIN_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.auth.pluginEnableTimeoutMs,
      1_000
    ),
    loginTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_AUTH_LOGIN_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.auth.loginTimeoutMs,
      1_000
    ),
    tokenTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_AUTH_TOKEN_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.auth.tokenTimeoutMs,
      1_000
    ),
    orderTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_AUTH_ORDER_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.auth.orderTimeoutMs,
      1_000
    ),
    onboardTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_AUTH_ONBOARD_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.auth.onboardTimeoutMs,
      1_000
    ),
    persistencePoll: {
      timeoutMs: readEnvNumber(
        process.env,
        'QCLAW_RUNTIME_AUTH_PERSISTENCE_TIMEOUT_MS',
        MAIN_RUNTIME_DEFAULTS.auth.persistencePoll.timeoutMs,
        1_000
      ),
      initialIntervalMs: readEnvNumber(
        process.env,
        'QCLAW_RUNTIME_AUTH_PERSISTENCE_INITIAL_INTERVAL_MS',
        MAIN_RUNTIME_DEFAULTS.auth.persistencePoll.initialIntervalMs,
        200
      ),
      maxIntervalMs: readEnvNumber(
        process.env,
        'QCLAW_RUNTIME_AUTH_PERSISTENCE_MAX_INTERVAL_MS',
        MAIN_RUNTIME_DEFAULTS.auth.persistencePoll.maxIntervalMs,
        200
      ),
      backoffFactor: readEnvFloat(
        process.env,
        'QCLAW_RUNTIME_AUTH_PERSISTENCE_BACKOFF_FACTOR',
        MAIN_RUNTIME_DEFAULTS.auth.persistencePoll.backoffFactor,
        1
      ),
    },
  },
  modelConfig: {
    actionTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_MODEL_CONFIG_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.modelConfig.actionTimeoutMs,
      1_000
    ),
    statusTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_MODEL_STATUS_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.modelConfig.statusTimeoutMs,
      1_000
    ),
  },
  modelCatalog: {
    fetchTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_MODEL_CATALOG_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.modelCatalog.fetchTimeoutMs,
      1_000
    ),
    cacheTtlMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_MODEL_CATALOG_TTL_MS',
      MAIN_RUNTIME_DEFAULTS.modelCatalog.cacheTtlMs,
      1_000
    ),
  },
  processControl: {
    cancelGracePeriodMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_CANCEL_GRACE_MS',
      MAIN_RUNTIME_DEFAULTS.processControl.cancelGracePeriodMs,
      0
    ),
  },
  nodeInstallerChecks: {
    groupsTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_NODE_GROUPS_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.nodeInstallerChecks.groupsTimeoutMs,
      500
    ),
    signatureTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_NODE_SIGNATURE_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.nodeInstallerChecks.signatureTimeoutMs,
      500
    ),
    policyTimeoutMs: readEnvNumber(
      process.env,
      'QCLAW_RUNTIME_NODE_POLICY_TIMEOUT_MS',
      MAIN_RUNTIME_DEFAULTS.nodeInstallerChecks.policyTimeoutMs,
      500
    ),
  },
})
