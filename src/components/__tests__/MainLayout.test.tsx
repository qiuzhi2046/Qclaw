import { MantineProvider } from '@mantine/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import MainLayout from '../MainLayout'
import { UpdateNotificationProvider } from '../../contexts/UpdateNotificationContext'
import type { QClawUpdateStatus } from '../../shared/openclaw-phase4'

function createAvailableUpdateStatus(): QClawUpdateStatus {
  return {
    ok: true,
    supported: true,
    configured: true,
    currentVersion: '2.2.0',
    availableVersion: '2.2.1',
    status: 'available',
    progressPercent: null,
    downloaded: false,
    releaseDate: '2026-04-10',
    releaseNotes: 'UI preview',
  }
}

describe('MainLayout', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps settings and the update reminder in the same bottom navigation row with filled primary styling', () => {
    vi.stubGlobal('window', {
      api: {
        platform: 'darwin',
      },
    })

    const html = renderToStaticMarkup(
      <MantineProvider>
        <MemoryRouter initialEntries={['/settings']}>
          <Routes>
            <Route
              path="/"
              element={
                <UpdateNotificationProvider initialUpdate={createAvailableUpdateStatus()}>
                  <MainLayout />
                </UpdateNotificationProvider>
              }
            >
              <Route path="settings" element={<div>content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </MantineProvider>
    )

    expect(html).toContain('设置')
    expect(html).toContain('新版本')
    expect(html).toContain('mt-auto pt-2 border-t app-border')
    expect(html).toContain('flex items-center gap-2')
    expect(html).not.toContain('<span class="truncate">设置</span>')
    expect(html).toContain('inline-flex shrink-0 items-center gap-2 px-2.5 py-2 rounded-lg text-xs transition-colors')
    expect(html).toContain('border-0 outline-none focus:outline-none focus-visible:outline-none appearance-none')
    expect(html).toMatch(
      /<button[^>]*bg-\[var\(--mantine-primary-color-filled\)\][^>]*text-\[var\(--mantine-primary-color-contrast\)\][^>]*>新版本<\/button>/
    )
  })
})
