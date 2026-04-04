import React from 'react'
import ReactDOM from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { ModalsProvider } from '@mantine/modals'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import { theme, cssVariablesResolver, shouldClearStoredColorScheme } from './theme'
import App from './App'
import './index.css'

// 仅清理未知的历史主题值，保留用户明确选择的亮/暗色偏好
try {
  const stored = localStorage.getItem('mantine-color-scheme-value')
  if (shouldClearStoredColorScheme(stored)) {
    localStorage.removeItem('mantine-color-scheme-value')
  }
} catch {}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light" cssVariablesResolver={cssVariablesResolver}>
      <ModalsProvider>
        <Notifications position="top-right" />
        <App />
      </ModalsProvider>
    </MantineProvider>
  </React.StrictMode>,
)
