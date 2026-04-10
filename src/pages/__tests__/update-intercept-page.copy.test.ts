import { describe, expect, it } from 'vitest'
import updateInterceptPageSource from '../UpdateInterceptPage.tsx?raw'

describe('UpdateInterceptPage copy', () => {
  it('does not show the skip helper notice below the update actions', () => {
    expect(updateInterceptPageSource).not.toContain(
      '稍后再说将进入主界面，侧边栏仍会显示新版本提示'
    )
  })
})
