export type AppState =
  | 'startup-update'
  | 'welcome'
  | 'env-check'
  | 'setup'
  | 'gateway-bootstrap'
  | 'dashboard'

export function canOpenExternalModelsPage(appState: AppState): boolean {
  return appState === 'dashboard'
}
