const fs = process.getBuiltinModule('node:fs/promises')
const path = process.getBuiltinModule('node:path')
const { pathToFileURL } = process.getBuiltinModule('node:url')

const DEFAULT_APP_DIR = '.electron-builder/app'
const LOCKFILE_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']
const RUNTIME_PACKAGE_FIELDS = [
  'name',
  'productName',
  'version',
  'main',
  'description',
  'author',
  'license',
  'type',
  'dependencies',
]

export function createPackagedAppManifest(packageJson) {
  const manifest = {}
  for (const field of RUNTIME_PACKAGE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(packageJson, field)) {
      manifest[field] = packageJson[field]
    }
  }

  return manifest
}

async function ensureDirectory(sourcePath, label) {
  const stat = await fs.lstat(sourcePath).catch(() => null)
  if (!stat?.isDirectory()) {
    throw new Error(`[prepare-electron-app-dir] Missing ${label}: ${sourcePath}`)
  }
}

async function maybeCopyLockfile(projectDir, appDir) {
  for (const name of LOCKFILE_NAMES) {
    const sourcePath = path.join(projectDir, name)
    const stat = await fs.lstat(sourcePath).catch(() => null)
    if (!stat?.isFile()) continue
    await fs.cp(sourcePath, path.join(appDir, name))
  }
}

async function linkNodeModules(projectDir, appDir) {
  const sourcePath = path.join(projectDir, 'node_modules')
  await ensureDirectory(sourcePath, 'node_modules')

  const destinationPath = path.join(appDir, 'node_modules')
  const relativeSourcePath = path.relative(path.dirname(destinationPath), sourcePath) || '.'
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'

  await fs.symlink(symlinkType === 'junction' ? sourcePath : relativeSourcePath, destinationPath, symlinkType)
}

export async function preparePackagedAppDir(options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd())
  const appDir = path.resolve(options.appDir || path.join(projectDir, DEFAULT_APP_DIR))

  await ensureDirectory(path.join(projectDir, 'dist'), 'renderer dist output')
  await ensureDirectory(path.join(projectDir, 'dist-electron'), 'electron dist output')

  await fs.rm(appDir, { recursive: true, force: true })
  await fs.mkdir(appDir, { recursive: true })

  await Promise.all([
    fs.cp(path.join(projectDir, 'dist'), path.join(appDir, 'dist'), { recursive: true }),
    fs.cp(path.join(projectDir, 'dist-electron'), path.join(appDir, 'dist-electron'), { recursive: true }),
  ])

  const packageJsonPath = path.join(projectDir, 'package.json')
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'))
  const packagedManifest = createPackagedAppManifest(packageJson)
  await fs.writeFile(path.join(appDir, 'package.json'), `${JSON.stringify(packagedManifest, null, 2)}\n`, 'utf8')

  await Promise.all([
    maybeCopyLockfile(projectDir, appDir),
    linkNodeModules(projectDir, appDir),
  ])

  return { appDir }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preparePackagedAppDir()
    .then(({ appDir }) => {
      console.log(`[prepare-electron-app-dir] Prepared staged app directory: ${appDir}`)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
