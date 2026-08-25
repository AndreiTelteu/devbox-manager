/* devbox-manager: mgmt · MCL recipe manager
 * Copyright (C) 2026  Andrei
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { blockIssues, emitMcl, KIND_SPECS, newBlock, PALETTE, parseMcl, summarize } from './builder'
import type { BlockKind, BlockNode, BuilderNode } from './builder'
import './styles.css'

type Server = { id: number; name: string; host: string; port: number; username: string; created_at: string; updated_at: string }
type Recipe = { id: number; name: string; content: string; created_at: string; updated_at: string }
type Run = { id: number; recipe_id: number; server_id?: number | null; status: 'running' | 'succeeded' | 'failed'; exit_code?: number | null; output: string; started_at: string; finished_at?: string | null }

const mclStarter = `# Mgmt Config recipe\n# Define the desired state below.\n\nfile "/tmp/devbox-managed.txt" {\n\tcontent => "Managed by Devbox Manager\\n",\n\tstate => "exists",\n}\n`

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
  blocks: 'M14 4h6v6h-6zM4 4h6v6H4zM4 14h6v6H4zM14 14h6v6h-6z',
  warn: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
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

type RecipeTab = 'view' | 'edit' | 'builder'

type Modal =
  | { kind: 'server-form'; draft: Partial<Server> }
  | { kind: 'run'; run: Run }
  | { kind: 'confirm'; title: string; body: string; label: string; action: () => Promise<void> }

function App() {
  const [servers, setServers] = createSignal<Server[]>([])
  const [recipes, setRecipes] = createSignal<Recipe[]>([])
  const [runs, setRuns] = createSignal<Run[]>([])
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
  const [loaded, setLoaded] = createSignal(false)

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
      const [nextServers, nextRecipes, nextRuns] = await Promise.all([api<Server[]>('/servers'), api<Recipe[]>('/recipes'), api<Run[]>('/runs')])
      setServers(nextServers); setRecipes(nextRecipes); setRuns(nextRuns); setLoaded(true)
    } catch (e) { fail(e) }
  }
  onMount(() => { reload() })
  const pollTimer = window.setInterval(() => { if (runs().some(r => r.status === 'running')) reload() }, 4000)
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
      await Promise.all(queue.map(id => {
        const body: Record<string, number> = {}
        if (id !== LOCAL_CONTEXT) body.server_id = Number(id)
        if (maxRuntime() > 0) body.max_runtime = maxRuntime()
        return api(`/recipes/${recipeID}/run`, { method: 'POST', body: JSON.stringify(body) })
      }))
      await reload()
      message(queue.length > 1 ? `${queue.length} runs started — watch the dock below.` : 'Run started — watch the dock below.')
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
          <span class="pill"><span class="pulse" /> SQLite-backed</span>
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
              <For each={recipes()} fallback={<p class="empty">No recipes yet.<button class="btn ghost" onClick={startNewRecipe}>Write your first MCL recipe</button></p>}>
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
                  <p class="scope-note">Recorded for audit context on recipe runs — this MVP executes locally only.</p>
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
          <span class="dock-hint mono">{sortedRuns().filter(r => r.status === 'running').length > 0 ? 'polling while runs are active…' : 'click a run for full output'}</span>
        </div>
        <div class="dock-list">
          <For each={sortedRuns()} fallback={<p class="empty slim">{loaded() ? 'No runs yet — press Run on any recipe.' : 'Loading executions…'}</p>}>
            {run => (
              <button class="dock-row" onClick={() => setModal({ kind: 'run', run })}>
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

// ---------- recipe detail: View / Edit / Builder tabs ----------

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
        <span class="tag">MCL</span>
      </div>
      <nav class="segmented detail-tabs" role="tablist" aria-label="Recipe editing mode">
        <button role="tab" aria-selected={props.tab === 'view'} classList={{ active: props.tab === 'view' }} onClick={() => props.onTab('view')}><Icon d={icons.eye} size={13} /> View</button>
        <button role="tab" aria-selected={props.tab === 'edit'} classList={{ active: props.tab === 'edit' }} onClick={() => props.onTab('edit')}><Icon d={icons.pencil} size={13} /> Edit</button>
        <button role="tab" aria-selected={props.tab === 'builder'} classList={{ active: props.tab === 'builder' }} onClick={() => props.onTab('builder')}><Icon d={icons.blocks} size={13} /> Builder</button>
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
      <Show when={props.tab === 'builder'}>
        <RecipeBuilder recipe={props.recipe} onSave={props.onSave} onCancel={props.onCancelEdit} />
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
      <p class="scope-note">Runs execute locally via <code class="mono">mgmt run</code> — one run per checked context; checked servers are saved as audit context. Use <code class="mono">0</code> for no time limit; anything above is passed to mgmt as <code class="mono">--max-runtime</code>.</p>
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
  const [content, setContent] = createSignal(props.recipe?.content ?? mclStarter)
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
      <label>Recipe content — MCL
        <textarea class="mono" required spellcheck={false} rows={16} value={content()} onInput={e => setContent(e.currentTarget.value)} />
      </label>
      <div class="detail-actions">
        <button type="submit" class="btn primary" disabled={busy()}>{busy() ? 'Saving…' : props.recipe ? 'Save changes' : 'Save recipe'}</button>
        <button type="button" class="btn ghost" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  )
}

const DND_KIND = 'application/x-devbox-kind'
const DND_UID = 'application/x-devbox-uid'

function RecipeBuilder(props: {
  recipe: Recipe | null
  onSave: (d: { id?: number; name: string; content: string }) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = createSignal(props.recipe?.name ?? '')
  const [nodes, setNodes] = createSignal<BuilderNode[]>(parseMcl(props.recipe?.content ?? mclStarter))
  const [selectedUid, setSelectedUid] = createSignal<string | null>(null)
  const [dropIndex, setDropIndex] = createSignal<number | null>(null)
  const [busy, setBusy] = createSignal(false)

  const selectedNode = createMemo(() => nodes().find(n => n.uid === selectedUid()) ?? null)
  const emitted = createMemo(() => emitMcl(nodes()))

  const updateNode = (uid: string, patch: Partial<BlockNode>) =>
    setNodes(ns => ns.map(n => (n.uid === uid && n.type === 'block' ? { ...n, ...patch } : n)))
  const patchField = (uid: string, key: string, value: string) =>
    setNodes(ns => ns.map(n => (n.uid === uid && n.type === 'block' ? { ...n, fields: { ...n.fields, [key]: value } } : n)))
  const removeNode = (uid: string) => {
    if (selectedUid() === uid) setSelectedUid(null)
    setNodes(ns => ns.filter(n => n.uid !== uid))
  }
  const insertAt = (idx: number, node: BuilderNode) => {
    setNodes(ns => { const next = [...ns]; next.splice(Math.max(0, Math.min(idx, next.length)), 0, node); return next })
    if (node.type === 'block') setSelectedUid(node.uid)
  }
  const moveBlock = (uid: string, idx: number) => {
    const cur = nodes()
    const from = cur.findIndex(n => n.uid === uid)
    if (from === -1) return
    const next = [...cur]
    const [node] = next.splice(from, 1)
    next.splice(Math.max(0, from < idx ? idx - 1 : idx), 0, node)
    setNodes(next)
    setSelectedUid(uid)
  }

  const dndTypes = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? [])
  const onCanvasDragOver = (e: DragEvent) => {
    const types = dndTypes(e)
    if (!types.includes(DND_KIND) && !types.includes(DND_UID)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = types.includes(DND_KIND) ? 'copy' : 'move'
    const canvas = e.currentTarget as HTMLElement
    const cards = Array.from(canvas.querySelectorAll<HTMLElement>('.bblk'))
    let idx = cards.length
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect()
      if (e.clientY < r.top + r.height / 2) { idx = i; break }
    }
    setDropIndex(idx)
  }
  const onCanvasDrop = (e: DragEvent) => {
    e.preventDefault()
    const kind = e.dataTransfer?.getData(DND_KIND) ?? ''
    const uid = e.dataTransfer?.getData(DND_UID) ?? ''
    const idx = dropIndex() ?? nodes().length
    if (kind && kind in KIND_SPECS) insertAt(idx, newBlock(kind as BlockKind))
    else if (uid) moveBlock(uid, idx)
    setDropIndex(null)
  }
  const onCanvasDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropIndex(null)
  }

  const submit = () => {
    if (busy()) return
    setBusy(true)
    props.onSave({ id: props.recipe?.id, name: name().trim(), content: emitted() }).finally(() => setBusy(false))
  }

  return (
    <div class="builder-root">
      <label class="recipe-name">Name
        <input required value={name()} onInput={e => setName(e.currentTarget.value)} placeholder="Install nginx" />
      </label>
      <div classList={{ builder: true, 'no-side': !selectedNode() }}>
        <div
          classList={{ 'builder-canvas': true, 'drop-hint': dropIndex() !== null }}
          onDragOver={onCanvasDragOver}
          onDrop={onCanvasDrop}
          onDragLeave={onCanvasDragLeave}
        >
          <Show when={nodes().length === 0}>
            <p class="canvas-empty">Drag a block from the palette, or click one to append it here.</p>
          </Show>
          <For each={nodes()}>
            {(node, i) => (
              <>
                <div classList={{ 'drop-line': true, show: dropIndex() === i() }} />
                <BuilderCard node={node} selected={selectedUid() === node.uid} onSelect={() => setSelectedUid(node.uid)} onRemove={() => removeNode(node.uid)} />
              </>
            )}
          </For>
          <div classList={{ 'drop-line': true, show: dropIndex() === nodes().length && nodes().length > 0 }} />
        </div>
        <Show when={selectedNode()}>
          {node => <BuilderSidebar node={node()} updateNode={updateNode} patchField={patchField} onClose={() => setSelectedUid(null)} />}
        </Show>
        <aside class="palette" aria-label="Block palette">
          <span class="palette-title">Blocks</span>
          <For each={PALETTE}>
            {kind => {
              const spec = KIND_SPECS[kind]
              return (
                <button
                  type="button"
                  class="bpal"
                  style={{ '--kc': spec.color }}
                  title={`${spec.label} — ${spec.hint}\nClick to append, drag to place anywhere.`}
                  draggable={true}
                  onDragStart={e => { e.dataTransfer?.setData(DND_KIND, kind); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy' }}
                  onClick={() => insertAt(nodes().length, newBlock(kind))}
                >
                  <span class="bblk-ic"><Icon d={spec.icon} size={13} /></span>
                  {spec.label}
                </button>
              )
            }}
          </For>
        </aside>
      </div>
      <span class="run-target">Generated MCL</span>
      <pre class="recipe-source mono builder-src" tabIndex={0}>{emitted() || '(empty recipe)'}</pre>
      <div class="detail-actions">
        <button class="btn primary" disabled={busy() || !name().trim()} onClick={submit}>{busy() ? 'Saving…' : props.recipe ? 'Save changes' : 'Save recipe'}</button>
        <button class="btn ghost" onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function BuilderCard(props: { node: BuilderNode; selected: boolean; onSelect: () => void; onRemove: () => void }) {
  const raw = () => props.node.type === 'raw'
  const spec = () => (props.node.type === 'block' ? KIND_SPECS[props.node.kind] : null)
  const issues = () => blockIssues(props.node)
  return (
    <div
      classList={{ bblk: true, raw: raw(), sel: props.selected }}
      style={{ '--kc': raw() ? 'var(--text-dim)' : spec()!.color }}
      draggable={true}
      role="button"
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelect() } }}
      onDragStart={e => { e.dataTransfer?.setData(DND_UID, props.node.uid); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move' }}
    >
      <span class="bblk-ic"><Icon d={raw() ? icons.terminal : spec()!.icon} size={13} /></span>
      <span class="bblk-text">
        <strong class="bblk-title">{raw() ? 'Raw MCL' : (props.node as BlockNode).title.trim() || spec()!.titlePlaceholder}</strong>
        <small class="bblk-sub">{summarize(props.node)}</small>
      </span>
      <Show when={issues().length > 0}>
        <span class="bblk-issue" title={issues().join('\n')}><Icon d={icons.warn} size={11} /> {issues().length}</span>
      </Show>
      <button class="chip bblk-del" title="Remove block" onClick={e => { e.stopPropagation(); props.onRemove() }}><Icon d={icons.x} /></button>
    </div>
  )
}

function BuilderSidebar(props: {
  node: BuilderNode
  updateNode: (uid: string, patch: Partial<BlockNode>) => void
  patchField: (uid: string, key: string, value: string) => void
  onClose: () => void
}) {
  return (
    <aside class="bside" aria-label="Block fields">
      {props.node.type === 'block' ? (
        <BlockFields node={props.node} updateNode={props.updateNode} patchField={props.patchField} onClose={props.onClose} />
      ) : (
        <RawFields node={props.node} onClose={props.onClose} />
      )}
    </aside>
  )
}

function BlockFields(props: {
  node: BlockNode
  updateNode: (uid: string, patch: Partial<BlockNode>) => void
  patchField: (uid: string, key: string, value: string) => void
  onClose: () => void
}) {
  const spec = () => KIND_SPECS[props.node.kind]
  return (
    <>
      <div class="bside-head">
        <span class="bblk-ic" style={{ '--kc': spec().color }}><Icon d={spec().icon} size={13} /></span>
        <strong>{spec().label}</strong>
        <button class="chip" title="Close fields" onClick={props.onClose}><Icon d={icons.x} /></button>
      </div>
      <label>{spec().titleLabel}
        <input value={props.node.title} placeholder={spec().titlePlaceholder} onInput={e => props.updateNode(props.node.uid, { title: e.currentTarget.value })} />
      </label>
      <For each={spec().fields}>
        {f => (
          <label>{f.label}
            {f.type === 'textarea'
              ? <textarea class="mono" rows={f.rows ?? 4} spellcheck={false} value={props.node.fields[f.key] ?? ''} placeholder={f.placeholder} onInput={e => props.patchField(props.node.uid, f.key, e.currentTarget.value)} />
              : f.type === 'select'
                ? <select value={props.node.fields[f.key] ?? f.default ?? ''} onChange={e => props.patchField(props.node.uid, f.key, e.currentTarget.value)}>
                    <For each={f.options ?? []}>{o => <option value={o}>{o}</option>}</For>
                  </select>
                : <input
                    type={f.type === 'int' ? 'number' : 'text'}
                    step={f.type === 'int' ? '1' : undefined}
                    value={props.node.fields[f.key] ?? ''}
                    placeholder={f.placeholder}
                    onInput={e => props.patchField(props.node.uid, f.key, e.currentTarget.value)}
                  />}
          </label>
        )}
      </For>
    </>
  )
}

function RawFields(props: { node: Extract<BuilderNode, { type: 'raw' }>; onClose: () => void }) {
  return (
    <>
      <div class="bside-head">
        <span class="bblk-ic"><Icon d={icons.terminal} size={13} /></span>
        <strong>Raw MCL</strong>
        <button class="chip" title="Close fields" onClick={props.onClose}><Icon d={icons.x} /></button>
      </div>
      <p class="raw-note">This part isn't a standard mgmt resource, so Builder keeps it verbatim. To change it, use the Edit tab.</p>
      <pre class="bside-raw mono">{props.node.source}</pre>
    </>
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
        <RunDetail run={(props.modal as Extract<Modal, { kind: 'run' }>).run} onClose={props.onCancel} onCopy={props.onCopied} fmtFull={props.fmtFull} fmtDuration={props.fmtDuration} runTarget={props.runTarget} />
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
      <Option id={LOCAL_CONTEXT} title="Local runner (MVP)" sub="mgmt run on this machine" />
      <For each={props.servers}>{s => <Option id={String(s.id)} title={s.name} sub={`${s.username}@${s.host}:${s.port}`} />}</For>
    </div>
  )
}

function RunDetail(props: { run: Run; onClose: () => void; onCopy: (t: string) => void; fmtFull: (iso: string) => string; fmtDuration: (r: Run) => string; runTarget: (r: Run) => string }) {
  const statusLabel: Record<string, string> = { running: 'Running', succeeded: 'Succeeded', failed: 'Failed' }
  return (
    <ModalFrame title="Execution detail" onClose={props.onClose}>
      <dl class="meta run-meta">
        <div><dt>Status</dt><dd><span class={`status s-${props.run.status}`}>{statusLabel[props.run.status]}</span></dd></div>
        <div><dt>Exit code</dt><dd class="mono">{props.run.exit_code ?? (props.run.status === 'running' ? '—' : '')}</dd></div>
        <div><dt>Started</dt><dd>{props.fmtFull(props.run.started_at)}</dd></div>
        <div><dt>Finished</dt><dd>{props.run.finished_at ? props.fmtFull(props.run.finished_at) : '—'}</dd></div>
        <div><dt>Duration</dt><dd class="mono">{props.fmtDuration(props.run)}</dd></div>
        <div><dt>Target</dt><dd>{props.runTarget(props.run)}</dd></div>
      </dl>
      <pre class="output mono">{props.run.output || (props.run.status === 'running' ? 'mgmt is running — output lands here when it finishes.' : '(no output)')}</pre>
      <div class="dialog-actions">
        <Show when={props.run.output}><button class="btn ghost" onClick={() => props.onCopy(props.run.output)}><Icon d={icons.copy} /> Copy output</button></Show>
        <button class="btn primary" onClick={props.onClose}>Close</button>
      </div>
    </ModalFrame>
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
    ? { title: 'Nothing selected', body: 'Pick a recipe on the left to inspect its MCL source and run it.' }
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
