import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, File, Folder, FolderOpen, RefreshCw, Search, X } from 'lucide-react'
import type { FileNode, SearchResult } from '@shared/types'
import { api } from '../../lib/api'
import { useApp } from '../../store/useApp'
import { useWorkspace } from '../../store/useWorkspace'

export default function ExplorerPanel() {
  const project = useApp((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const tree = useApp((s) => s.tree)
  const refreshTree = useApp((s) => s.refreshTree)
  const [query, setQuery] = useState('')
  const [contentSearch, setContentSearch] = useState(false)
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [nameResults, setNameResults] = useState<FileNode[] | null>(null)
  const [searching, setSearching] = useState(false)
  const selectFile = useWorkspace((s) => s.selectFile)
  const setTab = useApp((s) => s.setInspectorTab)

  useEffect(() => {
    if (!project) return
    if (!query.trim()) {
      setResults(null)
      setNameResults(null)
      return
    }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        if (contentSearch) {
          setResults(await api.projects.searchContent(project.id, query.trim()))
          setNameResults(null)
        } else {
          setNameResults(await api.projects.search(project.id, query.trim()))
          setResults(null)
        }
      } catch {
        /* ignore */
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [query, contentSearch, project?.id])

  if (!project) {
    return <Empty text="No project open. Open a folder to browse files." />
  }

  const openFile = (path: string): void => {
    void selectFile(path)
    setTab('diff')
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 p-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-1 flex-1">
          <Search size={13} style={{ color: 'var(--muted)' }} />
          <input
            className="input text-xs"
            style={{ padding: '4px 8px' }}
            placeholder={contentSearch ? 'Search file contents…' : 'Search file names…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="btn ghost icon" style={{ width: 22, height: 22 }} onClick={() => setQuery('')}>
              <X size={12} />
            </button>
          )}
        </div>
        <button
          className={`btn icon ${contentSearch ? 'primary' : 'ghost'}`}
          style={{ width: 26, height: 26 }}
          title="Toggle content search"
          onClick={() => setContentSearch((v) => !v)}
        >
          abc
        </button>
        <button className="btn ghost icon" style={{ width: 26, height: 26 }} title="Refresh" onClick={() => void refreshTree()}>
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-1">
        {searching && <div className="text-xs p-2" style={{ color: 'var(--muted)' }}>Searching…</div>}

        {nameResults && (
          <div>
            {nameResults.map((n) => (
              <button
                key={n.path}
                className="tree-item"
                onClick={() => n.type === 'file' && openFile(n.path)}
              >
                {n.type === 'directory' ? <Folder size={13} /> : <File size={13} />}
                <span className="label text-xs">{n.name}</span>
                <span className="text-xs" style={{ color: 'var(--faint)' }}>{n.path}</span>
              </button>
            ))}
            {nameResults.length === 0 && <div className="text-xs p-2" style={{ color: 'var(--faint)' }}>No matches</div>}
          </div>
        )}

        {results && (
          <div>
            {results.map((r, i) => (
              <button key={`${r.path}:${r.line}:${i}`} className="tree-item" onClick={() => openFile(r.path)} title={r.preview}>
                <File size={13} />
                <span className="label text-xs">{r.path}</span>
                <span className="text-xs" style={{ color: 'var(--faint)' }}>{r.line}</span>
              </button>
            ))}
            {results.length === 0 && <div className="text-xs p-2" style={{ color: 'var(--faint)' }}>No matches</div>}
          </div>
        )}

        {!results && !nameResults && (
          <Tree nodes={tree} depth={0} onOpen={openFile} projectId={project.id} />
        )}
      </div>
    </div>
  )
}

function Tree({
  nodes,
  depth,
  onOpen,
  projectId
}: {
  nodes: FileNode[]
  depth: number
  onOpen: (path: string) => void
  projectId: string
}) {
  return (
    <div>
      {nodes.map((node) => (
        <TreeNode key={node.path} node={node} depth={depth} onOpen={onOpen} projectId={projectId} />
      ))}
      {nodes.length === 0 && <div className="text-xs p-2" style={{ color: 'var(--faint)' }}>Empty</div>}
    </div>
  )
}

function TreeNode({
  node,
  depth,
  onOpen,
  projectId
}: {
  node: FileNode
  depth: number
  onOpen: (path: string) => void
  projectId: string
}) {
  const [open, setOpen] = useState(depth === 0)
  const [children, setChildren] = useState<FileNode[] | null>(node.children ?? null)
  const [loading, setLoading] = useState(false)

  const hasChildren = node.type === 'directory'

  const toggle = async (): Promise<void> => {
    if (!hasChildren) {
      onOpen(node.path)
      return
    }
    const next = !open
    setOpen(next)
    if (next && children === null) {
      setLoading(true)
      try {
        const kids = await api.projects.tree(projectId, node.path, 1)
        setChildren(kids)
      } catch {
        setChildren([])
      } finally {
        setLoading(false)
      }
    }
  }

  const depthStyle = useMemo(() => ({ paddingLeft: 6 + depth * 12 }), [depth])

  return (
    <div>
      <button className="tree-item" style={depthStyle} onClick={toggle} title={node.path}>
        {hasChildren ? (
          <ChevronRight size={12} className={open ? 'rotate-90' : ''} style={{ transition: 'transform .1s' }} />
        ) : (
          <span style={{ width: 12 }} />
        )}
        {hasChildren ? open ? <FolderOpen size={13} /> : <Folder size={13} /> : <File size={13} />}
        <span className="label text-xs">{node.name}</span>
      </button>
      {open && hasChildren && (
        <div>
          {loading && <div className="text-xs" style={{ paddingLeft: depthStyle.paddingLeft + 18, color: 'var(--faint)' }}>loading…</div>}
          {children && <Tree nodes={children} depth={depth + 1} onOpen={onOpen} projectId={projectId} />}
        </div>
      )}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-full p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
      {text}
    </div>
  )
}
