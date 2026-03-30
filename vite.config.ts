import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import { sanitizeNodeOptionsForElectron } from './electron/main/node-options'
import pkg from './package.json'
import installWebPolicy from './install-web-v1.manifest.json'

const DEFAULT_DEV_SERVER_URL =
  (installWebPolicy as { desktop?: { devServer?: { defaultUrl?: string } } }).desktop?.devServer?.defaultUrl ||
  'http://127.0.0.1:7777/'

function isEnabled(value: string | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function resolveElectronSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv = { ...env }
  const sanitizedNodeOptions = sanitizeNodeOptionsForElectron(env.NODE_OPTIONS)
  if (sanitizedNodeOptions) {
    nextEnv.NODE_OPTIONS = sanitizedNodeOptions
  } else {
    delete nextEnv.NODE_OPTIONS
  }

  return nextEnv
}

function syncDevElectronBundleIcon() {
  // macOS only: sync .icns icon and update Info.plist for dev Electron.app
  if (process.platform !== 'darwin') return

  const sourceIconPath = path.join(__dirname, 'build', 'icon.icns')
  const electronAppPath = path.join(
    __dirname,
    'node_modules',
    'electron',
    'dist',
    'Electron.app'
  )
  const infoPlistPath = path.join(
    electronAppPath,
    'Contents',
    'Info.plist'
  )
  const targetIconPath = path.join(
    electronAppPath,
    'Contents',
    'Resources',
    'electron.icns'
  )

  if (!existsSync(sourceIconPath) || !existsSync(targetIconPath) || !existsSync(infoPlistPath)) {
    return
  }

  copyFileSync(sourceIconPath, targetIconPath)

  const plistStringUpdates: Array<[string, string]> = [
    ['CFBundleDisplayName', 'Qclaw'],
    ['CFBundleName', 'Qclaw'],
    ['CFBundleIdentifier', 'com.qclawai.qclaw.dev'],
  ]

  for (const [key, value] of plistStringUpdates) {
    execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, infoPlistPath])
  }

  execFileSync('/usr/bin/touch', [electronAppPath])
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  rmSync('dist-electron', { recursive: true, force: true })

  const isServe = command === 'serve'
  const isBuild = command === 'build'
  const isVsCodeDebug = isEnabled(process.env.VSCODE_DEBUG)
  const isManagedVsCodeDebugLaunch = isVsCodeDebug && isEnabled(process.env.VSCODE_DEBUG_LAUNCH)
  const sourcemap = isServe || isVsCodeDebug

  return {
    resolve: {
      alias: {
        '@': path.join(__dirname, 'src')
      },
    },
    plugins: [
      react(),
      electron({
        main: {
          // Shortcut of `build.lib.entry`
          entry: 'electron/main/index.ts',
          onstart(args) {
            syncDevElectronBundleIcon()
            if (isManagedVsCodeDebugLaunch) {
              console.log(/* For `.vscode/.debug.script.mjs` */'[startup] Electron App')
            } else {
              if (isVsCodeDebug) {
                console.warn(
                  '[debug] Detected VSCODE_DEBUG without VSCODE_DEBUG_LAUNCH=1. ' +
                  'Starting Electron automatically to avoid waiting forever.'
                )
              }
              args.startup(undefined, {
                env: resolveElectronSpawnEnv(process.env),
              })
            }
          },
          vite: {
            build: {
              sourcemap,
              minify: isBuild,
              outDir: 'dist-electron/main',
              rollupOptions: {
                external: Object.keys('dependencies' in pkg ? pkg.dependencies : {}),
              },
            },
          },
        },
        preload: {
          // Shortcut of `build.rollupOptions.input`.
          // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
          input: 'electron/preload/index.ts',
          vite: {
            build: {
              sourcemap: sourcemap ? 'inline' : undefined, // #332
              minify: isBuild,
              outDir: 'dist-electron/preload',
              rollupOptions: {
                external: Object.keys('dependencies' in pkg ? pkg.dependencies : {}),
              },
            },
          },
        },
        // Ployfill the Electron and Node.js API for Renderer process.
        // If you want use Node.js in Renderer process, the `nodeIntegration` needs to be enabled in the Main process.
        // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
        renderer: {},
      }),
    ],
    server: isVsCodeDebug && (() => {
      const url = new URL(process.env.VITE_DEV_SERVER_URL || DEFAULT_DEV_SERVER_URL)
      return {
        host: url.hostname,
        port: +url.port,
      }
    })(),
    clearScreen: false,
  }
})
