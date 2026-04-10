import type { ModelCatalogResult } from './openclaw-model-catalog'
import type { ModelStatusOptions } from './openclaw-model-config'
import type {
  ModelUiSnapshotRequest,
  ModelUiSnapshotResult,
} from '../../src/shared/model-ui-snapshot'

interface ModelUiSnapshotTimeouts {
  configMs?: number
  envMs?: number
  statusMs?: number
  catalogMs?: number
}

interface ModelUiSnapshotDeps {
  readConfig?: () => Promise<Record<string, any> | null>
  readEnvFile?: () => Promise<Record<string, string>>
  getModelStatus?: (options?: ModelStatusOptions) => Promise<{
    ok: boolean
    data?: Record<string, any>
    message?: string
    stderr?: string
  }>
  getAllCatalog?: (options?: {
    query?: {
      bypassCache?: boolean
    }
  }) => Promise<ModelCatalogResult>
  timeouts?: ModelUiSnapshotTimeouts
}

const DEFAULT_MODEL_UI_SNAPSHOT_TIMEOUTS = Object.freeze({
  configMs: 6_000,
  envMs: 6_000,
  statusMs: 6_000,
  catalogMs: 6_000,
})

const CONFIG_TIMEOUT_WARNING = '配置快照读取超时，当前先按空配置继续。'
const CONFIG_FAILURE_WARNING = '配置快照读取失败，当前先按空配置继续。'
const ENV_TIMEOUT_WARNING = '环境变量快照读取超时，当前先按空环境继续。'
const ENV_FAILURE_WARNING = '环境变量快照读取失败，当前先按空环境继续。'
const STATUS_TIMEOUT_WARNING = '模型状态快照读取超时，当前先按已有配置显示。'
const STATUS_FAILURE_WARNING = '模型状态快照读取失败，当前先按已有配置显示。'
const CATALOG_TIMEOUT_WARNING = '模型目录快照读取超时，当前先按已有目录显示。'
const CATALOG_FAILURE_WARNING = '模型目录快照读取失败，当前先按已有目录显示。'

async function defaultReadConfig(): Promise<Record<string, any> | null> {
  const cli = await import('./cli')
  return cli.readConfig()
}

async function defaultReadEnvFile(): Promise<Record<string, string>> {
  const cli = await import('./cli')
  return cli.readEnvFile()
}

async function defaultGetModelStatus(
  options?: ModelStatusOptions
): Promise<{
  ok: boolean
  data?: Record<string, any>
  message?: string
  stderr?: string
}> {
  const modelConfig = await import('./openclaw-model-config')
  return modelConfig.getModelStatus(options || {})
}

async function defaultGetAllCatalog(options?: {
  query?: {
    bypassCache?: boolean
  }
}): Promise<ModelCatalogResult> {
  const modelCatalog = await import('./openclaw-model-catalog')
  return modelCatalog.getAllModelCatalogItems(options || {})
}

async function withSnapshotBudget<T>(
  load: Promise<T>,
  timeoutMs: number
): Promise<{ timedOut: boolean; value: T | null }> {
  let timer: NodeJS.Timeout | null = null
  try {
    const value = await Promise.race([
      load.then((resolved) => ({ timedOut: false, value: resolved })),
      new Promise<{ timedOut: true; value: null }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true, value: null }), timeoutMs)
      }),
    ])
    return value
  } catch {
    return {
      timedOut: false,
      value: null,
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizeTimeout(value: unknown, fallback: number): number {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue) || numericValue <= 0) return fallback
  return Math.max(1, Math.round(numericValue))
}

function collectWarnings(params: {
  included: boolean
  timedOut: boolean
  hasValue: boolean
  timeoutWarning: string
  failureWarning: string
  warnings: string[]
}): void {
  if (!params.included || params.hasValue) return
  params.warnings.push(params.timedOut ? params.timeoutWarning : params.failureWarning)
}

export async function getModelUiSnapshot(
  request: ModelUiSnapshotRequest = {},
  deps: ModelUiSnapshotDeps = {}
): Promise<ModelUiSnapshotResult> {
  const includeEnv = request.includeEnv === true
  const includeCatalog = request.includeCatalog === true
  const timeouts = {
    configMs: normalizeTimeout(deps.timeouts?.configMs, DEFAULT_MODEL_UI_SNAPSHOT_TIMEOUTS.configMs),
    envMs: normalizeTimeout(deps.timeouts?.envMs, DEFAULT_MODEL_UI_SNAPSHOT_TIMEOUTS.envMs),
    statusMs: normalizeTimeout(deps.timeouts?.statusMs, DEFAULT_MODEL_UI_SNAPSHOT_TIMEOUTS.statusMs),
    catalogMs: normalizeTimeout(deps.timeouts?.catalogMs, DEFAULT_MODEL_UI_SNAPSHOT_TIMEOUTS.catalogMs),
  }

  const warnings: string[] = []

  const [configResult, envResult, statusResult, catalogResult] = await Promise.all([
    withSnapshotBudget((deps.readConfig ?? defaultReadConfig)(), timeouts.configMs),
    includeEnv
      ? withSnapshotBudget((deps.readEnvFile ?? defaultReadEnvFile)(), timeouts.envMs)
      : Promise.resolve({ timedOut: false, value: null as Record<string, string> | null }),
    withSnapshotBudget((deps.getModelStatus ?? defaultGetModelStatus)(request.statusOptions || {}), timeouts.statusMs),
    includeCatalog
      ? withSnapshotBudget(
          (deps.getAllCatalog ?? defaultGetAllCatalog)({
            query: request.forceCatalogRefresh ? { bypassCache: true } : {},
          }),
          timeouts.catalogMs
        )
      : Promise.resolve({ timedOut: false, value: null as ModelCatalogResult | null }),
  ])

  const statusValue = statusResult.value?.ok ? ((statusResult.value.data || null) as Record<string, any> | null) : null
  const catalogValue = catalogResult.value || null

  collectWarnings({
    included: true,
    timedOut: configResult.timedOut,
    hasValue: configResult.value !== null,
    timeoutWarning: CONFIG_TIMEOUT_WARNING,
    failureWarning: CONFIG_FAILURE_WARNING,
    warnings,
  })
  collectWarnings({
    included: includeEnv,
    timedOut: envResult.timedOut,
    hasValue: envResult.value !== null,
    timeoutWarning: ENV_TIMEOUT_WARNING,
    failureWarning: ENV_FAILURE_WARNING,
    warnings,
  })
  collectWarnings({
    included: true,
    timedOut: statusResult.timedOut,
    hasValue: statusValue !== null,
    timeoutWarning: STATUS_TIMEOUT_WARNING,
    failureWarning: STATUS_FAILURE_WARNING,
    warnings,
  })
  collectWarnings({
    included: includeCatalog,
    timedOut: catalogResult.timedOut,
    hasValue: catalogValue !== null,
    timeoutWarning: CATALOG_TIMEOUT_WARNING,
    failureWarning: CATALOG_FAILURE_WARNING,
    warnings,
  })

  return {
    envVars: envResult.value,
    config: configResult.value,
    modelStatus: statusValue,
    catalog: catalogValue,
    warnings,
  }
}
