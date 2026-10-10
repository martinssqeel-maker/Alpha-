import { useEffect, useRef, useState } from 'react'
import { useApp } from './store/useApp'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import Splash from './components/Splash'
import Inspector from './components/Inspector'
import Toasts from './components/Toasts'
import ApprovalDialog from './components/ApprovalDialog'
import ChatPage from './pages/ChatPage'
import ModelsPage from './pages/ModelsPage'
import ProvidersPage from './pages/ProvidersPage'
import ProjectsPage from './pages/ProjectsPage'
import GitHubPage from './pages/GitHubPage'
import SettingsPage from './pages/SettingsPage'
import HelpPage from './pages/HelpPage'

export default function App() {
  const ready = useApp((s) => s.ready)
  const init = useApp((s) => s.init)
  const view = useApp((s) => s.view)
  const inspectorOpen = useApp((s) => s.inspectorOpen)
  const inspectorWidth = useApp((s) => s.inspectorWidth)
  const setInspectorWidth = useApp((s) => s.setInspectorWidth)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [splashPhase, setSplashPhase] = useState<'show' | 'leaving' | 'done'>('show')
  const dragging = useRef(false)

  useEffect(() => {
    init().catch((e) => setStartupError((e as Error).message))
  }, [init])

  useEffect(() => {
    if (!ready || splashPhase !== 'show') return
    const hold = 1600
    const fade = 500
    const t1 = setTimeout(() => setSplashPhase('leaving'), hold)
    const t2 = setTimeout(() => setSplashPhase('done'), hold + fade)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
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
      case 'models':
        return <ModelsPage />
      case 'providers':
        return <ProvidersPage />
      case 'projects':
        return <ProjectsPage />
      case 'github':
        return <GitHubPage />
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
      <TitleBar />
      <div className="workspace">
        <Sidebar />
        <div className="main-area">{ready ? content() : <Loading />}</div>
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
              <Inspector />
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
