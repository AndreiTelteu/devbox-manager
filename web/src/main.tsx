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
}

const LOCAL_CONTEXT = 'local'
const CONTEXTS_KEY = 'devbox.run-contexts'
const MAXRT_KEY = 'devbox.max-runtime'
const loadRunContexts = (): string[] => {
  const stored = localStorage.getItem(CONTEXTS_KEY)
  if (stored === null) return [LOCAL_CONTEXT]
  try {
    const raw: unknown = JSON.parse(stored)
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [LOCAL_CONTEXT]
  } catch { return [LOCAL_CONTEXT] }
}
const loadMaxRuntime = (): number => {
  const v = Number(localStorage.getItem(MAXRT_KEY))
  return Number.isFinite(v) && v > 0 ? Math.min(86400, Math.floor(v)) : 0
}

type RecipeTab = 'view' | 'edit'

type Modal =
  | { kind: 'server-form'; draft: Partial<Server> }
  | { kind: 'run'; id: number }
  | { kind: 'confirm'; title: string; body: string; label: string; action: () => Promise<void> }

const RUNS_REFRESH_MS = 10_000

function App() {
  const servers = useAppSelector(s => s.servers)
  const recipes = useAppSelector(s => s.recipes)
  const runs = useAppSelector(s => s.runs)
  const loaded = useAppSelector(s => s.loaded)
  const live = useAppSelector(s => s.live)
  const [railTab, setRailTab] = createSignal<'recipes' | 'servers'>('recipes')
  const [selectedRecipeID, setSelectedRecipeID] = createSignal<number | null>(null)
  const [selectedServerID, setSelectedServerID] = createSignal<number | null>(null)
  const [recipeTab, setRecipeTab] = createSignal<RecipeTab>('view')
  const [newRecipeDraft, setNewRecipeDraft] = createSignal(false)
  const [runContexts, setRunContexts] = createSignal<string[]>(loadRunContexts())
  const [maxRuntime, setMaxRuntime] = createSignal<number>(loadMaxRuntime())
  const [notice, setNotice] = createSignal('')
  const [error, setError] = createSignal('')
  const [modal, setModal] = createSignal<Modal | null>(null)

  const recipesByID = createMemo(() => new Map(recipes().map(r => [r.id, r])))
  const serversByID = createMemo(() => new Map(servers().map(s => [s.id, s])))
  const sortedRuns = createMemo(() => [...runs()].sort((a, b) => b.started_at.localeCompare(a.started_at)))
  const selectedRecipe = createMemo(() => recipes().find(r => r.id === selectedRecipeID()) ?? null)
  const selectedServer = createMemo(() => servers().find(s => s.id === selectedServerID()) ?? null)

  // Persist checked execution contexts; drop ids that no longer exist in the inventory.
  createEffect(() => localStorage.setItem(CONTEXTS_KEY, JSON.stringify(runContexts())))
  createEffect(() => {
    if (!loaded()) return
    const known = new Set([LOCAL_CONTEXT, ...servers().map(s => String(s.id))])
    const pruned = runContexts().filter(id => known.has(id))
    if (pruned.length !== runContexts().length) setRunContexts(pruned)
  })
  const toggleRunContext = (id: string) =>
    setRunContexts(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
  // Persist the per-run time limit chosen on the View tab.
  createEffect(() => localStorage.setItem(MAXRT_KEY, String(maxRuntime())))

  const startNewRecipe = () => {
    setSelectedRecipeID(null)
    setSelectedServerID(null)
    setNewRecipeDraft(true)
    setRailTab('recipes')
    setRecipeTab('edit')
  }
  const selectRecipe = (id: number) => {
    setNewRecipeDraft(false)
    setSelectedServerID(null)
    setSelectedRecipeID(id)
    setRecipeTab('view')
  }
  const openRecipeEdit = (id: number) => {
    setNewRecipeDraft(false)
    setSelectedServerID(null)
    setSelectedRecipeID(id)
    setRailTab('recipes')
    setRecipeTab('edit')
  }
  const cancelRecipeEdit = () => {
    setNewRecipeDraft(false)
    setRecipeTab('view')
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
  onCleanup(() => { window.clearInterval(pollTimer); window.removeEventListener('keydown', onKey) })

  async function saveServer(draft: Partial<Server>) {
    try {
      if (draft.id) await api(`/servers/${draft.id}`, { method: 'PUT', body: JSON.stringify(draft) })
      else await api('/servers', { method: 'POST', body: JSON.stringify({ ...draft, port: Number(draft.port) }) })
      setModal(null); await reload()
      if (draft.id) setSelectedServerID(draft.id)
      message(draft.id ? 'Server updated.' : 'Server added to inventory.')
    } catch (e) { fail(e) }
  }
  async function saveRecipe(draft: { id?: number; name: string; content: string }) {
    try {
      if (draft.id) {
        await api(`/recipes/${draft.id}`, { method: 'PUT', body: JSON.stringify({ name: draft.name, content: draft.content }) })
        setSelectedRecipeID(draft.id)
      } else {
        const created = await api<Recipe>('/recipes', { method: 'POST', body: JSON.stringify({ name: draft.name, content: draft.content }) })
        setSelectedRecipeID(created.id)
      }
      setNewRecipeDraft(false)
      await reload()
      setRecipeTab('view')
      message(draft.id ? 'Recipe updated.' : 'Recipe saved.')
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
  async function removeRecipe(id: number) {
    confirmDelete('Delete recipe', `Delete “${recipesByID().get(id)?.name ?? 'this recipe'}”? Its execution history will remain in the dock's source data until purged separately.`, 'Delete recipe', async () => {
      try {
        await api(`/recipes/${id}`, { method: 'DELETE' })
        setModal(null)
        if (selectedRecipeID() === id) { setSelectedRecipeID(null); setRecipeTab('view') }
        await reload(); message('Recipe deleted.')
      } catch (e) { fail(e) }
    })
  }
  async function runRecipe(recipeID: number) {
    try {
      const known = new Set([LOCAL_CONTEXT, ...servers().map(s => String(s.id))])
      const targets = runContexts().filter(id => known.has(id))
      const queue = targets.length ? targets : [LOCAL_CONTEXT]
      message(queue.length > 1 ? `${queue.length} runs started — watch the dock below.` : 'Run started — watch the dock below.')
      await Promise.all(queue.map(async id => {
        const body: Record<string, number> = {}
        if (id !== LOCAL_CONTEXT) body.server_id = Number(id)
        if (maxRuntime() > 0) body.max_runtime = maxRuntime()
        // The POST resolves when the run finishes; live progress arrives over
        // the /api/events stream. Upsert guards against a missed SSE frame.
        try {
          store.upsertRun(await api<Run>(`/recipes/${recipeID}/run`, { method: 'POST', body: JSON.stringify(body) }))
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
    <div class="shell">
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
        <section class="panel rail" aria-label="Inventory and recipes">
          <div class="rail-head">
            <nav class="segmented" role="tablist">
              <button role="tab" aria-selected={railTab() === 'recipes'} classList={{ active: railTab() === 'recipes' }} onClick={() => setRailTab('recipes')}>Recipes <b>{recipes().length}</b></button>
              <button role="tab" aria-selected={railTab() === 'servers'} classList={{ active: railTab() === 'servers' }} onClick={() => setRailTab('servers')}>Servers <b>{servers().length}</b></button>
            </nav>
            <Show when={railTab() === 'recipes'} fallback={
              <button class="btn ghost sm" onClick={() => setModal({ kind: 'server-form', draft: { port: 22 } })}><Icon d={icons.pencil} /> New</button>
            }>
              <button class="btn ghost sm" onClick={startNewRecipe}><Icon d={icons.pencil} /> New</button>
            </Show>
          </div>
          <div class="rail-list">
            <Show when={railTab() === 'recipes'} fallback={
              <For each={servers()} fallback={<p class="empty">No servers in inventory yet.<button class="btn ghost" onClick={() => setModal({ kind: 'server-form', draft: { port: 22 } })}>Add your first server</button></p>}>
                {item => (
                  <article classList={{ row: true, selected: selectedServerID() === item.id }} onClick={() => { setSelectedServerID(item.id); setRailTab('servers') }}>
                    <div class="row-main">
                      <strong>{item.name}</strong>
                      <small>{item.username}@{item.host}:{item.port}</small>
                    </div>
                    <div class="row-actions">
                      <button class="chip" title="Edit server" onClick={e => { e.stopPropagation(); setModal({ kind: 'server-form', draft: item }) }}><Icon d={icons.pencil} /></button>
                      <button class="chip danger-chip" title="Delete server" onClick={e => { e.stopPropagation(); removeServer(item.id) }}><Icon d={icons.trash} /></button>
                    </div>
                  </article>
                )}
              </For>
            }>
              <For each={recipes()} fallback={<p class="empty">No recipes yet.<button class="btn ghost" onClick={startNewRecipe}>Write your first Bun shell recipe</button></p>}>
                {item => (
                  <article classList={{ row: true, selected: !newRecipeDraft() && selectedRecipeID() === item.id }} onClick={() => selectRecipe(item.id)}>
                    <div class="row-main">
                      <strong>{item.name}</strong>
                      <small>updated {fmtFull(item.updated_at)}</small>
                    </div>
                    <div class="row-actions">
                      <button class="chip run-chip" title={`Run ${item.name}`} onClick={e => { e.stopPropagation(); runRecipe(item.id) }}><Icon d={icons.play} /></button>
                      <button class="chip" title="Edit recipe" onClick={e => { e.stopPropagation(); openRecipeEdit(item.id) }}><Icon d={icons.pencil} /></button>
                      <button class="chip danger-chip" title="Delete recipe" onClick={e => { e.stopPropagation(); removeRecipe(item.id) }}><Icon d={icons.trash} /></button>
                    </div>
                  </article>
                )}
              </For>
            </Show>
          </div>
        </section>

        <section class="panel detail" aria-label="Selection detail">
          <Show when={railTab() === 'recipes'} fallback={
            <Show when={selectedServer()} fallback={<DetailHint kind="server" loaded={loaded()} onNew={() => setModal({ kind: 'server-form', draft: { port: 22 } })} />}>
              {srv => (
                <>
                  <div class="detail-head">
                    <h2>{srv().name}</h2>
                    <span class="tag">SSH inventory</span>
                  </div>
                  <p class="conn-string mono">{srv().username}@{srv().host}:{srv().port}</p>
                  <dl class="meta">
                    <div><dt>Port</dt><dd class="mono">{srv().port}</dd></div>
                    <div><dt>User</dt><dd>{srv().username}</dd></div>
                    <div><dt>Added</dt><dd>{fmtFull(srv().created_at)}</dd></div>
                    <div><dt>Updated</dt><dd>{fmtFull(srv().updated_at)}</dd></div>
                  </dl>
                  <p class="scope-note">Checked in a recipe's execution context, the recipe is streamed over SSH and run in a <code class="mono">nix-shell -p bun</code> on this server.</p>
                  <div class="detail-actions">
                    <button class="btn ghost" onClick={() => setModal({ kind: 'server-form', draft: srv() })}><Icon d={icons.pencil} /> Edit</button>
                    <button class="btn ghost danger" onClick={() => removeServer(srv().id)}><Icon d={icons.trash} /> Delete</button>
                  </div>
                </>
              )}
            </Show>
          }>
            <Show when={newRecipeDraft()} fallback={
              <Show when={selectedRecipe()} keyed fallback={<DetailHint kind="recipe" loaded={loaded()} onNew={startNewRecipe} />}>
                {rec => (
                  <RecipeDetail
                    recipe={rec}
                    tab={recipeTab()}
                    onTab={setRecipeTab}
                    onSave={saveRecipe}
                    onRun={() => runRecipe(rec.id)}
                    onDelete={() => removeRecipe(rec.id)}
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

      <footer class="dock panel" aria-label="Recent executions">
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
                <span class="dock-name">{recipesByID().get(run.recipe_id)?.name ?? `Recipe #${run.recipe_id}`}</span>
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
  tab: RecipeTab
  onTab: (t: RecipeTab) => void
  onSave: (d: { id?: number; name: string; content: string }) => Promise<void>
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
        <span class="tag">Bun shell</span>
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
        <RecipeEditor recipe={props.recipe} onSave={props.onSave} onCancel={props.onCancelEdit} />
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
      <p class="scope-note">Runs execute in a <code class="mono">nix-shell -p bun</code> — locally, or over SSH on each checked server; one run per checked context. Use <code class="mono">0</code> for no time limit.</p>
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
  onSave: (d: { id?: number; name: string; content: string }) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = createSignal(props.recipe?.name ?? '')
  const [content, setContent] = createSignal(props.recipe?.content ?? bunStarter)
  const [busy, setBusy] = createSignal(false)
  const submit = () => {
    if (busy()) return
    setBusy(true)
    props.onSave({ id: props.recipe?.id, name: name().trim(), content: content() }).finally(() => setBusy(false))
  }
  return (
    <form class="recipe-form" onSubmit={e => { e.preventDefault(); submit() }}>
      <label>Name
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
  return (
    <ModalFrame title={draft().id ? 'Edit server' : 'New server'} tag="SSH inventory" onClose={props.onCancel}>
      <form onSubmit={e => { e.preventDefault(); props.onSave(draft()) }}>
        <label>Name<input required value={draft().name ?? ''} onInput={e => setDraft({ ...draft(), name: e.currentTarget.value })} placeholder="Production Web 01" /></label>
        <label>IP or hostname<input required value={draft().host ?? ''} onInput={e => setDraft({ ...draft(), host: e.currentTarget.value })} placeholder="web-01.example.internal" /></label>
        <div class="twocol">
          <label>Port<input required type="number" min="1" max="65535" value={draft().port ?? 22} onInput={e => setDraft({ ...draft(), port: Number(e.currentTarget.value) })} /></label>
          <label>Username<input required value={draft().username ?? ''} onInput={e => setDraft({ ...draft(), username: e.currentTarget.value })} placeholder="deploy" /></label>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn ghost" onClick={props.onCancel}>Cancel</button>
          <button type="submit" class="btn primary">{draft().id ? 'Save changes' : 'Add server'}</button>
        </div>
      </form>
    </ModalFrame>
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
      <Option id={LOCAL_CONTEXT} title="Local runner" sub="nix-shell -p bun on this machine" />
      <For each={props.servers}>{s => <Option id={String(s.id)} title={s.name} sub={`${s.username}@${s.host}:${s.port}`} />}</For>
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
