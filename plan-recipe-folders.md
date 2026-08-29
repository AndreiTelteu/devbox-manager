# Plan dezvoltare: Recipes — foldere, helpers cross-OS, file tree UI

Obiective:

1. Eliminăm `recipes.yml` — listarea rețetelor = scanarea recursivă a `data/recipes/`.
2. Folder `data/recipes/_helpers/` cu helperii extrase din embed-ul Go și din
   rețetele debian actuale — câte un fișier per helper, editabile manual,
   versionate în git-ul intern din `data/`, la fel ca rețetele.
3. Helperi noi cross-OS: `devboxOsName()` și `devboxEnsureNode24()` care
   instalează diferit per platformă.
4. UI listare rețete ca file tree (collapse foldere, stil VSCode), creare
   foldere și drag & drop rețete între foldere.

Nu rescriem rețetele actuale în această etapă.

## Decizii de design

**Identitatea rețetei = calea relativă fără extensie.**
`web/t3-debian` → fișierul `data/recipes/web/t3-debian.ts`. `recipes.yml`
dispare complet. `created_at`/`updated_at` = mtime-ul fișierului.

**`Run.RecipeID` (numeric) devine `Run.Recipe` (string, calea rețetei).**
Logurile existente (`data/logs/*.json`, ~85) referă id-uri numerice din
`recipes.yml`; nu le migrăm — **le ștergem** (aprobate de owner; oricum sunt
gitignored). Istoricul execuțiilor începe de la zero.

**Helperii NU mai sunt embeduiți în binarul Go.**
`internal/devbox/recipe_helpers.ts` (go:embed) se șterge. Runner-ul citește
la fiecare rulare `data/recipes/_helpers/*.ts` de pe disc și le prependează
rețetei — inclusiv remote, peste SSH (pipe-ul deja transmite totul ca un
singur fișier). Editarea manuală a unui helper are efect instant, la următoarea
rulare, și trece prin același commit git ca rețetele.

**Prefixul `devbox` pe toți helperii noi.** Nu putem folosi numele „gol"
(`osName`, `ensureNode24`): rețetele `-debian.ts` actuale definesc local
`async function ensureNode24()` etc., iar concatenarea ar da
`SyntaxError: redeclaration` — iar rețetele actuale nu le atingem. Excepție:
`devboxEnsureNixPort` / `devboxEnsureNode24` (nix) își păstrează numele
exacte, ca rețetele nix actuale să meargă nemodificate.

**Concatenare, nu `import`.** Fișierele din `_helpers` rămân TS valid
standalone ( fiecare cu `import { $ as devbox$ } from "bun"` ); la
concatenare, runner-ul deduplică liniile de import rămase în corp și injectează
un singur import la început.

**Convenții scan:** directoarele cu prefix `_` (ex. `_helpers`) și fișierele
non-`.ts` (ex. `.gitkeep`) se ignoră la listarea rețetelor.

---

## Faza 1 — Backend: rețete pe căi, fără recipes.yml

`internal/devbox/store.go`:

- `Recipe{Name string; Content string; CreatedAt, UpdatedAt time.Time}` — fără ID.
- `Run.Recipe string` în loc de `RecipeID int64`; `ListRuns(recipeName)`.
- `safePath`: segmente separate prin `/`, fiecare `^[A-Za-z0-9][A-Za-z0-9._-]*$`,
  fără segmente cu `_` la început, fără `..`, adâncime liberă.
- `ListRecipes` = `filepath.WalkDir` pe `data/recipes/` (skip `_`/non-.ts),
  sortat lexicografic, timestamps din mtime.
- `GetRecipe(name)`, `CreateRecipe` (creează directoarele părinte),
  `UpdateRecipe` (redenumire = `os.Rename` + rescriere conținut),
  `DeleteRecipe` (șterge fișierul; directoarele părinte rămase goale se curăță).
- `ensureLayout`: dacă `recipes.yml` există → `git rm` + commit
  „dropped recipes.yml index"; dacă `data/logs/*.json` conțin `recipe_id` →
  wipe. Ambele idempotente.
- Commit-uri git pe căi noi: `added web/t3.ts recipe` etc.

`internal/devbox/run.go`: `Runner.Run(ctx, recipeName string, serverID *int64, maxRuntime int)`;
`GetRecipe(ctx, name)`.

`internal/devbox/http.go`:

- `GET /api/recipes` — lista cu căi (`name` = `folder/recipe`).
- `POST /api/recipes`, `GET|PUT|DELETE /api/recipes/{name...}` (wildcard Go 1.22+).
- `POST /api/recipes/{name...}/run`, `GET /api/recipes/{name...}/runs`.
- `GET /api/runs` — `recipe` ca string.

`cmd/devbox-manager/main.go`: CLI `recipe list|create|update|delete|run`
cu `--name` în loc de `--id`.

## Faza 2 — Folderul `_helpers` + helperi cross-OS

Fișiere create direct pe disk în `data/recipes/_helpers/` (nu în Go),
comparate în git-ul din `data/`, fiecare cu header MIT:

- `devboxSudo.ts` — `devboxSudoRead` / `devboxSudoWrite` (mutate din fostul embed).
- `devboxEnsureNixPort.ts` — `devboxEnsureNixPort`, `devboxEnsureNixModule`,
  internele nix (mutate din fostul embed; comportament identic).
