import type { CliResult } from '../../cli'
import type { NodeInstallPlan } from '../../node-installation-policy'
import { resolveWindowsPrivateNodeRuntimePaths } from './windows-runtime-policy'

const crypto = process.getBuiltinModule('node:crypto') as typeof import('node:crypto')
const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

const { createHash } = crypto

export type WindowsPrivateNodeInstallPlan = NodeInstallPlan

export interface WindowsPrivateNodeRuntimeResult extends CliResult {
  nodeBinDir?: string
  nodeExecutable?: string
  npmExecutable?: string
  pathPrefix?: string
}

export interface VerifyNodeZipChecksumOptions {
  filename: string
  shaSumsText: string
  zipSha256: string
}

export interface EnsureWindowsPrivateNodeRuntimeOptions {
  plan: WindowsPrivateNodeInstallPlan
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  downloadFile: (url: string, destPath: string) => Promise<void>
  runPowerShell: (command: string, args: string[], timeoutMs: number) => Promise<CliResult>
}

export interface WindowsPrivateNodeRuntimeDependencies {
  access?: (targetPath: string) => Promise<void>
  mkdir?: typeof fs.mkdir
  readTextFile?: (targetPath: string) => Promise<string>
  rename?: typeof fs.rename
  rm?: typeof fs.rm
  sha256File?: (targetPath: string) => Promise<string>
}

const DEFAULT_RUNTIME_TIMEOUT_MS = 60_000

function trim(value: string): string {
  return String(value || '').trim()
}

