import type { ModelCatalogResult } from '../../electron/main/openclaw-model-catalog'
import type { ModelStatusOptions } from '../../electron/main/openclaw-model-config'

export interface ModelUiSnapshotRequest {
  includeEnv?: boolean
  includeCatalog?: boolean
  statusOptions?: ModelStatusOptions
  forceCatalogRefresh?: boolean
}

export interface ModelUiSnapshotResult {
  envVars: Record<string, string> | null
  config: Record<string, any> | null
  modelStatus: Record<string, any> | null
  catalog: ModelCatalogResult | null
  warnings: string[]
}
