const { access, stat } = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const { dirname, join } = path
const { homedir, userInfo } = os

export interface OpenClawInstallPermissionResultLike {
  ok: boolean
  stdout?: string
  stderr?: string
}

export interface OpenClawInstallPathProbe {
  displayPath: string
  exists: boolean
  writable: boolean
  checkPath: string
  ownerUid: number | null
  ownerMatchesCurrentUser: boolean | null
}

export const OPENCLAW_INSTALL_PERMISSION_FAILURE_REGEX =
  /\b(permission denied|operation not permitted|eacces|erofs|read-only file system|权限不足|无法写入)\b/i

export function formatDisplayPathWithHome(value: string): string {
  const normalized = String(value || '').trim()
  if (!normalized) return normalized
  const home = homedir()
  if (!home) return normalized
  if (normalized === home) return '~'
  if (normalized.startsWith(`${home}/`)) return `~${normalized.slice(home.length)}`
  return normalized
}

export function resolveOpenClawGlobalInstallProbePath(
  prefixPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalizedPrefix = String(prefixPath || '').trim()
  if (!normalizedPrefix) return normalizedPrefix
  const segments =
    platform === 'win32' ? ['node_modules', 'openclaw'] : ['lib', 'node_modules', 'openclaw']
  const pathModule = platform === 'win32' ? path.win32 : path.posix
  return pathModule.join(normalizedPrefix, ...segments)
}

export async function probeOpenClawInstallPath(pathname: string): Promise<OpenClawInstallPathProbe> {
  const normalizedPath = String(pathname || '').trim()
  const uid = userInfo().uid
  const currentUid = typeof uid === 'number' ? uid : null

  let exists = true
  let checkPath = normalizedPath
  let ownerUid: number | null = null
  let ownerMatchesCurrentUser: boolean | null = null

  const resolveOwner = async (targetPath: string) => {
    try {
      const info = await stat(targetPath)
      ownerUid = typeof info.uid === 'number' ? info.uid : null
      if (currentUid !== null && ownerUid !== null) {
        ownerMatchesCurrentUser = ownerUid === currentUid
      }
    } catch {
      ownerUid = null
      ownerMatchesCurrentUser = null
    }
  }

  try {
    await stat(normalizedPath)
    await resolveOwner(normalizedPath)
  } catch {
    exists = false
    checkPath = dirname(normalizedPath) || normalizedPath
    await resolveOwner(checkPath)
  }

  let writable = false
  try {
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    await access(checkPath, fs.constants.W_OK)
    writable = true
  } catch {
    writable = false
  }

  return {
    displayPath: formatDisplayPathWithHome(normalizedPath),
    exists,
    writable,
    checkPath,
    ownerUid,
    ownerMatchesCurrentUser,
  }
}

export function isOpenClawInstallPermissionFailureOutput(output: string): boolean {
  return OPENCLAW_INSTALL_PERMISSION_FAILURE_REGEX.test(String(output || ''))
}

export function isOpenClawInstallPermissionFailureResult(
  result: OpenClawInstallPermissionResultLike
): boolean {
  if (result.ok) return false
  return isOpenClawInstallPermissionFailureOutput(`${String(result.stderr || '')}\n${String(result.stdout || '')}`)
}
