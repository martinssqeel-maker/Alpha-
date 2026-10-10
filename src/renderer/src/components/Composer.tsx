import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, Mic, Paperclip, Square, X } from 'lucide-react'
import type { AttachmentRef, PermissionMode } from '@shared/types'
import { permissionsForMode } from '@shared/permissions'
import { api } from '../lib/api'
import { useApp } from '../store/useApp'
import ModelMenu from './ModelMenu'

const MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'chat', label: 'Chat', hint: 'Conversation only — no project access' },
  { id: 'assist', label: 'Assist', hint: 'Read & propose, approval for changes' },
  { id: 'agent', label: 'Agent', hint: 'Run multi-step tasks within the project' }
]

export default function Composer() {
  const [attachments, setAttachments] = useState<AttachmentRef[]>([])
  const [recording, setRecording] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const text = useApp((s) => s.draft)
  const setText = useApp((s) => s.setDraft)
  const isSending = useApp((s) => s.isSending)
  const send = useApp((s) => s.send)
  const stop = useApp((s) => s.stop)
  const toast = useApp((s) => s.toast)
  const mode = useApp((s) => s.settings?.permissions.mode ?? 'assist')
  const saveSettings = useApp((s) => s.saveSettings)
  const activeProject = useApp((s) => s.projects.find((p) => p.id === s.activeProjectId))

  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'
  }, [text])

  const doSend = async (): Promise<void> => {
    const value = text.trim()
    if (!value && attachments.length === 0) return
    if (isSending) return
    setText('')
    const atts = attachments
    setAttachments([])
    await send(value, atts)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void doSend()
    }
  }

  const attach = async (): Promise<void> => {
    const res = await api.attachments.pick()
    if (res.attachments.length) setAttachments((a) => [...a, ...res.attachments])
  }

  const readDropped = async (files: FileList): Promise<void> => {
    const next: AttachmentRef[] = []
    for (const file of Array.from(files).slice(0, 10)) {
      const isText = /\.(txt|md|markdown|json|csv|tsv|log|ya?ml|toml|ini|ts|tsx|js|jsx|py|rb|go|rs|java|cs|cpp|c|h|css|html|sh|ps1|sql)$/i.test(
        file.name
      )
      if (isText && file.size < 2_000_000) {
        const content = await file.text()
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          mimeType: file.type || 'text/plain',
          size: file.size,
          kind: 'text',
          extractedText: content.slice(0, 200000)
        })
      } else if (file.type.startsWith('image/') && file.size < 8_000_000) {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.readAsDataURL(file)
        })
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          mimeType: file.type,
          size: file.size,
          kind: 'image',
          previewUrl: dataUrl,
          note: 'Images are only sent to models that support vision.'
        })
      } else {
        next.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          kind: 'binary',
          note: 'Use the attach button to parse PDFs and other formats.'
        })
      }
    }
    if (next.length) setAttachments((a) => [...a, ...next])
  }

  const toggleRecording = async (): Promise<void> => {
    if (recording) {
      recorderRef.current?.stop()
      setRecording(false)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data)
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        const buffer = await blob.arrayBuffer()
        const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
        const res = await api.voice.transcribe({ audioBase64: base64, mimeType: 'audio/webm' })
        if (res.error) toast(res.error, 'error')
        else if (res.text) setText((useApp.getState().draft + ' ' + res.text).trim())
      }
      recorder.start()
      recorderRef.current = recorder
      setRecording(true)
    } catch (e) {
      toast(`Microphone unavailable: ${(e as Error).message}`, 'error')
    }
  }

  const switchMode = async (m: PermissionMode): Promise<void> => {
    const current = useApp.getState().settings?.permissions
    await saveSettings({ permissions: permissionsForMode(m, current) })
  }

  return (
    <div
      className="p-3"
      style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-elevated)' }}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) void readDropped(e.dataTransfer.files)
      }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((a) => (
            <div key={a.id} className="card tight flex items-center gap-2" style={{ padding: '4px 8px' }}>
              {a.previewUrl && a.kind === 'image' ? (
                <img src={a.previewUrl} alt={a.name} style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'cover' }} />
              ) : (
                <Paperclip size={13} />
              )}
              <span className="text-xs" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.name}
              </span>
              <button
                className="btn ghost icon"
                style={{ width: 18, height: 18, padding: 1 }}
                onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className="card tight flex items-end gap-2"
        style={{
          padding: 8,
          borderColor: dragOver ? 'var(--accent)' : 'var(--border)',
          background: 'var(--surface)'
        }}
      >
        <button className="btn ghost icon" onClick={attach} title="Attach files">
          <Paperclip size={16} />
        </button>
        <textarea
          ref={textareaRef}
          className="textarea"
          rows={1}
          placeholder={
            activeProject
              ? `Ask something about ${activeProject.name}…  (Enter to send, Shift+Enter for newline)`
              : 'Ask a question…  (Enter to send, Shift+Enter for newline)'
          }
          style={{ border: 'none', background: 'transparent', padding: '6px 2px', maxHeight: 220 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="btn ghost icon"
          onClick={toggleRecording}
          title={recording ? 'Stop recording' : 'Voice input'}
          style={{ color: recording ? 'var(--danger)' : undefined }}
        >
          <Mic size={16} />
        </button>
        {isSending ? (
          <button className="btn danger icon" onClick={() => stop()} title="Stop">
            <Square size={15} />
          </button>
        ) : (
          <button
            className="btn primary icon"
            onClick={() => doSend()}
            disabled={!text.trim() && attachments.length === 0}
            title="Send"
          >
            {isSending ? <Loader2 size={15} className="spin" /> : <ArrowUp size={16} />}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 mt-2">
        <ModelMenu />
        <select
          className="select text-xs"
          style={{ width: 120, padding: '4px 8px' }}
          value={mode}
          onChange={(e) => switchMode(e.target.value as PermissionMode)}
          title={MODES.find((m) => m.id === mode)?.hint}
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} mode
            </option>
          ))}
        </select>
        {activeProject ? (
          <span className="pill">{activeProject.name}</span>
        ) : (
          <span className="pill warn">No project</span>
        )}
        {recording && <span className="pill err">recording…</span>}
        <div className="flex-1" />
        <span className="text-xs" style={{ color: 'var(--faint)' }}>
          {mode === 'chat'
            ? 'Chat mode: read/write disabled'
            : mode === 'assist'
              ? 'Assist mode: changes need approval'
              : 'Agent mode: fewer prompts'}
        </span>
      </div>
    </div>
  )
}
