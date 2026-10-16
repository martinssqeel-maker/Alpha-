import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Mic, Paperclip, Square, X } from 'lucide-react'
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
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px'
  }, [text])

  // Escape stops the running response — the same action as the Stop button,
  // reachable without leaving the keyboard.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (!useApp.getState().isSending) return
      event.preventDefault()
      useApp.getState().stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
      className="composer-shell"
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
      <div className="composer-content">
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attached files">
            {attachments.map((a) => (
              <div key={a.id} className="composer-attachment">
                {a.previewUrl && a.kind === 'image' ? (
                  <img src={a.previewUrl} alt="" />
                ) : (
                  <Paperclip size={13} aria-hidden="true" />
                )}
                <span title={a.name}>{a.name}</span>
                <button
                  type="button"
                  className="composer-remove-attachment"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={`composer-input-card${dragOver ? ' drop-target' : ''}${isSending ? ' responding' : ''}`}>
          <textarea
            ref={textareaRef}
            className="textarea composer-textarea"
            rows={4}
            aria-label="Message Alpha AI"
            placeholder={
              activeProject
                ? `Ask Alpha about ${activeProject.name}…`
                : 'What would you like to work on?'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="composer-toolbar">
            <div className="composer-tool-group">
              <button type="button" className="composer-tool-btn" onClick={attach} title="Attach files" aria-label="Attach files">
                <Paperclip size={17} />
              </button>
              <button
                type="button"
                className={`composer-tool-btn${recording ? ' recording' : ''}`}
                onClick={toggleRecording}
                title={recording ? 'Stop voice recording' : 'Voice input'}
                aria-label={recording ? 'Stop voice recording' : 'Start voice input'}
                aria-pressed={recording}
              >
                <Mic size={17} />
              </button>
            </div>
            <span className="composer-shortcut" aria-live="polite">
              {recording ? 'Recording voice…' : 'Enter to send · Shift + Enter for a new line'}
            </span>
            {isSending ? (
              <button type="button" className="composer-send-btn stop" onClick={() => stop()} title="Stop response" aria-label="Stop response">
                <Square size={14} fill="currentColor" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                className="composer-send-btn"
                onClick={() => void doSend()}
                disabled={!text.trim() && attachments.length === 0}
                title="Send"
                aria-label="Send message"
              >
                <span>Send</span>
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>

        <div className="composer-contextbar">
          <div className="composer-context-controls">
            <ModelMenu />
            <label className="composer-mode-control">
              <span className="sr-only">Agent permission mode</span>
              <select
                className="select composer-mode-select"
                value={mode}
                onChange={(e) => switchMode(e.target.value as PermissionMode)}
                title={MODES.find((m) => m.id === mode)?.hint}
                aria-label="Agent permission mode"
              >
                {MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} mode
                  </option>
                ))}
              </select>
            </label>
            {activeProject ? (
              <span className="composer-project" title={`Project context: ${activeProject.name}`}>
                <span className="composer-project-dot" aria-hidden="true" />
                {activeProject.name}
              </span>
            ) : (
              <span className="composer-project no-project">No project</span>
            )}
          </div>
          <span className="composer-mode-note">
            {mode === 'chat'
              ? 'Chat · no project access'
              : mode === 'assist'
                ? 'Assist · approve file changes'
                : 'Agent · multi-step tasks'}
          </span>
        </div>
      </div>
    </div>
  )
}
