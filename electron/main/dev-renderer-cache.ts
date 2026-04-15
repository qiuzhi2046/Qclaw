interface RendererCacheSession {
  clearCache(): Promise<void>
  clearCodeCaches(options: { urls?: string[] }): Promise<void>
  clearStorageData(options: {
    origin?: string
    storages?: Array<'serviceworkers'>
  }): Promise<void>
}

export async function clearDevRendererCache(
  session: RendererCacheSession,
  devServerUrl: string
): Promise<void> {
  const origin = new URL(devServerUrl).origin

  await session.clearCache()
  await session.clearCodeCaches({})
  await session.clearStorageData({
    origin,
    storages: ['serviceworkers'],
  })
}
