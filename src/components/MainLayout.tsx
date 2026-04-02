import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Tooltip } from '@mantine/core'
import logoSrc from '@/assets/logo.png'
import tooltips from '@/constants/tooltips.json'

const NAV_ITEMS = [
  {
    to: '/',
    label: '面板',
    tooltip: tooltips.layout.navigation.dashboardExplain,
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
      </svg>
    ),
  },
  {
    to: '/chat',
    label: '对话',
    tooltip: tooltips.layout.navigation.chatExplain,
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    ),
  },
  {
    to: '/channels',
    label: 'IM 渠道',
    tooltip: tooltips.layout.navigation.channelsExplain,
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
      </svg>
    ),
  },
  {
    to: '/models',
    label: '模型与 API',
    tooltip: tooltips.layout.navigation.modelsExplain,
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    to: '/skills',
    label: 'Skills',
    tooltip: tooltips.layout.navigation.skillsExplain,
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
      </svg>
    ),
  },
  {
    to: '/knowledge',
    label: '知识库',
    tooltip: tooltips.layout.navigation.knowledgeExplain,
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
      </svg>
    ),
  },
]

export default function MainLayout() {
  const location = useLocation()

  const isActive = (to: string) => {
    if (to === '/') return location.pathname === '/'
    return location.pathname.startsWith(to)
  }

  return (
    <div className="h-screen app-bg-primary app-text-primary flex flex-col">
      {/* Draggable title bar */}
      <div
        className="h-8 flex-shrink-0 flex items-center justify-center gap-1.5 border-b app-border"
        style={{ WebkitAppRegion: 'drag' } as any}
      >
        <img src={logoSrc} alt="" className="w-8 h-8 select-none pointer-events-none" />
        <span className="text-sm app-text-secondary select-none font-medium">Qclaw</span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <nav className="w-[160px] flex-shrink-0 border-r app-border flex flex-col py-2 px-2">
          <div className="space-y-0.5 flex-1">
            {NAV_ITEMS.map((item) => (
              <Tooltip
                key={item.to}
                label={item.tooltip || item.label}
                position="right"
                withArrow
                multiline
                maw={260}
                disabled={!item.tooltip}
              >
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm no-underline transition-colors ${
                    isActive(item.to)
                      ? 'bg-[var(--mantine-color-brand-light)] text-[var(--mantine-color-brand-light-color)]'
                      : 'app-text-muted hover:app-text-secondary hover:app-bg-tertiary'
                  }`}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </NavLink>
              </Tooltip>
            ))}
          </div>
          <div className="mt-auto pt-2 border-t app-border">
            <NavLink
              to="/settings"
              end={false}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm no-underline transition-colors ${
                location.pathname.startsWith('/settings')
                  ? 'bg-[var(--mantine-color-brand-light)] text-[var(--mantine-color-brand-light-color)]'
                  : 'app-text-muted hover:app-text-secondary hover:app-bg-tertiary'
              }`}
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span>设置</span>
            </NavLink>
          </div>
        </nav>

        {/* Content */}
        <main className="flex-1 min-h-0 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
