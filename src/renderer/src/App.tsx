import { useEffect, useRef, useState } from 'react'
import { useApp } from './store/useApp'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import Splash from './components/Splash'
import Inspector from './components/Inspector'
import Toasts from './components/Toasts'
import UpdateBanner from './components/UpdateBanner'
import ApprovalDialog from './components/ApprovalDialog'
import ErrorBoundary from './components/ErrorBoundary'
import ChatPage from './pages/ChatPage'
import ModelsPage from './pages/ModelsPage'
import ProvidersPage from './pages/ProvidersPage'
import ProjectsPage from './pages/ProjectsPage'
import GitHubPage from './pages/GitHubPage'
import SettingsPage from './pages/SettingsPage'
import HelpPage from './pages/HelpPage'
import LiveBackgroundCanvas from './components/LiveBackgroundCanvas'
import { useLiveBackground } from './themes/useLiveBackground'
import HomePage from './pages/HomePage'
import SkillsPage from './pages/SkillsPage'

/** How long the launch splash is held, and how long its fade-out takes. */
const SPLASH_HOLD_MS = 1600
const SPLASH_FADE_MS = 160
/**
 * Upper bound on how long the splash may stay up when startup is slow. The
 * overlay covers the whole window, so a stalled init must never be able to keep
 * it there indefinitely.
 */
const SPLASH_MAX_WAIT_MS = 8000

export default function App() {
  const ready = useApp((s) => s.ready)
  const init = useApp((s) => s.init)
  const view = useApp((s) => s.view)
  const inspectorOpen = useApp((s) => s.inspectorOpen)
  const inspectorWidth = useApp((s) => s.inspectorWidth)
  const setInspectorWidth = useApp((s) => s.setInspectorWidth)
  const settingsTheme = useApp((s) => s.settings?.theme)
  const appearance = useApp((s) => s.settings?.appearance)
  const live = useLiveBackground(settingsTheme, appearance)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [splashPhase, setSplashPhase] = useState<'show' | 'leaving' | 'done'>('show')
  const dragging = useRef(false)

  useEffect(() => {
    init().catch((e) => setStartupError((e as Error).message))
  }, [init])

  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: dark)')
    const applySystemTheme = (): void => {
      if (useApp.getState().settings?.theme === 'system') useApp.getState().applyTheme()
    }
    preference.addEventListener('change', applySystemTheme)
    return () => preference.removeEventListener('change', applySystemTheme)
  }, [settingsTheme])

  // Advance the splash exactly one phase at a time.
  //
  // The overlay is `position: fixed; inset: 0; z-index: 999`, so it must always
  // reach 'done' and unmount. Arming a single timer per phase is what guarantees
  // that: the effect re-runs as soon as the phase changes, and its cleanup can
  // then only ever cancel the next pending step. The previous version armed both
  // timers together, so the cleanup that ran when the phase flipped to 'leaving'
  // also cancelled the 'done' timer, and the guard (`splashPhase !== 'show'`)
  // refused to re-arm it. The overlay was left mounted at `splash-leaving`
  // (opacity: 0 — invisible) covering every control in the window.
  useEffect(() => {
    if (splashPhase === 'done') return
    const show = splashPhase === 'show'
    const delay = show ? (ready ? SPLASH_HOLD_MS : SPLASH_MAX_WAIT_MS) : SPLASH_FADE_MS
    const timer = setTimeout(() => setSplashPhase(show ? 'leaving' : 'done'), delay)
    return () => clearTimeout(timer)
  }, [ready, splashPhase])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return
      const width = Math.min(Math.max(window.innerWidth - e.clientX, 300), 860)
      setInspectorWidth(width)
    }
    const onUp = (): void => {
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ''
        void useApp
          .getState()
          .saveSettings({ layout: { inspectorWidth: useApp.getState().inspectorWidth } })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [setInspectorWidth])

  if (startupError) {
    return (
      <div className="app-shell">
        <TitleBar />
        <div className="p-8">
          <div className="card">
            <h2 className="text-lg font-semibold mb-2">Startup error</h2>
            <p className="text-sm" style={{ color: 'var(--danger)' }}>
              {startupError}
            </p>
          </div>
        </div>
      </div>
    )
  }

  const content = () => {
    switch (view) {
      case 'home':
        return <HomePage />
      case 'models':
        return <ModelsPage />
      case 'providers':
        return <ProvidersPage />
      case 'projects':
        return <ProjectsPage />
      case 'github':
        return <GitHubPage />
      case 'skills':
        return <SkillsPage />
      case 'settings':
        return <SettingsPage />
      case 'help':
        return <HelpPage />
      default:
        return <ChatPage />
    }
  }

  return (
    <div className="app-shell">
      <LiveBackgroundCanvas
        shader={live.paintShader}
        accent={live.accent}
        secondary={live.secondary}
        paused={live.paused}
      />
      <TitleBar />
      <UpdateBanner />
      <div className="workspace">
        <Sidebar />
        <div className="main-area">
          <ErrorBoundary label="This screen">{ready ? content() : <Loading />}</ErrorBoundary>
        </div>
        {view === 'chat' && inspectorOpen && (
          <>
            <div
              className="resize-handle"
              onMouseDown={() => {
                dragging.current = true
                document.body.style.cursor = 'col-resize'
              }}
            />
            <div className="inspector" style={{ ['--inspector-width' as string]: `${inspectorWidth}px` }}>
              <ErrorBoundary label="The workspace panel">
                <Inspector />
              </ErrorBoundary>
            </div>
          </>
        )}
      </div>
      <Toasts />
      <ApprovalDialog />
      {splashPhase !== 'done' && <Splash leaving={splashPhase === 'leaving'} />}
    </div>
  )
}

function Loading() {
  return (
    <div className="flex items-center justify-center h-full" style={{ color: 'var(--muted)' }}>
      <span className="spin mr-2">◌</span> Starting Alpha…
    </div>
  )
}
