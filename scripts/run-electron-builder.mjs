import { spawn } from 'node:child_process'
import { readLocalPublishUrl } from './electron-builder-local-config.mjs'
import { claimPackageVersion, persistPackageVersionState, releasePackageVersionClaim } from './package-version.mjs'

const forwardedArgs = process.argv.slice(2)
const packageVersion = claimPackageVersion()
const { version, displayVersion, timeZone, fromOverride } = packageVersion
const localPublishUrl = await readLocalPublishUrl()
const updatePublishUrl = localPublishUrl || String(process.env.QCLAW_UPDATE_PUBLISH_URL || '').trim()

const builderArgs = [
  ...forwardedArgs,
  `-c.extraMetadata.version=${version}`,
  ...(updatePublishUrl ? [`-c.publish.url="${updatePublishUrl}"`] : []),
]

console.log(
  `[run-electron-builder] 使用打包版本号 ${displayVersion}（内部 semver ${version}${fromOverride ? '，来自环境变量覆盖' : `，时区 ${timeZone}`})`
)
if (updatePublishUrl) {
  console.log(
    localPublishUrl
      ? '[run-electron-builder] 已通过 electron-builder.local.json 注入自动更新源。'
      : '[run-electron-builder] 已通过 QCLAW_UPDATE_PUBLISH_URL 注入自动更新源。'
  )
}

const child = spawn('electron-builder', builderArgs, {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    QCLAW_EFFECTIVE_VERSION: version,
    QCLAW_DISPLAY_VERSION: displayVersion,
  },
})

child.on('error', (error) => {
  try {
    releasePackageVersionClaim(packageVersion)
  } catch (releaseError) {
    console.error(
      `[run-electron-builder] electron-builder 启动失败，且回滚每日版本计数失败：${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
    )
  }

  console.error(`[run-electron-builder] 无法启动 electron-builder：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    try {
      releasePackageVersionClaim(packageVersion)
    } catch (error) {
      console.error(
        `[run-electron-builder] 打包进程被信号 ${signal} 终止，回滚每日版本计数失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
    process.kill(process.pid, signal)
    return
  }

  if ((code ?? 1) === 0) {
    try {
      const persistedState = persistPackageVersionState(packageVersion)
      if (persistedState?.skipped) {
        console.log('[run-electron-builder] 打包已成功，但每日计数状态已切换到更新日期，本次不再覆盖旧状态。')
      } else if (persistedState) {
        console.log(
          `[run-electron-builder] 已记录今日打包序号 ${packageVersion.buildLabel}，计数文件：${persistedState.statePath}`
        )
      }
    } catch (error) {
      console.error(
        `[run-electron-builder] 打包成功，但写入每日版本计数失败：${error instanceof Error ? error.message : String(error)}`
      )
      process.exit(1)
      return
    }
  } else {
    try {
      const releasedState = releasePackageVersionClaim(packageVersion)
      if (releasedState?.released) {
        console.log(`[run-electron-builder] 打包失败，已回滚未完成的每日版本号 ${displayVersion}。`)
      }
    } catch (error) {
      console.error(
        `[run-electron-builder] 打包失败，且回滚每日版本计数失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  process.exit(code ?? 1)
})
