import { useState } from 'react'
import { Check, Copy, FileWarning } from 'lucide-react'
import { useWorkspace } from '../../store/useWorkspace'

export default function DiffPanel() {
  const diff = useWorkspace((s) => s.diff)
  const file = useWorkspace((s) => s.file)
  const fileLoading = useWorkspace((s) => s.fileLoading)
  const fileError = useWorkspace((s) => s.fileError)
  const selectedPath = useWorkspace((s) => s.selectedPath)

  if (diff) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 p-2 text-xs" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="font-medium mono">{diff.title}</span>
          <span className="pill" style={{ fontSize: 10, padding: '0 6px' }}>{diff.mode === 'git' ? 'git diff' : 'proposed edit'}</span>
        </div>
        <DiffBody patch={diff.patch} />
      </div>
    )
  }

  if (fileLoading) {
    return <Empty text="Loading file…" />
  }

  if (fileError) {
    return <Empty text={fileError} />
  }

  if (file) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 p-2 text-xs" style={{ borderBottom: '1px solid var(--border)' }}>
          <span className="font-medium mono flex-1" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {file.path}
          </span>
          {file.language && <span className="pill" style={{ fontSize: 10, padding: '0 6px' }}>{file.language}</span>}
          <span className="text-xs" style={{ color: 'var(--faint)' }}>{formatBytes(file.size)}</span>
          <CopyButton text={file.content} />
        </div>
        {file.binary ? (
          <Empty text="Binary file — preview unavailable." icon />
        ) : (
          <div className="file-view">
            <FileLines content={file.content} />
          </div>
        )}
        {file.truncated && (
          <div className="p-2 text-xs" style={{ color: 'var(--warn)', borderTop: '1px solid var(--border)' }}>
            File is large — showing a truncated preview.
          </div>
        )}
      </div>
    )
  }

  return <Empty text={selectedPath ? 'Select a file to preview.' : 'Open a file from the Explorer or Changes tab.'} />
}

function FileLines({ content }: { content: string }) {
  const lines = content.split('\n')
  return (
    <table className="code-table">
      <tbody>
        {lines.map((line, i) => (
          <tr key={i}>
            <td className="ln">{i + 1}</td>
            <td className="lc">{line || ' '}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DiffBody({ patch }: { patch: string }) {
  const lines = patch.split('\n')
  return (
    <div className="diff-view flex-1 overflow-auto">
      <table className="code-table">
        <tbody>
          {lines.map((line, i) => {
            let cls = 'ctx'
            if (line.startsWith('@@')) cls = 'hunk'
            else if (line.startsWith('+++') || line.startsWith('---')) cls = 'meta'
            else if (line.startsWith('+')) cls = 'add'
            else if (line.startsWith('-')) cls = 'del'
            return (
              <tr key={i} className={`diff-${cls}`}>
                <td className="lc mono">{line || ' '}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="btn ghost icon"
      style={{ width: 24, height: 24 }}
      title="Copy contents"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

function Empty({ text, icon }: { text: string; icon?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-6 text-center text-sm gap-2" style={{ color: 'var(--muted)' }}>
      {icon && <FileWarning size={20} />}
      {text}
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
