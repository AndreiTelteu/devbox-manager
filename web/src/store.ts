// devbox-manager: Bun shell recipe manager
// Copyright (C) 2026  Andrei
//
// SPDX-License-Identifier: MIT

import { createSignal, onCleanup } from 'solid-js'

export type Server = { id: number; name: string; host: string; port: number; username: string; secrets?: Record<string, string>; created_at: string; updated_at: string }
export type Recipe = { name: string; content: string; created_at: string; updated_at: string }
export type Run = { id: number; recipe: string; server_id?: number | null; status: 'running' | 'succeeded' | 'failed'; exit_code?: number | null; output: string; started_at: string; finished_at?: string | null }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, ...init })
  if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`)
  return response.status === 204 ? (undefined as T) : response.json()
}

// ---------- zustand-style vanilla store ----------

export type AppState = {
  servers: Server[]
  recipes: Recipe[]
  folders: string[]
  runs: Run[]
  loaded: boolean
  live: boolean
}

type Store<T extends object> = {
  getState: () => T
  setState: (patch: Partial<T> | ((s: T) => Partial<T>)) => void
  subscribe: (listener: () => void) => () => void
}

function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch
      state = { ...state, ...next }
      listeners.forEach(l => l())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

const appStore = createStore<AppState>({ servers: [], recipes: [], folders: [], runs: [], loaded: false, live: false })

// useAppSelector subscribes a component to one slice of the global state,
// mirroring zustand's selector hook. Identity-stable slices avoid rerenders.
export function useAppSelector<S>(selector: (s: AppState) => S): () => S {
  const [get, set] = createSignal(selector(appStore.getState()))
  onCleanup(appStore.subscribe(() => set(() => selector(appStore.getState()))))
  return get
}

// Runs keep their object identity while nothing observable changes, so Solid's
// keyed rendering never recreates dock rows (which used to steal focus).
const sameRunState = (a: Run, b: Run) =>
  a.recipe === b.recipe &&
  (a.server_id ?? null) === (b.server_id ?? null) &&
  a.status === b.status &&
  a.output === b.output &&
  a.exit_code === b.exit_code &&
  (a.finished_at ?? null) === (b.finished_at ?? null)

function reconcileRuns(current: Run[], incoming: Run[]): Run[] | null {
  let changed = current.length !== incoming.length
  const prevByID = new Map(current.map(r => [r.id, r]))
  const next = incoming.map(r => {
    const prev = prevByID.get(r.id)
    if (prev && sameRunState(prev, r)) return prev
    changed = true
    return r
  })
  return changed ? next : null
}

export const store = {
  loadAll: async () => {
    const [servers, recipes, folders, runs] = await Promise.all([api<Server[]>('/servers'), api<Recipe[]>('/recipes'), api<string[]>('/recipe-folders'), api<Run[]>('/runs')])
    appStore.setState({ servers, recipes, folders: folders ?? [], runs: runs ?? [], loaded: true })
  },
  createRecipeFolder: async (path: string) => {
    await api('/recipe-folders', { method: 'POST', body: JSON.stringify({ path }) })
  },
  refreshRuns: async () => {
    try {
      const runs = await api<Run[]>('/runs')
      const merged = reconcileRuns(appStore.getState().runs, runs ?? [])
      if (merged) appStore.setState({ runs: merged })
    } catch { /* transient — SSE and the next tick recover */ }
  },
  upsertRun: (run: Run) => {
    if (!run || typeof run.id !== 'number') return
    const current = appStore.getState().runs.find(r => r.id === run.id)
    if (current && sameRunState(current, run)) return
    appStore.setState(s => ({
      runs: s.runs.some(r => r.id === run.id) ? s.runs.map(r => (r.id === run.id ? run : r)) : [run, ...s.runs],
    }))
  },
  applyRunOutput: (id: number, output: string) => {
    const current = appStore.getState().runs.find(r => r.id === id)
    if (!current || current.output === output || current.status !== 'running') return
    appStore.setState(s => ({ runs: s.runs.map(r => (r.id === id ? { ...r, output } : r)) }))
  },
  setLive: (live: boolean) => {
    if (appStore.getState().live !== live) appStore.setState({ live })
  },
}

// ---------- Server-Sent Events ----------

let source: EventSource | null = null

// connectEvents opens the /api/events stream once per page load; EventSource
// reconnects automatically after network errors.
export function connectEvents() {
  if (source) return
  source = new EventSource('/api/events')
  source.onopen = () => store.setLive(true)
  source.onerror = () => store.setLive(false)
  const onRunEvent = (e: MessageEvent) => {
    try { store.upsertRun(JSON.parse(e.data)) } catch { /* ignore malformed frame */ }
  }
  source.addEventListener('run_started', onRunEvent as EventListener)
  source.addEventListener('run_finished', onRunEvent as EventListener)
  source.addEventListener('run_output', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { id: number; output: string }
      store.applyRunOutput(data.id, data.output)
    } catch { /* ignore malformed frame */ }
  })
}
