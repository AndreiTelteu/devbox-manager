import { createSignal, For, onMount, Show } from 'solid-js'
import { render } from 'solid-js/web'
import './styles.css'

type Server = { id: number; name: string; host: string; port: number; username: string; created_at: string; updated_at: string }
type Recipe = { id: number; name: string; content: string; created_at: string; updated_at: string }
type Run = { id: number; recipe_id: number; server_id?: number | null; status: string; output: string; started_at: string; finished_at?: string | null }

const mclStarter = `# Mgmt Config recipe\n# Define the desired state below.\n\nfile "/tmp/devbox-managed.txt" {\n\tcontent => "Managed by Devbox Manager\\n",\n\tstate => "exists",\n}\n`

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, ...init })
  if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`)
  return response.status === 204 ? (undefined as T) : response.json()
}

function App() {
  const [servers, setServers] = createSignal<Server[]>([])
  const [recipes, setRecipes] = createSignal<Recipe[]>([])
  const [runs, setRuns] = createSignal<Run[]>([])
  const [active, setActive] = createSignal<'servers' | 'recipes'>('servers')
  const [server, setServer] = createSignal<Partial<Server>>({ port: 22 })
  const [recipe, setRecipe] = createSignal<Partial<Recipe>>({ content: mclStarter })
  const [selectedRecipe, setSelectedRecipe] = createSignal<number | null>(null)
  const [runServerID, setRunServerID] = createSignal<string>('')
  const [notice, setNotice] = createSignal('')
  const [error, setError] = createSignal('')

  const reload = async () => {
    try {
      const [nextServers, nextRecipes, nextRuns] = await Promise.all([api<Server[]>('/servers'), api<Recipe[]>('/recipes'), api<Run[]>('/runs')])
      setServers(nextServers); setRecipes(nextRecipes); setRuns(nextRuns)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load data') }
  }
  onMount(reload)
  const message = (text: string) => { setError(''); setNotice(text); window.setTimeout(() => setNotice(''), 3500) }

  async function saveServer(event: SubmitEvent) {
    event.preventDefault(); const item = server()
    try {
      if (item.id) await api(`/servers/${item.id}`, { method: 'PUT', body: JSON.stringify(item) })
      else await api('/servers', { method: 'POST', body: JSON.stringify(item) })
      setServer({ port: 22 }); await reload(); message('Server saved.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed') }
  }
  async function removeServer(id: number) {
    if (!confirm('Delete this server?')) return
    try { await api(`/servers/${id}`, { method: 'DELETE' }); await reload(); message('Server deleted.') } catch (e) { setError(e instanceof Error ? e.message : 'Delete failed') }
  }
  async function saveRecipe(event: SubmitEvent) {
    event.preventDefault(); const item = recipe()
    try {
      if (item.id) await api(`/recipes/${item.id}`, { method: 'PUT', body: JSON.stringify(item) })
      else await api('/recipes', { method: 'POST', body: JSON.stringify(item) })
      setRecipe({ content: mclStarter }); await reload(); message('Recipe saved.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Save failed') }
  }
  async function removeRecipe(id: number) {
    if (!confirm('Delete this recipe?')) return
    try { await api(`/recipes/${id}`, { method: 'DELETE' }); if (selectedRecipe() === id) setSelectedRecipe(null); await reload(); message('Recipe deleted.') } catch (e) { setError(e instanceof Error ? e.message : 'Delete failed') }
  }
  async function runRecipe(recipeID: number) {
    try {
      const body = runServerID() ? { server_id: Number(runServerID()) } : {}
      await api(`/recipes/${recipeID}/run`, { method: 'POST', body: JSON.stringify(body) }); await reload(); message('Run started. Output is recorded below.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Run failed') }
  }

  return <main>
    <header><div><p class="eyebrow">INFRASTRUCTURE WORKSPACE</p><h1>Devbox Manager</h1><p class="subtitle">Inventory and declarative Mgmt recipes — no control-plane login.</p></div><div class="live"><span /> SQLite-backed</div></header>
    <Show when={notice()}><div class="notice">{notice()}</div></Show><Show when={error()}><div class="error">{error()}</div></Show>
    <nav><button classList={{ active: active() === 'servers' }} onClick={() => setActive('servers')}>Servers <b>{servers().length}</b></button><button classList={{ active: active() === 'recipes' }} onClick={() => setActive('recipes')}>Recipes <b>{recipes().length}</b></button></nav>
    <Show when={active() === 'servers'} fallback={<section class="grid recipes">
      <div class="panel list"><div class="panel-title"><h2>Recipes</h2><button class="quiet" onClick={() => setRecipe({ content: mclStarter })}>+ New recipe</button></div><For each={recipes()} fallback={<p class="empty">No recipes yet. Create one with MCL.</p>}>{item => <article classList={{ selected: selectedRecipe() === item.id }} onClick={() => { setSelectedRecipe(item.id); setRecipe(item) }}><div><strong>{item.name}</strong><small>Updated {new Date(item.updated_at).toLocaleString()}</small></div><div class="actions"><button onClick={(e) => { e.stopPropagation(); runRecipe(item.id) }}>Run</button><button class="danger" onClick={(e) => { e.stopPropagation(); removeRecipe(item.id) }}>Delete</button></div></article>}</For></div>
      <div class="panel editor"><div class="panel-title"><h2>{recipe().id ? 'Edit recipe' : 'New recipe'}</h2><span class="tag">MCL</span></div><form onSubmit={saveRecipe}><label>Name<input required value={recipe().name ?? ''} onInput={e => setRecipe({ ...recipe(), name: e.currentTarget.value })} placeholder="Install nginx" /></label><label>Recipe content<textarea required spellcheck={false} value={recipe().content ?? ''} onInput={e => setRecipe({ ...recipe(), content: e.currentTarget.value })} /></label><div class="run-target"><label>Inventory context<select value={runServerID()} onInput={e => setRunServerID(e.currentTarget.value)}><option value="">Local runner (MVP)</option><For each={servers()}>{s => <option value={s.id}>{s.name} · {s.username}@{s.host}:{s.port}</option>}</For></select></label><p>Runs are local for now; selected server is saved as execution context. Remote mgmt agents are the next deployment phase.</p></div><div class="form-actions"><button type="button" class="quiet" onClick={() => setRecipe({ content: mclStarter })}>Reset</button><button type="submit">Save recipe</button><Show when={recipe().id}><button type="button" class="run" onClick={() => runRecipe(recipe().id!)}>Run now</button></Show></div></form></div>
    </section>}>
      <section class="grid"><div class="panel list"><div class="panel-title"><h2>Inventory</h2><button class="quiet" onClick={() => setServer({ port: 22 })}>+ New server</button></div><For each={servers()} fallback={<p class="empty">No servers in inventory yet.</p>}>{item => <article onClick={() => setServer(item)}><div><strong>{item.name}</strong><small>{item.username}@{item.host}:{item.port}</small></div><div class="actions"><button onClick={(e) => { e.stopPropagation(); setServer(item) }}>Edit</button><button class="danger" onClick={(e) => { e.stopPropagation(); removeServer(item.id) }}>Delete</button></div></article>}</For></div><div class="panel"><div class="panel-title"><h2>{server().id ? 'Edit server' : 'New server'}</h2><span class="tag">SSH inventory</span></div><form onSubmit={saveServer}><label>Name<input required value={server().name ?? ''} onInput={e => setServer({ ...server(), name: e.currentTarget.value })} placeholder="Production Web 01" /></label><label>IP or hostname<input required value={server().host ?? ''} onInput={e => setServer({ ...server(), host: e.currentTarget.value })} placeholder="web-01.example.internal" /></label><div class="twocol"><label>Port<input required type="number" min="1" max="65535" value={server().port ?? 22} onInput={e => setServer({ ...server(), port: Number(e.currentTarget.value) })} /></label><label>Username<input required value={server().username ?? ''} onInput={e => setServer({ ...server(), username: e.currentTarget.value })} placeholder="deploy" /></label></div><div class="form-actions"><button type="button" class="quiet" onClick={() => setServer({ port: 22 })}>Reset</button><button type="submit">Save server</button></div></form></div></section>
    </Show>
    <section class="panel runs"><div class="panel-title"><h2>Recent executions</h2><button class="quiet" onClick={reload}>Refresh</button></div><For each={runs()} fallback={<p class="empty">Runs will appear here with Mgmt output.</p>}>{run => <article><div><strong classList={{ failed: run.status === 'failed' }}>{run.status}</strong><small>Recipe #{run.recipe_id}{run.server_id ? ` · Server #${run.server_id}` : ' · Local'} · {new Date(run.started_at).toLocaleString()}</small></div><pre>{run.output || 'Running…'}</pre></article>}</For></section>
  </main>
}
render(() => <App />, document.getElementById('root')!)
