import { create } from 'zustand'
import type { SearchResult } from '@shared/types'
import type { FileReadResult } from '@shared/ipc'
import { api } from '../lib/api'
import { useApp } from './useApp'

export interface DiffState {
  title: string
  patch: string
  mode: 'git' | 'edit'
  path?: string
  staged?: boolean
}

interface WorkspaceState {
  selectedPath: string | null
  file: FileReadResult | null
  fileLoading: boolean
  fileError: string | null
  diff: DiffState | null
  searchResults: SearchResult[] | null
  selectFile: (path: string | null) => Promise<void>
  openDiff: (d: DiffState) => void
  clearDiff: () => void
  setSearchResults: (r: SearchResult[] | null) => void
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  selectedPath: null,
  file: null,
  fileLoading: false,
  fileError: null,
  diff: null,
  searchResults: null,

  selectFile: async (path) => {
    const projectId = useApp.getState().activeProjectId
    if (!path || !projectId) {
      set({ selectedPath: path, file: null, fileError: null })
      return
    }
    set({ selectedPath: path, fileLoading: true, fileError: null })
    try {
      const file = await api.projects.read(projectId, path)
      set({ file, fileLoading: false })
    } catch (e) {
      set({ file: null, fileLoading: false, fileError: (e as Error).message })
    }
  },

  openDiff: (diff) => set({ diff }),
  clearDiff: () => set({ diff: null }),
  setSearchResults: (searchResults) => set({ searchResults })
}))
