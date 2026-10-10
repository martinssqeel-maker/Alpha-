import { X } from 'lucide-react'
import { useApp } from '../store/useApp'

export default function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <div className="flex items-start gap-2">
            <span className="flex-1">{t.message}</span>
            <button className="btn ghost icon" style={{ width: 22, height: 22, padding: 2 }} onClick={() => dismiss(t.id)}>
              <X size={13} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