- `devboxOsName.ts` — **nou**: `devboxOsName(): Promise<string>` — parsează
  `/etc/os-release` (`ID`, fallback `ID_LIKE`), întoarce `nixos` / `ubuntu` /
  `debian` / … / `unknown`.
- `devboxDebian.ts` — **nou**: `devboxDebian(cmd)` — wrapper `bash -lc`
  (extras din rețetele `-debian.ts` actuale).
- `devboxEnsureNode24.ts` — **nou, cross-OS**: `devboxOsName()` apoi switch:
  - `nixos` → `nix profile install nixpkgs#nodejs_24 python3 gnumake gcc`
    (logica actuală din embed);
  - `debian` / `ubuntu` → apt + NodeSource node_24.x + python3/make/g++
    (logica extrasă din rețetele debian);
  - altceva → `throw`.
  Validare post-instal ca acum. **Înlocuiește** versiunea nix-only cu același
  nume — rețetele nix existente (t3, pi, …) funcționează nemodificate.
- `devboxEnsureUfwPort.ts` — **nou**: extras din rețetele debian.

Runner (`run.go`):

- Citește `data/recipes/_helpers/*.ts` sortat la fiecare rulare; dacă folderul
  lipsește sau e gol, nu prependează nimic.
- Dedup liniile de import din corpul helperilor, un singur import la început.
- Ștergem `internal/devbox/recipe_helpers.ts` + embed-ul.
- Rețetele actuale rămân neschimbate: cele nix au comportament identic;
  cele debian își păstrează copiile locale (duplicare temporară acceptată).

## Faza 3 — API foldere

- `POST /api/recipe-folders {path}` → `mkdir -p data/recipes/<path>` +
  `.gitkeep` (git nu ține directoare goale) + commit.
- Validare: aceleași reguli de segment ca la rețete, fără `_` la început.
- Fără rename/delete foldere din API în această etapă (se pot adăuga ulterior).

## Faza 4 — UI: file tree stil VSCode

Implementarea UI se delegă unui **subagent** instruit explicit să încarce
skillul `impeccable` (`~/.agents/skills/impeccable/SKILL.md`) și să îi urmeze
procesul de design; subagentul primește contractul API din Fazele 1–3.

`web/src/main.tsx`, `store.ts`, `styles.css`:

- Rail Recipes devine arbore construit din căi (`buildTree(recipes)`):
  foldere cu chevron de collapse (stare expand/collapse persistată în
  localStorage), rețete frunze, indentare pe nivel.
- **Folder nou**: buton lângă „New" → input inline în arbore, creează prin
  `POST /api/recipe-folders`.
- **Drag & drop**: rândurile de rețetă `draggable`; drop pe un folder (sau pe
  zona root = fără folder) → `PUT /api/recipes/{cale}` cu numele nou
  (`folder/bază`) = mutare; highlight vizual pe `dragover`; reload după.
- Buton „+" pe rândul folderului → rețetă nouă cu numele precompletat
  `folder/`; câmpul Name din editor acceptă căi.
- Dock/executions afișează `run.recipe` direct; selecția UI se cheiază pe
  nume, nu pe id.
- Iconuri SVG desenate (chevron, folder, plus), fără emoji, copy în engleză.

## Faza 5 — Verificare & deploy

1. `go test ./...` + teste noi: scan pe foldere, skip `_helpers`/non-.ts,
   validare căi, concatenare helperi cu dedup import, folder API.
   `gofmt -l cmd internal` curat.
2. UI craft gate (rulat de subagentul din Faza 4):
   `node ~/.agents/skills/impeccable/scripts/detect.mjs --json web/src/main.tsx web/src/styles.css` → `[]`.
3. `cd web && npm run build`; `rm -rf ../cmd/devbox-manager/web && cp -r dist ../cmd/devbox-manager/web`;
   `go build -o bin/devbox-manager ./cmd/devbox-manager`.
4. `./bin/devbox-manager service restart` + smoke test: `GET /api/recipes`
   arborat, creez rețetă scratch `selftest/os.ts` care rulează local și
   printează `await devboxOsName()` (aștept `debian` — validează injecția
   helperilor end-to-end), apoi o șterg.

## Riscuri & compromisuri

- **Ștergerea logurilor** pierde istoricul execuțiilor curente — acceptat
  explicit de owner.
- **Helperii nu mai sunt în binar**: un `data/` nou pornește cu `_helpers`
  gol; rețetele care folosesc `devbox*` au nevoie de helperii pe disk. Tool
  personal, single-host — acceptabil; helperii există în git-ul din `data/`.
- **Drag & drop = rename**: dacă editorul are conținut stălučit, PUT-ul
  trimite conținutul curent din store; serverul rescrie fișierul, nu se
  pierde nimic.
- `updated_at` = mtime: la mutare (rename) mtime nu se schimbă — acceptabil.

## Ce NU facem în această etapă

- Nu rescriem rețetele existente să folosească helperii noi.
- Nu facem rename/delete foldere din UI, nici drag & drop de foldere întregi.
- Nu adăugăm helpers marketplace / versionare specială pentru `_helpers`.