function escapePowerShellSingleQuoted(value: string): string {
  return String(value || '').replace(/'/g, "''")
}

function parseChecksumEntry(shaSumsText: string, filename: string): string | null {
  const trimmedFilename = trim(filename)
  if (!trimmedFilename) return null

  for (const rawLine of String(shaSumsText || '').split(/\r?\n/g)) {
    const line = trim(rawLine)
    if (!line) continue

    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
    if (!match) continue

    const digest = trim(match[1] || '').toLowerCase()
    const entryName = trim(match[2] || '').replace(/^\*+/, '')
    if (entryName === trimmedFilename) {
      return digest
    }
  }

  return null
}

function defaultSha256File(targetPath: string): Promise<string> {
  return fs.readFile(targetPath).then((buffer) =>
    createHash('sha256').update(buffer).digest('hex')
  )
}

async function defaultAccess(targetPath: string): Promise<void> {
  await fs.access(targetPath)
}

async function defaultReadTextFile(targetPath: string): Promise<string> {
  return fs.readFile(targetPath, 'utf8')
}

export function verifyNodeZipChecksum(options: VerifyNodeZipChecksumOptions): boolean {
  const expectedDigest = parseChecksumEntry(options.shaSumsText, options.filename)
  if (!expectedDigest) return false
  return expectedDigest === trim(options.zipSha256).toLowerCase()
}

function buildExpandArchiveCommand(zipPath: string, destinationPath: string): string {
  const quotedZipPath = `'${escapePowerShellSingleQuoted(zipPath)}'`
  const quotedDestinationPath = `'${escapePowerShellSingleQuoted(destinationPath)}'`
  return `Expand-Archive -LiteralPath ${quotedZipPath} -DestinationPath ${quotedDestinationPath} -Force`
}

function buildExtractedNodeFolderName(plan: WindowsPrivateNodeInstallPlan): string {
  if (plan.artifactKind !== 'zip') return ''
  return `node-${plan.version}-win-${plan.installerArch}`
}

async function runPowerShellExpandArchive(
  runPowerShell: EnsureWindowsPrivateNodeRuntimeOptions['runPowerShell'],
  zipPath: string,
  destinationPath: string,
  timeoutMs: number
): Promise<CliResult> {
  return runPowerShell(
    'powershell',
    ['-NoProfile', '-Command', buildExpandArchiveCommand(zipPath, destinationPath)],
    timeoutMs
  )
}

export async function ensureWindowsPrivateNodeRuntime(
  options: EnsureWindowsPrivateNodeRuntimeOptions,
  dependencies: WindowsPrivateNodeRuntimeDependencies = {}
): Promise<WindowsPrivateNodeRuntimeResult> {
  const access = dependencies.access || defaultAccess
  const mkdir = dependencies.mkdir || fs.mkdir
  const readTextFile = dependencies.readTextFile || defaultReadTextFile
  const rename = dependencies.rename || fs.rename
  const rm = dependencies.rm || fs.rm
  const sha256File = dependencies.sha256File || defaultSha256File
  const timeoutMs = options.timeoutMs || DEFAULT_RUNTIME_TIMEOUT_MS

  if (options.plan.platform !== 'win32') {
    return {
      ok: false,
      stdout: '',
      stderr: 'Windows private Node runtime only supports win32 plans',
      code: 1,
    }
  }

  if (options.plan.artifactKind !== 'zip') {
    return {
      ok: false,
      stdout: '',
      stderr: `Windows private Node runtime requires a zip plan, received ${options.plan.artifactKind}`,
      code: 1,
    }
  }

  const paths = resolveWindowsPrivateNodeRuntimePaths({
    env: options.env,
    filename: options.plan.filename,
    version: options.plan.version,
  })

  try {
    await access(paths.nodeExecutable)
    return {
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
      nodeBinDir: paths.nodeBinDir,
      nodeExecutable: paths.nodeExecutable,
      npmExecutable: paths.npmExecutable,
      pathPrefix: paths.pathPrefix,
    }
  } catch {
    // Continue with a fresh install.
  }

  try {
    await mkdir(paths.downloadDir, { recursive: true })
    await mkdir(paths.zipStagingDir, { recursive: true })

    await options.downloadFile(options.plan.url, paths.zipPath)
    await options.downloadFile(
      `${options.plan.distBaseUrl}/${options.plan.version}/SHASUMS256.txt`,
      paths.shaSumsPath
    )

    const [zipSha256, shaSumsText] = await Promise.all([
      sha256File(paths.zipPath),
      readTextFile(paths.shaSumsPath),
    ])

    if (
      !verifyNodeZipChecksum({
        filename: options.plan.filename,
        shaSumsText,
        zipSha256,
      })
    ) {
      return {
        ok: false,
        stdout: '',
        stderr: `Node.js zip checksum mismatch for ${options.plan.filename}`,
        code: 1,
      }
    }

    const expandArchiveResult = await runPowerShellExpandArchive(
      options.runPowerShell,
      paths.zipPath,
      paths.zipStagingDir,
      timeoutMs
    )

    if (!expandArchiveResult.ok) {
      return {
        ok: false,
        stdout: expandArchiveResult.stdout || '',
        stderr: expandArchiveResult.stderr || 'Failed to extract Node.js zip',
        code: expandArchiveResult.code ?? 1,
      }
    }

    const extractedNodeFolder = path.win32.join(
      paths.zipStagingDir,
      buildExtractedNodeFolderName(options.plan)
    )

    await rm(paths.nodeVersionDir, { force: true, recursive: true })
    await rm(paths.installStagingDir, { force: true, recursive: true })
    await mkdir(path.win32.dirname(paths.installStagingDir), { recursive: true })
    await rename(extractedNodeFolder, paths.installStagingDir)
    await rename(paths.installStagingDir, paths.nodeVersionDir)

    await access(paths.nodeExecutable)

    return {
      ok: true,
      stdout: '',
      stderr: '',
      code: 0,
      nodeBinDir: paths.nodeBinDir,
      nodeExecutable: paths.nodeExecutable,
      npmExecutable: paths.npmExecutable,
      pathPrefix: paths.pathPrefix,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      stdout: '',
      stderr: message || 'Failed to install Windows private Node runtime',
      code: 1,
    }
  }
}
