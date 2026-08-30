/* devbox-manager: Bun shell recipe manager
 * Copyright (C) 2026  Andrei
 *
 * SPDX-License-Identifier: MIT
 */

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { connectEvents, store, useAppSelector } from './store'
import type { Recipe, Run, Server } from './store'
import './styles.css'

const bunStarter = `import { $ } from "bun"

// Bun shell recipe — see https://bun.com/docs/runtime/shell
await $\`echo "Managed by Devbox Manager"\`
`

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, ...init })
  if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`)
  return response.status === 204 ? (undefined as T) : response.json()
}

function Icon(props: { d: string; size?: number }) {
  return (
    <svg width={props.size ?? 15} height={props.size ?? 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={props.d} />
    </svg>
  )
}
const icons = {
  play: 'M7 4.5v15l12-7.5z',
  pencil: 'M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z',
  trash: 'M3 6h18M8 6V4h8v2m1 0-1 14H8L7 6m4 4v6m2-6v6',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
  x: 'M6 6l12 12M18 6L6 18',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  chevron: 'm9 18 6-6-6-6',
  folder: 'M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2.5h6.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z',
  plus: 'M12 5v14M5 12h14',
}

const CONTEXTS_KEY = 'devbox.run-contexts'
const MAXRT_KEY = 'devbox.max-runtime'
const loadRunContexts = (): string[] => {
  const stored = localStorage.getItem(CONTEXTS_KEY)
  if (stored === null) return []
  try {
    const raw: unknown = JSON.parse(stored)
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch { return [] }
}
const loadMaxRuntime = (): number => {
  const v = Number(localStorage.getItem(MAXRT_KEY))
  return Number.isFinite(v) && v > 0 ? Math.min(86400, Math.floor(v)) : 0
}

// Split-pane geometry: rail width and executions-dock height, persisted in px.
const SIZES_KEY = 'devbox.panel-sizes'
type PanelSizes = { rail: number; dock: number }
const DEFAULT_SIZES: PanelSizes = { rail: 380, dock: 216 }
const RAIL_MIN = 264
const DOCK_MIN = 128
const railMax = () => Math.max(RAIL_MIN, window.innerWidth - 540)
const dockMax = () => Math.max(DOCK_MIN, window.innerHeight - 400)
const clampSize = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))
const loadPanelSizes = (): PanelSizes => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SIZES_KEY) ?? '{}')
    const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const rail = Number(rec.rail)
    const dock = Number(rec.dock)
    return {
      rail: Number.isFinite(rail) ? clampSize(rail, RAIL_MIN, railMax()) : DEFAULT_SIZES.rail,
      dock: Number.isFinite(dock) ? clampSize(dock, DOCK_MIN, dockMax()) : DEFAULT_SIZES.dock,
    }
  } catch { return { ...DEFAULT_SIZES } }
}

type RecipeTab = 'view' | 'edit'
type SecretEntry = { key: string; value: string }
type TreeEntry = { kind: 'folder'; path: string; name: string; level: number } | { kind: 'recipe'; recipe: Recipe; level: number }
const isLocalServer = (server: Pick<Server, 'name'>) => server.name.trim().toLowerCase() === 'local'

type Modal =
  | { kind: 'server-form'; draft: Partial<Server> }
  | { kind: 'run'; id: number }
  | { kind: 'confirm'; title: string; body: string; label: string; action: () => Promise<void> }

const RUNS_REFRESH_MS = 10_000

function buildTree(recipes: Recipe[], folders: string[], collapsed: Set<string>): TreeEntry[] {
  const paths = new Set(folders)
  for (const recipe of recipes) {
    const parts = recipe.name.split('/')
    for (let i = 1; i < parts.length; i += 1) paths.add(parts.slice(0, i).join('/'))
  }
  const result: TreeEntry[] = []
  const visit = (parent: string, level: number) => {
    const prefix = parent ? `${parent}/` : ''
    const directFolders = [...paths].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).sort()
    for (const path of directFolders) {
      result.push({ kind: 'folder', path, name: path.slice(prefix.length), level })
      if (!collapsed.has(path)) visit(path, level + 1)
    }
    recipes.filter(recipe => recipe.name.startsWith(prefix) && !recipe.name.slice(prefix.length).includes('/')).sort((a, b) => a.name.localeCompare(b.name)).forEach(recipe => result.push({ kind: 'recipe', recipe, level }))
  }
  visit('', 0)
  return result
}

function App() {
  const servers = useAppSelector(s => s.servers)
  const recipes = useAppSelector(s => s.recipes)
  const folders = useAppSelector(s => s.folders)
  const runs = useAppSelector(s => s.runs)
  const loaded = useAppSelector(s => s.loaded)
  const live = useAppSelector(s => s.live)
  const [railTab, setRailTab] = createSignal<'recipes' | 'servers'>('recipes')
  const [selectedRecipe, setSelectedRecipe] = createSignal<string | null>(null)
  const [selectedServerID, setSelectedServerID] = createSignal<number | null>(null)
  const [recipeTab, setRecipeTab] = createSignal<RecipeTab>('view')
  const [newRecipeDraft, setNewRecipeDraft] = createSignal(false)
  const [draftName, setDraftName] = createSignal('')
  const [collapsedFolders, setCollapsedFolders] = createSignal<string[]>((() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('devbox.collapsed-recipe-folders') ?? '[]')
      return Array.isArray(saved) ? saved.filter((path): path is string => typeof path === 'string') : []
    } catch { return [] }
  })())
  const [folderDraft, setFolderDraft] = createSignal(false)
  const [folderPath, setFolderPath] = createSignal('')
  const [folderError, setFolderError] = createSignal('')
  const [dropTarget, setDropTarget] = createSignal<string | null>(null)
  const [runContexts, setRunContexts] = createSignal<string[]>(loadRunContexts())
  const [maxRuntime, setMaxRuntime] = createSignal<number>(loadMaxRuntime())
  const [notice, setNotice] = createSignal('')
  const [error, setError] = createSignal('')
  const [modal, setModal] = createSignal<Modal | null>(null)

  const recipesByName = createMemo(() => new Map(recipes().map(r => [r.name, r])))
  const serversByID = createMemo(() => new Map(servers().map(s => [s.id, s])))
  const sortedRuns = createMemo(() => [...runs()].sort((a, b) => b.started_at.localeCompare(a.started_at)))
  const currentRecipe = createMemo(() => (selectedRecipe() ? recipesByName().get(selectedRecipe()!) ?? null : null))
  const treeEntries = createMemo(() => buildTree(recipes(), folders(), new Set(collapsedFolders())))
  const selectedServer = createMemo(() => servers().find(s => s.id === selectedServerID()) ?? null)

  // Persist checked execution contexts; drop ids that no longer exist in the inventory.
  createEffect(() => localStorage.setItem(CONTEXTS_KEY, JSON.stringify(runContexts())))
  createEffect(() => {
    if (!loaded()) return
    const known = new Set(servers().map(s => String(s.id)))
    const pruned = runContexts().filter(id => known.has(id))
    if (pruned.length !== runContexts().length) {
      setRunContexts(pruned)
    } else if (pruned.length === 0) {
      const local = servers().find(isLocalServer)
      if (local) setRunContexts([String(local.id)])
    }
  })
  const toggleRunContext = (id: string) =>
    setRunContexts(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
  // Persist the per-run time limit chosen on the View tab.
  const [panelSizes, setPanelSizes] = createSignal<PanelSizes>(loadPanelSizes())
  const [resizing, setResizing] = createSignal<'rail' | 'dock' | 'both' | null>(null)
  createEffect(() => localStorage.setItem(MAXRT_KEY, String(maxRuntime())))
  // Sizes are committed between gestures, not on every pointermove.
  createEffect(() => { if (!resizing()) localStorage.setItem(SIZES_KEY, JSON.stringify(panelSizes())) })
  createEffect(() => localStorage.setItem('devbox.collapsed-recipe-folders', JSON.stringify(collapsedFolders())))

  const startNewRecipe = (prefix = '') => {
    setDraftName(prefix)
    setSelectedRecipe(null)
    setSelectedServerID(null)
    setNewRecipeDraft(true)
    setRailTab('recipes')
    setRecipeTab('edit')
  }
  const selectRecipe = (name: string) => {
    setNewRecipeDraft(false)
    setSelectedServerID(null)
    setSelectedRecipe(name)
    setRecipeTab('view')
  }
  const openRecipeEdit = (name: string) => {
    setNewRecipeDraft(false)
    setSelectedServerID(null)
    setSelectedRecipe(name)
    setRailTab('recipes')
    setRecipeTab('edit')
  }
  const cancelRecipeEdit = () => {
    setNewRecipeDraft(false)
    setRecipeTab('view')
  }
  const toggleFolder = (path: string) => setCollapsedFolders(paths => paths.includes(path) ? paths.filter(p => p !== path) : [...paths, path])
  const validateFolder = (raw: string) => {
    const path = raw.trim().replace(/^\/+|\/+$/g, '')
    if (!path) return 'Enter a folder path.'
    if (path.split('/').some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment.startsWith('_'))) return 'Use slash-separated names starting with a letter or digit; underscore-prefixed segments are reserved.'
    return ''
  }
  const createFolder = async () => {
    const path = folderPath().trim().replace(/^\/+|\/+$/g, '')
    const problem = validateFolder(path)
    if (problem) { setFolderError(problem); return }
    try {
      await store.createRecipeFolder(path)
      setFolderPath(''); setFolderError(''); setFolderDraft(false)
      await reload(); message(`Folder “${path}” created.`)
    } catch (e) { setFolderError(e instanceof Error ? e.message : 'Could not create folder.') }
  }
  const moveRecipe = async (recipe: Recipe, folder: string) => {
    const base = recipe.name.slice(recipe.name.lastIndexOf('/') + 1)
    const name = folder ? `${folder}/${base}` : base
    if (name === recipe.name) return
    try {
      await api(`/recipes/${encodeURIComponent(recipe.name)}`, { method: 'PUT', body: JSON.stringify({ name, content: recipe.content }) })
      if (selectedRecipe() === recipe.name) setSelectedRecipe(name)
      await reload(); message(`Moved “${base}”.`)
    } catch (e) { fail(e) }
  }

  let noticeTimer: number | undefined
  const message = (text: string) => { setError(''); setNotice(text); window.clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => setNotice(''), 3500) }
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Something went wrong')

  const reload = async () => {
    try {
      await store.loadAll()
    } catch (e) { fail(e) }
  }
  onMount(() => {
    reload()
    connectEvents()
  })
  // Background refresh touches only the executions dock; servers and recipes
  // update through explicit user actions and run events arrive over SSE.
  const pollTimer = window.setInterval(() => { void store.refreshRuns() }, RUNS_REFRESH_MS)
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setModal(null) }
  window.addEventListener('keydown', onKey)

  // ---- split-pane resizing (drag, keyboard, double-click reset) ----
  const applyResize = (axis: 'rail' | 'dock' | 'both', dRail: number, dDock: number, base: PanelSizes = panelSizes()) =>
    setPanelSizes(() => ({
      rail: axis === 'dock' ? base.rail : clampSize(base.rail + dRail, RAIL_MIN, railMax()),
      dock: axis === 'rail' ? base.dock : clampSize(base.dock + dDock, DOCK_MIN, dockMax()),
    }))
  const beginResize = (axis: 'rail' | 'dock' | 'both') => (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    const base = panelSizes()
    setResizing(axis)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')
    document.body.dataset.resizeCursor = axis === 'rail' ? 'col' : axis === 'dock' ? 'row' : 'both'
    const onMove = (ev: PointerEvent) =>
      applyResize(axis, ev.clientX - start.x, start.y - ev.clientY, base)
    const stop = () => {
      setResizing(null)
      document.body.classList.remove('resizing')
      delete document.body.dataset.resizeCursor
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  const gutterKeys = (axis: 'rail' | 'dock' | 'both') => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16
    const dRail = axis === 'dock' ? 0 : e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0
    const dDock = axis === 'rail' ? 0 : e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0
    if (!dRail && !dDock) return
    e.preventDefault()
    applyResize(axis, dRail, dDock)
  }
  const resetGutter = (axis: 'rail' | 'dock' | 'both') => () => {
    const s = panelSizes()
    applyResize(axis, DEFAULT_SIZES.rail - s.rail, DEFAULT_SIZES.dock - s.dock)
  }
  const onWinResize = () => applyResize('both', 0, 0)
  window.addEventListener('resize', onWinResize)

  onCleanup(() => {
    window.clearInterval(pollTimer); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onWinResize)
  })

  async function saveServer(draft: Partial<Server>) {
    try {
      if (draft.id) await api(`/servers/${draft.id}`, { method: 'PUT', body: JSON.stringify(draft) })
      else await api('/servers', { method: 'POST', body: JSON.stringify({ ...draft, port: Number(draft.port) }) })
      setModal(null); await reload()
      if (draft.id) setSelectedServerID(draft.id)
      message(draft.id ? 'Server updated.' : 'Server added to inventory.')
    } catch (e) { fail(e) }
  }
  async function saveServerSecrets(server: Server, secrets: Record<string, string>) {
    try {
      await api(`/servers/${server.id}`, { method: 'PUT', body: JSON.stringify({ ...server, secrets }) })
      await reload()
      message('Server secrets saved.')
    } catch (e) { fail(e); throw e }
  }
  async function saveRecipe(draft: { name?: string; content: string }) {
    try {
      const selected = selectedRecipe()
      if (selected) {
        const original = recipesByName().get(selected)
        if (!original) throw new Error('Recipe no longer exists — reload.')
        const name = draft.name?.trim() || original.name
        await api(`/recipes/${encodeURIComponent(original.name)}`, { method: 'PUT', body: JSON.stringify({ name, content: draft.content }) })
        setSelectedRecipe(name)
      } else {
        const created = await api<Recipe>('/recipes', { method: 'POST', body: JSON.stringify({ name: draft.name ?? '', content: draft.content }) })
        setSelectedRecipe(created.name)
      }
      setNewRecipeDraft(false)
      await reload()
      setRecipeTab('view')
      message(selected ? 'Recipe updated.' : 'Recipe saved.')
    } catch (e) { fail(e) }
  }
  function confirmDelete(title: string, body: string, label: string, action: () => Promise<void>) {
    setModal({ kind: 'confirm', title, body, label, action })
  }
  async function removeServer(id: number) {
    confirmDelete('Delete server', `Remove ${serversByID().get(id)?.name ?? 'this server'} from inventory? Recipes referencing it stay untouched.`, 'Delete server', async () => {
      try { await api(`/servers/${id}`, { method: 'DELETE' }); setModal(null); if (selectedServerID() === id) setSelectedServerID(null); await reload(); message('Server deleted.') } catch (e) { fail(e) }
    })
  }
  async function removeRecipe(name: string) {
    confirmDelete('Delete recipe', `Delete “${recipesByName().get(name)?.name ?? name}”? Its execution history will remain in the dock's source data until purged separately.`, 'Delete recipe', async () => {
      try {
        await api(`/recipes/${encodeURIComponent(name)}`, { method: 'DELETE' })
        setModal(null)
        if (selectedRecipe() === name) { setSelectedRecipe(null); setRecipeTab('view') }
        await reload(); message('Recipe deleted.')
      } catch (e) { fail(e) }
    })
  }
  async function runRecipe(recipeName: string) {
    try {
      const known = new Set(servers().map(s => String(s.id)))
      const targets = runContexts().filter(id => known.has(id))
      if (targets.length === 0) throw new Error('Choose at least one execution context.')
      const queue = targets
      message(queue.length > 1 ? `${queue.length} runs started — watch the dock below.` : 'Run started — watch the dock below.')
      await Promise.all(queue.map(async id => {
        const body: Record<string, unknown> = { recipe: recipeName, server_id: Number(id) }
        if (maxRuntime() > 0) body.max_runtime = maxRuntime()
        // The POST resolves when the run finishes; live progress arrives over
        // the /api/events stream. Upsert guards against a missed SSE frame.
        try {
          store.upsertRun(await api<Run>('/runs', { method: 'POST', body: JSON.stringify(body) }))
        } catch (e) { fail(e) }
      }))
    } catch (e) { fail(e) }
  }
  async function copyOutput(text: string) {
    try { await navigator.clipboard.writeText(text); message('Output copied.') } catch { setError('Could not access the clipboard.') }
  }

  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const fmtFull = (iso: string) => new Date(iso).toLocaleString()
  const fmtDuration = (run: Run) => {
    if (!run.finished_at) return '…'
    const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
  }
  const runTarget = (run: Run) => (run.server_id ? serversByID().get(run.server_id)?.name ?? `Server #${run.server_id}` : 'Local runner')
  const firstLine = (text: string) => text.trim().split('\n').find(l => l.trim()) ?? ''

  const statusLabel: Record<Run['status'], string> = { running: 'Running', succeeded: 'OK', failed: 'Failed' }

  return (
    <div
      class="shell"
      classList={{ 'drag-rail': resizing() === 'rail', 'drag-dock': resizing() === 'dock', 'drag-both': resizing() === 'both' }}
      style={{ '--rail-w': `${Math.round(panelSizes().rail)}px`, '--dock-h': `${Math.round(panelSizes().dock)}px` }}
    >
      <header class="command">
        <div class="brand">
          <span class="brand-mark"><Icon d={icons.box} size={17} /></span>
          <h1>Devbox Manager</h1>
        </div>
        <div class="command-status">
          <span class="pill"><span class="pulse" /> File-backed</span>
          <button class="btn ghost sm" onClick={reload} title="Reload all data"><Icon d={icons.refresh} /> Refresh</button>
        </div>
      </header>

      <Show when={notice()}><div class="toast notice" role="status">{notice()}</div></Show>
      <Show when={error()}><div class="toast error" role="alert">{error()}</div></Show>

      <div class="workspace">
        <section class="panel rail" id="rail-panel" aria-label="Inventory and recipes">
          <div class="rail-head">
            <nav class="segmented" role="tablist">
              <button role="tab" aria-selected={railTab() === 'recipes'} classList={{ active: railTab() === 'recipes' }} onClick={() => setRailTab('recipes')}>Recipes <b>{recipes().length}</b></button>
              <button role="tab" aria-selected={railTab() === 'servers'} classList={{ active: railTab() === 'servers' }} onClick={() => setRailTab('servers')}>Servers <b>{servers().length}</b></button>
            </nav>
            <Show when={railTab() === 'recipes'} fallback={
              <button class="btn ghost sm" onClick={() => setModal({ kind: 'server-form', draft: { port: 22 } })}><Icon d={icons.pencil} /> New</button>
            }>
              <div class="recipe-create-actions"><button class="btn ghost sm" onClick={() => startNewRecipe()}><Icon d={icons.pencil} /> New</button><button class="btn ghost sm icon-only" title="New folder" onClick={() => { setFolderDraft(true); setFolderError('') }}><Icon d={icons.folder} /></button></div>
            </Show>
          </div>
          <div class="rail-list">
            <Show when={railTab() === 'recipes'} fallback={
              <For each={servers()} fallback={<p class="empty">No servers in inventory yet.<button class="btn ghost" onClick={() => setModal({ kind: 'server-form', draft: { port: 22 } })}>Add your first server</button></p>}>
                {item => (
                  <article classList={{ row: true, selected: selectedServerID() === item.id }} onClick={() => { setSelectedServerID(item.id); setRailTab('servers') }}>
                    <div class="row-main">
                      <strong>{item.name}</strong>
                      <small>{isLocalServer(item) ? 'This Debian host · native Bun' : `${item.username}@${item.host}:${item.port}`}</small>
                    </div>
                    <Show when={!isLocalServer(item)}><div class="row-actions">
                      <button class="chip" title="Edit server" onClick={e => { e.stopPropagation(); setModal({ kind: 'server-form', draft: item }) }}><Icon d={icons.pencil} /></button>
                      <button class="chip danger-chip" title="Delete server" onClick={e => { e.stopPropagation(); removeServer(item.id) }}><Icon d={icons.trash} /></button>
                    </div></Show>
                  </article>
                )}
              </For>
            }>
              <div classList={{ 'recipe-tree': true, 'root-drop-target': dropTarget() === '' }} onDragOver={e => { e.preventDefault(); setDropTarget((e.target as Element)?.closest?.('[data-drop-folder]')?.getAttribute('data-drop-folder') ?? '') }} onDragLeave={e => { if (e.target === e.currentTarget) setDropTarget(null) }} onDrop={e => { e.preventDefault(); const name = e.dataTransfer?.getData('text/plain'); const recipe = name ? recipesByName().get(name) : undefined; if (recipe) void moveRecipe(recipe, (e.target as Element)?.closest?.('[data-drop-folder]')?.getAttribute('data-drop-folder') ?? ''); setDropTarget(null) }}>
                <Show when={folderDraft()}>
                  <form class="folder-draft" onSubmit={e => { e.preventDefault(); void createFolder() }}>
                    <Icon d={icons.folder} /><input autofocus value={folderPath()} onInput={e => { setFolderPath(e.currentTarget.value); setFolderError('') }} placeholder="folder/path" aria-label="New folder path" />
                    <button class="chip" type="submit" title="Create folder"><Icon d={icons.check} /></button>
                    <button class="chip" type="button" title="Cancel" onClick={() => { setFolderDraft(false); setFolderError('') }}><Icon d={icons.x} /></button>
                    <Show when={folderError()}><small>{folderError()}</small></Show>
                  </form>
                </Show>
                <For each={treeEntries()} fallback={<p class="empty">No recipes yet.<button class="btn ghost" onClick={() => startNewRecipe()}>Write your first Bun shell recipe</button></p>}>
                  {entry => entry.kind === 'folder' ? (
                    <div classList={{ 'tree-folder': true, 'drop-target': dropTarget() === entry.path }} data-drop-folder={entry.path} style={{ 'padding-left': `${5 + entry.level * 17}px` }}>
                      <button class="folder-toggle" aria-expanded={!collapsedFolders().includes(entry.path)} onClick={() => toggleFolder(entry.path)}><span classList={{ chevron: true, collapsed: collapsedFolders().includes(entry.path) }}><Icon d={icons.chevron} size={14} /></span><Icon d={icons.folder} size={15} /><strong>{entry.name}</strong></button>
                      <button class="chip folder-add" title={`New recipe in ${entry.path}`} onClick={() => startNewRecipe(`${entry.path}/`)}><Icon d={icons.plus} /></button>
                    </div>
                  ) : (
                    <article draggable="true" data-drop-folder={entry.recipe.name.includes('/') ? entry.recipe.name.slice(0, entry.recipe.name.lastIndexOf('/')) : ''} classList={{ row: true, 'tree-recipe': true, selected: !newRecipeDraft() && selectedRecipe() === entry.recipe.name }} style={{ 'padding-left': `${12 + entry.level * 17}px` }}  onDragStart={e => { e.dataTransfer?.setData('text/plain', entry.recipe.name); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => setDropTarget(null)} onClick={() => selectRecipe(entry.recipe.name)}>
                      <div class="row-main"><strong>{entry.recipe.name.slice(entry.recipe.name.lastIndexOf('/') + 1)}</strong><small>updated {fmtFull(entry.recipe.updated_at)}</small></div>
                      <div class="row-actions"><button class="chip run-chip" title={`Run ${entry.recipe.name}`} onClick={e => { e.stopPropagation(); runRecipe(entry.recipe.name) }}><Icon d={icons.play} /></button><button class="chip" title="Edit recipe" onClick={e => { e.stopPropagation(); openRecipeEdit(entry.recipe.name) }}><Icon d={icons.pencil} /></button><button class="chip danger-chip" title="Delete recipe" onClick={e => { e.stopPropagation(); removeRecipe(entry.recipe.name) }}><Icon d={icons.trash} /></button></div>
                    </article>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </section>

        <div
          class="gutter gutter-v" role="separator" tabIndex={0} aria-orientation="vertical"
          aria-label="Resize recipe list and detail panels" aria-controls="rail-panel detail-panel"
          aria-valuenow={Math.round(panelSizes().rail)} aria-valuemin={RAIL_MIN} aria-valuemax={railMax()}
          title="Drag or use arrow keys to resize — double-click to reset"
          onPointerDown={beginResize('rail')} onKeyDown={gutterKeys('rail')} onDblClick={resetGutter('rail')}
        />
        <section class="panel detail" id="detail-panel" aria-label="Selection detail">
          <Show when={railTab() === 'recipes'} fallback={
            <Show when={selectedServer()} fallback={<DetailHint kind="server" loaded={loaded()} onNew={() => setModal({ kind: 'server-form', draft: { port: 22 } })} />}>
              {srv => (
                <>
                  <div class="detail-head">
                    <h2>{srv().name}</h2>
                    <span class="tag">{isLocalServer(srv()) ? 'This machine' : 'SSH inventory'}</span>
                  </div>
                  <p class="conn-string mono">{isLocalServer(srv()) ? 'Native Bun on this Debian host' : `${srv().username}@${srv().host}:${srv().port}`}</p>
                  <dl class="meta">
                    <Show when={!isLocalServer(srv())}>
                      <div><dt>Port</dt><dd class="mono">{srv().port}</dd></div>
                      <div><dt>User</dt><dd>{srv().username}</dd></div>
                    </Show>
                    <Show when={isLocalServer(srv())}><div><dt>Runtime</dt><dd>Direct Bun</dd></div></Show>
                    <div><dt>Added</dt><dd>{fmtFull(srv().created_at)}</dd></div>
                    <div><dt>Updated</dt><dd>{fmtFull(srv().updated_at)}</dd></div>
                  </dl>
                  <p class="scope-note">{isLocalServer(srv()) ? <>Recipes run directly with <code class="mono">bun</code> on this Debian host. Add environment variables below; they are injected into every run here.</> : <>Checked in a recipe's execution context, the recipe is streamed over SSH and run in a <code class="mono">nix-shell -p bun</code> on this server.</>}</p>
                  <Show when={!isLocalServer(srv())}><div class="detail-actions">
                    <button class="btn ghost" onClick={() => setModal({ kind: 'server-form', draft: srv() })}><Icon d={icons.pencil} /> Edit</button>
                    <button class="btn ghost danger" onClick={() => removeServer(srv().id)}><Icon d={icons.trash} /> Delete</button>
                  </div></Show>
                  <ServerSecrets server={srv()} onSave={saveServerSecrets} />
                </>
              )}
            </Show>
          }>
            <Show when={newRecipeDraft()} fallback={
              <Show when={currentRecipe()} keyed fallback={<DetailHint kind="recipe" loaded={loaded()} onNew={startNewRecipe} />}>
                {rec => (
                  <RecipeDetail
                    recipe={rec}
                    tab={recipeTab()}
                    onTab={setRecipeTab}
                    onSave={saveRecipe}
                    onRun={() => runRecipe(rec.name)}
                    onDelete={() => removeRecipe(rec.name)}
                    onCancelEdit={cancelRecipeEdit}
                    servers={servers()}
                    runContexts={runContexts()}
                    onToggleContext={toggleRunContext}
                    maxRuntime={maxRuntime()}
                    onMaxRuntime={setMaxRuntime}
                  />
                )}
              </Show>
            }>
              <RecipeDetail
                recipe={null}
                initialName={draftName()}
                tab={recipeTab()}
                onTab={setRecipeTab}
                onSave={saveRecipe}
                onRun={null}
                onDelete={null}
                onCancelEdit={cancelRecipeEdit}
                servers={servers()}
                runContexts={runContexts()}
                onToggleContext={toggleRunContext}
                maxRuntime={maxRuntime()}
                onMaxRuntime={setMaxRuntime}
              />
            </Show>
          </Show>
        </section>
      </div>

      <div
        class="gutter gutter-h" role="separator" tabIndex={0} aria-orientation="horizontal"
        aria-label="Resize executions dock" aria-controls="exec-dock"
        aria-valuenow={Math.round(panelSizes().dock)} aria-valuemin={DOCK_MIN} aria-valuemax={dockMax()}
        title="Drag or use arrow keys to resize — double-click to reset"
        onPointerDown={beginResize('dock')} onKeyDown={gutterKeys('dock')} onDblClick={resetGutter('dock')}
      />
      <div
        class="gutter gutter-c" role="separator" tabIndex={0}
        aria-label="Resize all panels" aria-controls="rail-panel detail-panel exec-dock"
        aria-valuetext={`${Math.round(panelSizes().rail)}px wide, ${Math.round(panelSizes().dock)}px tall`}
        title="Drag to resize both — double-click to reset"
        onPointerDown={beginResize('both')} onKeyDown={gutterKeys('both')} onDblClick={resetGutter('both')}
      />

      <footer class="dock panel" id="exec-dock" aria-label="Recent executions">
        <div class="dock-head">
          <h2><Icon d={icons.terminal} /> Executions</h2>
          <span classList={{ 'dock-hint': true, mono: true, live: live() }}>
            <Show when={live()} fallback="reconnecting…">live · refreshed every 10s</Show>
          </span>
        </div>
        <div class="dock-list">
          <For each={sortedRuns()} fallback={<p class="empty slim">{loaded() ? 'No runs yet — press Run on any recipe.' : 'Loading executions…'}</p>}>
            {run => (
              <button class="dock-row" onClick={() => setModal({ kind: 'run', id: run.id })}>
                <span class={`status s-${run.status}`}>{statusLabel[run.status]}</span>
                <span class="dock-name">{recipesByName().get(run.recipe)?.name ?? run.recipe}</span>
                <span class="dock-target">{runTarget(run)}</span>
                <span class="dock-time mono">{fmtTime(run.started_at)}</span>
                <span class="dock-dur mono">{fmtDuration(run)}</span>
                <span class="dock-preview mono">{firstLine(run.output) || (run.status === 'running' ? 'running…' : 'no output') }</span>
              </button>
            )}
          </For>
        </div>
      </footer>

      <Show when={modal()}>
        {m => (
          <div class="overlay" onClick={e => { if (e.target === e.currentTarget) setModal(null) }}>
            <ModalSwitch modal={m()} onCancel={() => setModal(null)} saveServer={saveServer} onCopied={copyOutput} fmtFull={fmtFull} fmtDuration={fmtDuration} runTarget={runTarget} />
          </div>
        )}
      </Show>
    </div>
  )
}

// ---------- recipe detail: View / Edit ----------

function RecipeDetail(props: {
  recipe: Recipe | null
  initialName?: string
  tab: RecipeTab
  onTab: (t: RecipeTab) => void
  onSave: (d: { name?: string; content: string }) => Promise<void>
  onRun: (() => void) | null
  onDelete: (() => void) | null
  onCancelEdit: () => void
  servers: Server[]
  runContexts: string[]
  onToggleContext: (id: string) => void
  maxRuntime: number
  onMaxRuntime: (v: number) => void
}) {
  return (
    <>
      <div class="detail-head">
        <h2>{props.recipe?.name ?? 'New recipe'}</h2>
        <a class="tag" href="https://bun.com/docs/runtime/shell" target="_blank" rel="noreferrer">Bun shell</a>
      </div>
      <nav class="segmented detail-tabs" role="tablist" aria-label="Recipe editing mode">
        <button role="tab" aria-selected={props.tab === 'view'} classList={{ active: props.tab === 'view' }} onClick={() => props.onTab('view')}><Icon d={icons.eye} size={13} /> View</button>
        <button role="tab" aria-selected={props.tab === 'edit'} classList={{ active: props.tab === 'edit' }} onClick={() => props.onTab('edit')}><Icon d={icons.pencil} size={13} /> Edit</button>
      </nav>
      <Show when={props.tab === 'view' && props.recipe}>
        <RecipeView
          recipe={props.recipe as Recipe}
          onRun={props.onRun}
          onDelete={props.onDelete}
          servers={props.servers}
          runContexts={props.runContexts}
          onToggleContext={props.onToggleContext}
          maxRuntime={props.maxRuntime}
          onMaxRuntime={props.onMaxRuntime}
        />
      </Show>
      <Show when={props.tab === 'edit'}>
        <RecipeEditor recipe={props.recipe} initialName={props.initialName} onSave={props.onSave} onCancel={props.onCancelEdit} />
      </Show>
    </>
  )
}

function RecipeView(props: {
  recipe: Recipe
  onRun: (() => void) | null
  onDelete: (() => void) | null
  servers: Server[]
  runContexts: string[]
  onToggleContext: (id: string) => void
  maxRuntime: number
  onMaxRuntime: (v: number) => void
}) {
  return (
    <>
      <pre class="recipe-source mono" tabIndex={0}>{props.recipe.content}</pre>
      <div class="run-target">Execution context
        <ContextMultiSelect servers={props.servers} selected={props.runContexts} onToggle={props.onToggleContext} />
      </div>
      <label class="run-target" for="max-runtime-input">Max runtime per run (seconds)
        <input
          id="max-runtime-input"
          class="run-limit"
          type="number"
          min="0"
          max="86400"
          step="1"
          value={props.maxRuntime}
          onInput={e => {
            const v = Math.floor(Number(e.currentTarget.value) || 0)
            props.onMaxRuntime(Math.max(0, Math.min(86400, v)))
          }}
        />
      </label>
      <p class="scope-note">The <code class="mono">local</code> server runs directly with Bun on this Debian host. Other checked servers run over SSH in <code class="mono">nix-shell -p bun</code>. Use <code class="mono">0</code> for no time limit.</p>
      <div class="detail-actions">
        <Show when={props.onRun}>
          <button class="btn primary" onClick={() => props.onRun!()}><Icon d={icons.play} /> Run now</button>
        </Show>
        <Show when={props.onDelete}>
          <button class="btn ghost danger" onClick={() => props.onDelete!()}><Icon d={icons.trash} /> Delete</button>
        </Show>
      </div>
    </>
  )
}

function RecipeEditor(props: {
  recipe: Recipe | null
  initialName?: string
  onSave: (d: { name?: string; content: string }) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = createSignal(props.recipe?.name ?? props.initialName ?? '')
  const [content, setContent] = createSignal(props.recipe?.content ?? bunStarter)
  const [busy, setBusy] = createSignal(false)
  const submit = () => {
    if (busy()) return
    setBusy(true)
    // Editing an existing recipe sends the (possibly renamed) path so the
    // backend can move the file; creating sends only the new name.
    props.onSave({ name: name().trim(), content: content() }).finally(() => setBusy(false))
  }
  return (
    <form class="recipe-form" onSubmit={e => { e.preventDefault(); submit() }}>
      <label>Name <Show when={props.recipe}><span class="hint">— rename or change the path to move the recipe</span></Show>
        <input required value={name()} onInput={e => setName(e.currentTarget.value)} placeholder="Install nginx" />
      </label>
      <label>Recipe content — Bun shell script
        <textarea class="mono" required spellcheck={false} rows={16} value={content()} onInput={e => setContent(e.currentTarget.value)} />
      </label>
      <div class="detail-actions">
        <button type="submit" class="btn primary" disabled={busy()}>{busy() ? 'Saving…' : props.recipe ? 'Save changes' : 'Save recipe'}</button>
        <button type="button" class="btn ghost" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  )
}


// ---------- modals ----------

function ModalSwitch(props: {
  modal: Modal
  onCancel: () => void
  saveServer: (d: Partial<Server>) => Promise<void>
  onCopied: (t: string) => void
  fmtFull: (iso: string) => string
  fmtDuration: (r: Run) => string
  runTarget: (r: Run) => string
}) {
  return (
    <>
      <Show when={props.modal.kind === 'server-form'}>
        <ServerForm draft={(props.modal as Extract<Modal, { kind: 'server-form' }>).draft} onSave={props.saveServer} onCancel={props.onCancel} />
      </Show>
      <Show when={props.modal.kind === 'run'}>
        <RunDetail id={(props.modal as Extract<Modal, { kind: 'run' }>).id} onClose={props.onCancel} onCopy={props.onCopied} fmtFull={props.fmtFull} fmtDuration={props.fmtDuration} runTarget={props.runTarget} />
      </Show>
      <Show when={props.modal.kind === 'confirm'}>
        <ConfirmDialog spec={props.modal as Extract<Modal, { kind: 'confirm' }>} onCancel={props.onCancel} />
      </Show>
    </>
  )
}

function ModalFrame(props: { title: string; tag?: string; onClose: () => void; children: any }) {
  return (
    <div class="dialog" role="dialog" aria-modal="true" aria-label={props.title}>
      <div class="dialog-head">
        <h2>{props.title}</h2>
        <div class="dialog-head-side">
          <Show when={props.tag}><span class="tag">{props.tag}</span></Show>
          <button class="chip" title="Close" onClick={props.onClose}><Icon d={icons.x} /></button>
        </div>
      </div>
      {props.children}
    </div>
  )
}

function ServerForm(props: { draft: Partial<Server>; onSave: (d: Partial<Server>) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = createSignal<Partial<Server>>(props.draft)
  const local = () => (draft().name ?? '').trim().toLowerCase() === 'local'
  return (
    <ModalFrame title={draft().id ? 'Edit server' : 'New server'} tag={local() ? 'This machine' : 'SSH inventory'} onClose={props.onCancel}>
      <form onSubmit={e => { e.preventDefault(); props.onSave(draft()) }}>
        <label>Name<input required value={draft().name ?? ''} onInput={e => { const name = e.currentTarget.value; setDraft(name.trim().toLowerCase() === 'local' ? { ...draft(), name, host: '', port: 0, username: '' } : { ...draft(), name }) }} placeholder="Production Web 01" /></label>
        <label>IP or hostname<input required={!local()} readOnly={local()} value={local() ? '' : draft().host ?? ''} onInput={e => setDraft({ ...draft(), host: e.currentTarget.value })} placeholder={local() ? 'Not used on this machine' : 'web-01.example.internal'} /></label>
        <div class="twocol">
          <label>Port<input required={!local()} readOnly={local()} type="number" min="1" max="65535" value={local() ? '' : draft().port ?? 22} onInput={e => setDraft({ ...draft(), port: Number(e.currentTarget.value) })} placeholder={local() ? 'Not used' : undefined} /></label>
          <label>Username<input required={!local()} readOnly={local()} value={local() ? '' : draft().username ?? ''} onInput={e => setDraft({ ...draft(), username: e.currentTarget.value })} placeholder={local() ? 'Not used on this machine' : 'deploy'} /></label>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn ghost" onClick={props.onCancel}>Cancel</button>
          <button type="submit" class="btn primary">{draft().id ? 'Save changes' : 'Add server'}</button>
        </div>
      </form>
    </ModalFrame>
  )
}

function ServerSecrets(props: { server: Server; onSave: (server: Server, secrets: Record<string, string>) => Promise<void> }) {
  const fromServer = () => Object.entries(props.server.secrets ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value }))
  const [entries, setEntries] = createSignal<SecretEntry[]>(fromServer())
  const [newEntry, setNewEntry] = createSignal<SecretEntry>({ key: '', value: '' })
  const [saving, setSaving] = createSignal(false)
  createEffect(() => {
    props.server.id
    setEntries(fromServer())
    setNewEntry({ key: '', value: '' })
  })
  const currentSecrets = () => Object.fromEntries(entries().filter(entry => entry.key.trim()).map(entry => [entry.key.trim(), entry.value]))
  const savedSecrets = () => JSON.stringify(Object.fromEntries(fromServer().map(entry => [entry.key, entry.value])))
  const dirty = () => JSON.stringify(currentSecrets()) !== savedSecrets()
  const updateEntry = (index: number, patch: Partial<SecretEntry>) => setEntries(items => items.map((item, i) => i === index ? { ...item, ...patch } : item))
  const appendIfReady = (patch: Partial<SecretEntry>) => {
    const next = { ...newEntry(), ...patch }
    setNewEntry(next)
    if (next.key.trim() && next.value) {
      setEntries(items => [...items, { key: next.key.trim(), value: next.value }])
      setNewEntry({ key: '', value: '' })
    }
  }
  const save = async () => {
    setSaving(true)
    try { await props.onSave(props.server, currentSecrets()) } finally { setSaving(false) }
  }
  return (
    <section class="secrets" aria-label="Server secrets">
      <div class="secrets-head">
        <div><h3>Secrets</h3><p>Injected into remote Bun runs as environment variables.</p></div>
        <span class="tag">{entries().length} saved</span>
      </div>
      <div class="secret-table" role="table" aria-label="Server environment variables">
        <div class="secret-row secret-labels" role="row"><span role="columnheader">Env key</span><span role="columnheader">Env value</span><span /></div>
        <For each={entries()}>{(entry, index) => (
          <div class="secret-row" role="row">
            <input class="mono" aria-label="Environment key" value={entry.key} onInput={e => updateEntry(index(), { key: e.currentTarget.value })} />
            <input class="mono" aria-label={`Value for ${entry.key || 'environment key'}`} type="password" value={entry.value} onInput={e => updateEntry(index(), { value: e.currentTarget.value })} />
            <button class="chip danger-chip" title={`Remove ${entry.key}`} onClick={() => setEntries(items => items.filter((_, i) => i !== index()))}><Icon d={icons.trash} /></button>
          </div>
        )}</For>
        <div class="secret-row secret-new" role="row">
          <input class="mono" aria-label="New environment key" placeholder="Env key" value={newEntry().key} onInput={e => appendIfReady({ key: e.currentTarget.value })} />
          <input class="mono" aria-label="New environment value" placeholder="Env value" type="password" value={newEntry().value} onInput={e => appendIfReady({ value: e.currentTarget.value })} />
          <span />
        </div>
      </div>
      <p class="scope-note">In recipes, use <code class="mono">process.env.MY_SECRET</code> or <code class="mono">{'$.env({ MY_SECRET: process.env.MY_SECRET })'}</code> before a command.</p>
      <button class="btn primary" disabled={!dirty() || saving()} onClick={save}>{saving() ? 'Saving...' : 'Save secrets'}</button>
    </section>
  )
}

function ContextMultiSelect(props: { servers: Server[]; selected: string[]; onToggle: (id: string) => void }) {
  const Option = (optProps: { id: string; title: string; sub: string }) => {
    const checked = () => props.selected.includes(optProps.id)
    return (
      <button type="button" role="checkbox" aria-checked={checked()} title={`${optProps.title} — ${optProps.sub}`} classList={{ 'ms-option': true, checked: checked() }} onClick={() => props.onToggle(optProps.id)}>
        <span class="ms-box"><Show when={checked()}><Icon d={icons.check} size={12} /></Show></span>
        <strong>{optProps.title}</strong>
        <small class="mono">{optProps.sub}</small>
      </button>
    )
  }
  return (
    <div class="ms-list" role="group" aria-label="Execution context">
      <For each={props.servers}>{s => <Option id={String(s.id)} title={s.name} sub={isLocalServer(s) ? 'Native Bun on this Debian host' : `${s.username}@${s.host}:${s.port}`} />}</For>
    </div>
  )
}

function RunDetail(props: { id: number; onClose: () => void; onCopy: (t: string) => void; fmtFull: (iso: string) => string; fmtDuration: (r: Run) => string; runTarget: (r: Run) => string }) {
  // The run is read from the global store so streamed output and the final
  // status land in the open dialog without any polling or re-render churn.
  const run = useAppSelector(s => s.runs.find(r => r.id === props.id))
  const statusLabel: Record<string, string> = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed' }
  return (
    <Show when={run()} keyed>
      {r => (
        <ModalFrame title="Execution detail" onClose={props.onClose}>
          <dl class="meta run-meta">
            <div><dt>Status</dt><dd><span class={`status s-${r.status}`}>{statusLabel[r.status]}</span></dd></div>
            <div><dt>Exit code</dt><dd class="mono">{r.exit_code ?? (r.status === 'running' ? '—' : '')}</dd></div>
            <div><dt>Started</dt><dd>{props.fmtFull(r.started_at)}</dd></div>
            <div><dt>Finished</dt><dd>{r.finished_at ? props.fmtFull(r.finished_at) : '—'}</dd></div>
            <div><dt>Duration</dt><dd class="mono">{props.fmtDuration(r)}</dd></div>
            <div><dt>Target</dt><dd>{props.runTarget(r)}</dd></div>
          </dl>
          <pre class="output mono">{r.output || (r.status === 'running' ? 'bun is running — output streams here live.' : '(no output)')}</pre>
          <div class="dialog-actions">
            <Show when={r.output}><button class="btn ghost" onClick={() => props.onCopy(r.output)}><Icon d={icons.copy} /> Copy output</button></Show>
            <button class="btn primary" onClick={props.onClose}>Close</button>
          </div>
        </ModalFrame>
      )}
    </Show>
  )
}

function ConfirmDialog(props: { spec: Extract<Modal, { kind: 'confirm' }>; onCancel: () => void }) {
  const [busy, setBusy] = createSignal(false)
  return (
    <ModalFrame title={props.spec.title} onClose={props.onCancel}>
      <p class="confirm-body">{props.spec.body}</p>
      <div class="dialog-actions">
        <button class="btn ghost" onClick={props.onCancel} disabled={busy()}>Cancel</button>
        <button class="btn primary danger-fill" disabled={busy()} onClick={() => { setBusy(true); props.spec.action() }}>{busy() ? 'Working…' : props.spec.label}</button>
      </div>
    </ModalFrame>
  )
}

function DetailHint(props: { kind: 'recipe' | 'server'; loaded: boolean; onNew: () => void }) {
  const copy = props.kind === 'recipe'
    ? { title: 'Nothing selected', body: 'Pick a recipe on the left to inspect its Bun shell source and run it.' }
    : { title: 'Nothing selected', body: 'Pick a server to see its connection details and usage as run context.' }
  return (
    <div class="hint">
      <Show when={props.loaded} fallback={<p class="empty slim">Loading…</p>}>
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        <button class="btn ghost" onClick={props.onNew}>Or create a new {props.kind}</button>
      </Show>
    </div>
  )
}

render(() => <App />, document.getElementById('root')!)
