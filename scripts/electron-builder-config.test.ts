import { describe, expect, it } from 'vitest'

const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
const path = process.getBuiltinModule('node:path') as typeof import('node:path')

function readPackageJson(): Record<string, unknown> {
  const packageJsonPath = path.join(process.cwd(), 'package.json')
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>
}

function readElectronBuilderConfig(): Record<string, unknown> {
  const configPath = path.join(process.cwd(), 'electron-builder.json')
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
}

describe('package mac scripts', () => {
  it('prepares a dedicated electron app directory as part of build:app', () => {
    const packageJson = readPackageJson()
    const scripts = (packageJson.scripts ?? {}) as Record<string, unknown>

    expect(scripts['build:app']).toBe('tsc && vite build && node scripts/prepare-electron-app-dir.mjs')
  })

  it('builds both arm64 and x64 mac artifacts from the default package:mac entrypoint', () => {
    const packageJson = readPackageJson()
    const scripts = (packageJson.scripts ?? {}) as Record<string, unknown>

    expect(scripts['package:mac']).toBe(
      'npm run check:mac:release-env -- --allow-placeholder-publish --skip-notarize && npm run build:app && QCLAW_SKIP_NOTARIZE=1 node scripts/run-electron-builder.mjs --mac --arm64 --x64 --publish never'
    )
  })
})

describe('electron-builder mac dmg config', () => {
  it('packages from a staged app directory instead of the project root', () => {
    const config = readElectronBuilderConfig()
    const directories = (config.directories ?? {}) as Record<string, unknown>

    expect(directories.app).toBe('.electron-builder/app')
  })

  it('does not pass an empty dmg title that would collapse the mounted volume path to /Volumes', () => {
    const config = readElectronBuilderConfig()
    const dmg = (config.dmg ?? {}) as Record<string, unknown>

    if (!Object.prototype.hasOwnProperty.call(dmg, 'title')) {
      expect(dmg.title).toBeUndefined()
      return
    }

    expect(typeof dmg.title).toBe('string')
    expect(String(dmg.title).trim().length).toBeGreaterThan(0)
  })

  it('includes the target arch in mac artifact names so arm64 and x64 outputs do not overwrite each other', () => {
    const config = readElectronBuilderConfig()
    const mac = (config.mac ?? {}) as Record<string, unknown>

    expect(mac.artifactName).toBe('Qclaw-Lite_${env.QCLAW_DISPLAY_VERSION}-${arch}.${ext}')
  })
})
