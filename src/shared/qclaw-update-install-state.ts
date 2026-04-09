import type { QClawUpdateActionResult } from './openclaw-phase4'

export function shouldKeepInstallingState(
  result: Pick<QClawUpdateActionResult, 'willQuitAndInstall'> | null | undefined
): boolean {
  return result?.willQuitAndInstall === true
}
