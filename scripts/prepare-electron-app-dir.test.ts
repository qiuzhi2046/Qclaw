import { afterEach, describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')
const os = process.getBuiltinModule('node:os') as typeof import('node:os')
const { pathToFileURL } = process.getBuiltinModule('node:url') as typeof import('node:url')

async function loadPrepareModule() {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), 'scripts', 'prepare-electron-app-dir.mjs')).href
  return import(moduleUrl)
}

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('createPackagedAppManifest', () => {
  it('keeps only runtime package fields for the staged app manifest', async () => {
    const { createPackagedAppManifest } = await loadPrepareModule()

    const manifest = createPackagedAppManifest({
      name: 'qclaw-lite',
      productName: 'Qclaw',
      version: '2.2.0',
      main: 'dist-electron/main/index.js',
      description: 'Electron desktop setup wizard for OpenClaw.',
      author: '秋芝2046',
      license: 'Apache-2.0',
      type: 'module',
      scripts: {
        build: 'vite build',
      },
      dependencies: {
        'electron-updater': '^6.3.9',
      },
      devDependencies: {
        vite: '^5.4.11',
      },
    })

    expect(manifest).toEqual({
      name: 'qclaw-lite',
      productName: 'Qclaw',
      version: '2.2.0',
      main: 'dist-electron/main/index.js',
      description: 'Electron desktop setup wizard for OpenClaw.',
      author: '秋芝2046',
      license: 'Apache-2.0',
      type: 'module',
      dependencies: {
        'electron-updater': '^6.3.9',
      },
    })
  })
})

describe('preparePackagedAppDir', () => {
  it('stages runtime build output and links node_modules without copying project metadata noise', async () => {
    const { preparePackagedAppDir } = await loadPrepareModule()
    const projectDir = await makeTempDir('qclaw-prepare-app-dir-')
    const appDir = path.join(projectDir, '.electron-builder', 'app')

    await fs.mkdir(path.join(projectDir, 'dist-electron', 'main'), { recursive: true })
    await fs.mkdir(path.join(projectDir, 'dist-electron', 'preload'), { recursive: true })
    await fs.mkdir(path.join(projectDir, 'dist', 'assets'), { recursive: true })
    await fs.mkdir(path.join(projectDir, 'node_modules', 'electron-updater'), { recursive: true })

    await fs.writeFile(path.join(projectDir, 'dist-electron', 'main', 'index.js'), 'console.log("main")\n', 'utf8')
    await fs.writeFile(path.join(projectDir, 'dist-electron', 'preload', 'index.mjs'), 'console.log("preload")\n', 'utf8')
    await fs.writeFile(path.join(projectDir, 'dist', 'index.html'), '<html></html>\n', 'utf8')
    await fs.writeFile(path.join(projectDir, 'node_modules', 'electron-updater', 'index.js'), 'module.exports = {}\n', 'utf8')
    await fs.writeFile(
      path.join(projectDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'qclaw-lite',
          productName: 'Qclaw',
          version: '2.2.0',
          main: 'dist-electron/main/index.js',
          description: 'Electron desktop setup wizard for OpenClaw.',
          author: '秋芝2046',
          license: 'Apache-2.0',
          type: 'module',
          scripts: {
            build: 'vite build',
          },
          dependencies: {
            'electron-updater': '^6.3.9',
          },
          devDependencies: {
            vite: '^5.4.11',
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    )

    await preparePackagedAppDir({ projectDir, appDir })

    await expect(fs.readFile(path.join(appDir, 'dist-electron', 'main', 'index.js'), 'utf8')).resolves.toContain('main')
    await expect(fs.readFile(path.join(appDir, 'dist-electron', 'preload', 'index.mjs'), 'utf8')).resolves.toContain('preload')
    await expect(fs.readFile(path.join(appDir, 'dist', 'index.html'), 'utf8')).resolves.toContain('<html>')

    const stagedManifest = JSON.parse(await fs.readFile(path.join(appDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(stagedManifest.scripts).toBeUndefined()
    expect(stagedManifest.devDependencies).toBeUndefined()
    expect(stagedManifest.dependencies).toEqual({
      'electron-updater': '^6.3.9',
    })

    const nodeModulesStat = await fs.lstat(path.join(appDir, 'node_modules'))
    expect(nodeModulesStat.isSymbolicLink()).toBe(true)
  })
})
