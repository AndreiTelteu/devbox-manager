import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { render } from 'solid-js/web'
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
}

type Modal =
  | { kind: 'server-form'; draft: Partial<Server> }
  | { kind: 'recipe-form'; draft: Partial<Recipe> }
  | { kind: 'run'; run: Run }
  | { kind: 'confirm'; title: string; body: string; label: string; action: () => Promise<void> }

function App() {
  const [servers, setServers] = createSignal<Server[]>([])
  const [recipes, setRecipes] = createSignal<Recipe[]>([])
  const [runs, setRuns] = createSignal<Run[]>([])
  const [railTab, setRailTab] = createSignal<'recipes' | 'servers'>('recipes')
  const [selectedRecipeID, setSelectedRecipeID] = createSignal<number | null>(null)
  const [selectedServerID, setSelectedServerID] = createSignal<number | null>(null)
  const [runServerID, setRunServerID] = createSignal<string>('')
  const [notice, setNotice] = createSignal('')
  const [error, setError] = createSignal('')
  const [modal, setModal] = createSignal<Modal | null>(null)
  const [loaded, setLoaded] = createSignal(false)

  const recipesByID = createMemo(() => new Map(recipes().map(r => [r.id, r])))
  const serversByID = createMemo(() => new Map(servers().map(s => [s.id, s])))
  const sortedRuns = createMemo(() => [...runs()].sort((a, b) => b.started_at.localeCompare(a.started_at)))
  const selectedRecipe = createMemo(() => recipes().find(r => r.id === selectedRecipeID()) ?? null)
  const selectedServer = createMemo(() => servers().find(s => s.id === selectedServerID()) ?? null)

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
  async function saveRecipe(draft: Partial<Recipe>) {
    try {
      if (draft.id) await api(`/recipes/${draft.id}`, { method: 'PUT', body: JSON.stringify(draft) })
      else await api('/recipes', { method: 'POST', body: JSON.stringify(draft) })
      setModal(null); await reload(); if (draft.id) setSelectedRecipeID(draft.id)
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
      try { await api(`/recipes/${id}`, { method: 'DELETE' }); setModal(null); if (selectedRecipeID() === id) setSelectedRecipeID(null); await reload(); message('Recipe deleted.') } catch (e) { fail(e) }
    })
  }
  async function runRecipe(recipeID: number) {
    try {
      const body = runServerID() ? { server_id: Number(runServerID()) } : {}
      await api(`/recipes/${recipeID}/run`, { method: 'POST', body: JSON.stringify(body) })
      await reload(); message('Run started — watch the dock below.')
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
              <button class="btn ghost sm" onClick={() => setModal({ kind: 'recipe-form', draft: { content: mclStarter } })}><Icon d={icons.pencil} /> New</button>
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
              <For each={recipes()} fallback={<p class="empty">No recipes yet.<button class="btn ghost" onClick={() => setModal({ kind: 'recipe-form', draft: { content: mclStarter } })}>Write your first MCL recipe</button></p>}>
                {item => (
                  <article classList={{ row: true, selected: selectedRecipeID() === item.id }} onClick={() => { setSelectedRecipeID(item.id); setSelectedServerID(null) }}>
                    <div class="row-main">
                      <strong>{item.name}</strong>
                      <small>updated {fmtFull(item.updated_at)}</small>
                    </div>
                    <div class="row-actions">
                      <button class="chip run-chip" title={`Run ${item.name}`} onClick={e => { e.stopPropagation(); runRecipe(item.id) }}><Icon d={icons.play} /></button>
                      <button class="chip" title="Edit recipe" onClick={e => { e.stopPropagation(); setModal({ kind: 'recipe-form', draft: item }) }}><Icon d={icons.pencil} /></button>
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
            <Show when={selectedRecipe()} fallback={<DetailHint kind="recipe" loaded={loaded()} onNew={() => setModal({ kind: 'recipe-form', draft: { content: mclStarter } })} />}>
              {rec => (
                <>
                  <div class="detail-head">
                    <h2>{rec().name}</h2>
                    <span class="tag">MCL</span>
                  </div>
                  <pre class="recipe-source mono" tabIndex={0}>{rec().content}</pre>
                  <label class="run-target">Execution context
                    <select value={runServerID()} onChange={e => setRunServerID(e.currentTarget.value)}>
                      <option value="">Local runner (MVP)</option>
                      <For each={servers()}>{s => <option value={s.id}>{s.name} · {s.username}@{s.host}:{s.port}</option>}</For>
                    </select>
                  </label>
                  <p class="scope-note">Runs execute locally via <code class="mono">mgmt run</code>; the selected server is saved as audit context.</p>
                  <div class="detail-actions">
                    <button class="btn primary" onClick={() => runRecipe(rec().id)}><Icon d={icons.play} /> Run now</button>
                    <button class="btn ghost" onClick={() => setModal({ kind: 'recipe-form', draft: rec() })}><Icon d={icons.pencil} /> Edit</button>
                    <button class="btn ghost danger" onClick={() => removeRecipe(rec().id)}><Icon d={icons.trash} /> Delete</button>
                  </div>
                </>
              )}
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
            <ModalSwitch modal={m()} onCancel={() => setModal(null)} saveServer={saveServer} saveRecipe={saveRecipe} onCopied={copyOutput} fmtFull={fmtFull} fmtDuration={fmtDuration} runTarget={runTarget} />
          </div>
        )}
      </Show>
    </div>
  )
}

function ModalSwitch(props: {
  modal: Modal
  onCancel: () => void
  saveServer: (d: Partial<Server>) => Promise<void>
  saveRecipe: (d: Partial<Recipe>) => Promise<void>
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
      <Show when={props.modal.kind === 'recipe-form'}>
        <RecipeForm draft={(props.modal as Extract<Modal, { kind: 'recipe-form' }>).draft} onSave={props.saveRecipe} onCancel={props.onCancel} />
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

function RecipeForm(props: { draft: Partial<Recipe>; onSave: (d: Partial<Recipe>) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = createSignal<Partial<Recipe>>(props.draft)
  return (
    <ModalFrame title={draft().id ? 'Edit recipe' : 'New recipe'} tag="MCL" onClose={props.onCancel}>
      <form onSubmit={e => { e.preventDefault(); props.onSave(draft()) }}>
        <label>Name<input required value={draft().name ?? ''} onInput={e => setDraft({ ...draft(), name: e.currentTarget.value })} placeholder="Install nginx" /></label>
        <label>Recipe content<textarea required spellcheck={false} rows={14} value={draft().content ?? ''} onInput={e => setDraft({ ...draft(), content: e.currentTarget.value })} /></label>
        <div class="dialog-actions">
          <button type="button" class="btn ghost" onClick={props.onCancel}>Cancel</button>
          <button type="submit" class="btn primary">{draft().id ? 'Save changes' : 'Save recipe'}</button>
        </div>
      </form>
    </ModalFrame>
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
