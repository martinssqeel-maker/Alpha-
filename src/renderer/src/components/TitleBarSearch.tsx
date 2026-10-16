import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderGit2, MessageSquare, Search } from 'lucide-react'
import type { Conversation } from '@shared/types'
import { api } from '../lib/api'
import { useApp } from '../store/useApp'

type Result = { kind: 'project' | 'conversation'; id: string; label: string; detail: string }

export default function TitleBarSearch() {
  const root = useRef<HTMLDivElement>(null)
  const projects = useApp((s) => s.projects)
  const toast = useApp((s) => s.toast)
  const [query, setQuery] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setConversations([])
      setSearching(false)
      setError('')
      return
    }

    let current = true
    setSearching(true)
    setError('')
    setConversations([])
    const timer = window.setTimeout(() => {
      void api.conversations.search(trimmed).then((items) => {
        if (current) setConversations(items)
      }).catch((reason: unknown) => {
        if (current) setError((reason as Error).message || 'Conversation search is unavailable.')
      }).finally(() => {
        if (current) setSearching(false)
      })
    }, 180)

    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [query])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
        root.current?.querySelector('input')?.focus()
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [])

  const projectResults = useMemo<Result[]>(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    return projects
      .filter((project) => {
        const haystack = `${project.name} ${project.rootPath}`.toLocaleLowerCase()
        return terms.every((term) => haystack.includes(term))
      })
      .slice(0, 5)
      .map((project) => ({ kind: 'project', id: project.id, label: project.name, detail: project.rootPath }))
  }, [projects, query])

  const conversationResults = useMemo<Result[]>(() => conversations.slice(0, 5).map((conversation) => {
    const project = projects.find((item) => item.id === conversation.projectId)
    return {
      kind: 'conversation',
      id: conversation.id,
      label: conversation.title,
      detail: project?.name ?? 'General conversation'
    }
  }), [conversations, projects])

  const results = useMemo(() => [...projectResults, ...conversationResults], [projectResults, conversationResults])

  const select = async (item: Result): Promise<void> => {
    const state = useApp.getState()
    try {
      if (item.kind === 'project') {
        await state.selectProject(item.id)
        useApp.getState().setView('chat')
      } else {
        await state.openConversation(item.id)
      }
      setOpen(false)
      setQuery('')
    } catch (reason) {
      toast(`Could not open ${item.kind}: ${(reason as Error).message}`, 'error')
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && results.length) {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % results.length)
    } else if (event.key === 'ArrowUp' && results.length) {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + results.length) % results.length)
    } else if (event.key === 'Enter' && results[activeIndex]) {
      event.preventDefault()
      void select(results[activeIndex])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (query) setQuery('')
      else setOpen(false)
    }
  }

  let resultIndex = 0
  const renderGroup = (kind: Result['kind'], label: string, Icon: typeof Search, items: Result[]) => {
    if (!items.length) return null
    return (
      <div role="group" aria-label={label} key={kind}>
        <div className="titlebar-search-group" role="presentation">{label}</div>
        {items.map((item) => {
          const index = resultIndex++
          return (
            <button
              id={`titlebar-search-option-${index}`}
              key={`${item.kind}:${item.id}`}
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              className={`titlebar-search-result${activeIndex === index ? ' active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void select(item)}
            >
              <Icon size={14} aria-hidden="true" />
              <span className="titlebar-search-result-copy">
                <span className="titlebar-search-result-label">{item.label}</span>
                <span className="titlebar-search-result-detail">{item.detail}</span>
              </span>
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="titlebar-search-wrap no-drag" ref={root}>
      <Search size={14} className="titlebar-search-icon" aria-hidden="true" />
      <input
        className="titlebar-search"
        type="search"
        role="combobox"
        aria-label="Search projects and conversations"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls="titlebar-search-results"
        aria-activedescendant={open && results[activeIndex] ? `titlebar-search-option-${activeIndex}` : undefined}
        placeholder="Search projects and chats"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true) }}
        onKeyDown={onKeyDown}
      />
      <kbd className="titlebar-search-shortcut" aria-hidden="true">Ctrl K</kbd>
      {open && (
        <div className="titlebar-search-popover" id="titlebar-search-results" role="listbox" aria-label="Search results">
          {!query.trim() && <div className="titlebar-search-empty">Type to search saved projects and conversations.</div>}
          {query.trim() && renderGroup('project', 'PROJECTS', FolderGit2, projectResults)}
          {query.trim() && renderGroup('conversation', 'CONVERSATIONS', MessageSquare, conversationResults)}
          {query.trim() && searching && <div className="titlebar-search-empty">Searching conversations…</div>}
          {query.trim() && !searching && !projectResults.length && !conversationResults.length && !error && (
            <div className="titlebar-search-empty">No matching projects or conversations.</div>
          )}
          {query.trim() && error && <div className="titlebar-search-error">{error}</div>}
        </div>
      )}
    </div>
  )
}
