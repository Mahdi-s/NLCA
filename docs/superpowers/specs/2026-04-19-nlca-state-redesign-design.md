# NLCA State Management Redesign

**Date:** 2026-04-19
**Status:** Spec — awaiting implementation plan
**Owner:** Mahdi

## Problem

The current NLCA state architecture has three observable problems:

1. **Switching experiments feels clunky.** When grid dimensions differ between experiments, the canvas does not auto-fit the camera to the new grid — it "plops in the middle," forcing manual zoom. Switching also flickers because a blank frame renders between stop-old and start-new.
2. **Data availability feels unreliable.** Initial load is blocking, a previously-opened experiment may require a round-trip to JSONL even though it was just displayed, and there is no loading signal while hydration is in flight.
3. **The architecture is ad-hoc.** `ExperimentManager` is instantiated inside a component via `new`, Canvas is driven imperatively via a `$effect` that pushes data through method calls, and a `setInterval(100ms)` polls Canvas for recording and buffer state. Stores use inconsistent patterns (module singletons vs class-per-component).

Goals:

- Smooth, instant-feeling experiment switching with auto-fit zoom.
- Bounded memory use with an LRU cache as grid sizes grow.
- A single, production-quality state layer: reactive end-to-end, one source of truth per concern, no polling, no imperative state pushes.

## Non-goals

- Collapsing the three persistence layers (CSV, SQLite-wasm index, JSONL). Each serves a distinct purpose and all are retained.
- Redesigning the WebGPU renderer or the `Simulation` class.
- Changing the experiment data model (`Experiment` shape stays the same aside from cache-eviction fields).
- Supporting multiple parallel *app sessions* (multiple full UIs side-by-side). Running multiple *experiments* concurrently is supported — in fact, it is the core use case.

## Design decisions (confirmed with user)

| Question | Choice | Rationale |
|---|---|---|
| Scope | Full state-management rework | User explicitly asked for ground-up redesign. |
| Switch UX | Smooth zoom + crossfade + skeleton when uncached | Only option that handles the "data isn't there yet" case. Degrades to snap under `prefers-reduced-motion`. |
| Grid cache | LRU, N=5 | Bounded memory as grid sizes grow; keeps common switch latency at zero. |
| Store pattern | Module-level `$state` singleton | Matches existing `simulation.svelte.ts`, `modalManager.svelte.ts`, `nlcaSettings.svelte.ts`. One mental model app-wide. |

## Architecture

### Store: `src/lib/stores/nlcaStore.svelte.ts`

Module-level `$state` singleton. Exports `getNlcaStore()` accessor. Replaces the class-in-component `ExperimentManager`.

**Owned state:**

| Field | Type | Purpose |
|---|---|---|
| `experiments` | `$state<Record<string, Experiment>>` | All known experiments keyed by id |
| `activeId` | `$state<string \| null>` | The experiment the UI is showing |
| `hydration` | `$state<Record<string, HydrationState>>` | Per-experiment load state (`idle` / `loading` / `ready` / `missing`) |
| `playback` | `$state<PlaybackState \| null>` | Current playback loop state |
| `bufferStatus` | `$state<BufferStatus \| null>` | NLCA buffer — was polled via Canvas getter |
| `batchRunTarget` | `$state<number>` | NLCA batch run target — was polled |
| `batchRunCompleted` | `$state<number>` | NLCA batch run progress — was polled |
| `sessionApiKey` | `$state<string>` | Session-only OpenRouter key (unchanged) |
| `sessionSambaNovaApiKey` | `$state<string>` | Session-only SambaNova key (unchanged) |

**Derived state:**

| Field | Computed from | Consumers |
|---|---|---|
| `active` | `experiments[activeId]` | Canvas, HUD, panel |
| `experimentList` | `Object.values(experiments)` | Experiment panel |

**Internal state (not exported):**

| Field | Purpose |
|---|---|
| `lastAccessedAt: Map<string, number>` | LRU tracking for grid cache |
| `rehydrateToken: number` | Supersession token for in-flight hydrations |
| `playbackToken: number` | Supersession token for playback loop (unchanged from today) |
| `playbackCancelAnim: (() => void) \| null` | Per-frame animation cancel hook (unchanged) |
| `computeAbortControllers: Map<string, AbortController>` | Per-experiment compute loop abort (unchanged) |
| `loaded: boolean` | Guard so `loadFromIndex()` is idempotent |

**Public actions (unchanged API surface from today):**

- `createExperiment(config, autoStart)` — returns new id
- `startExperiment(id)` / `pauseExperiment(id)` / `resumeExperiment(id)`
- `extendExperiment(id, additionalFrames)`
- `deleteExperiment(id)`
- `setActive(id)` — with new hydration + LRU semantics (see below)
- `seekToGeneration(id, generation)`
- `startPlayback(...)` / `pausePlayback()` / `resumePlayback()` / `stopPlayback()`
- `loadFromIndex()` — idempotent, guarded
- `refreshEstimatedCost(id)`

### Persistence: `src/lib/nlca/persistence.ts`

Extracted module that hides the three-source storage layer (CSV + SQLite-wasm index + JSONL) behind a clean interface:

```ts
export interface LoadedMeta { /* metadata fields, no grid data */ }
export interface LoadedFrame {
    generation: number;
    width: number;
    height: number;
    grid01: number[];
    colorsHex: Array<string | null> | null;
    frameCount: number;
}

export async function loadAllMeta(): Promise<LoadedMeta[]>;
export async function loadFrame(id: string, generation?: number): Promise<LoadedFrame | null>;
export async function syncMeta(exp: Experiment, extra?: { errorMessage?: string }): Promise<void>;
export async function syncFrame(runId: string, frameLine: string): Promise<void>;
export async function deleteExperiment(id: string): Promise<void>;
```

Internally:

- `loadAllMeta` merges CSV → SQLite index → JSONL meta (same priority as today's `loadFromCsvIfPresent` + `index.list`).
- `loadFrame` tries SQLite tape → JSONL tape (same as today's seek logic).
- `syncMeta` fans out to CSV + JSONL + SQLite, all fire-and-forget.
- `syncFrame` appends to JSONL, fire-and-forget.
- `deleteExperiment` removes from all three layers.

The store never imports `tape`, `ExperimentIndex`, or directly calls `/api/nlca-runs-csv` or `/api/nlca-frames-jsonl`. All persistence calls go through this one module.

### Canvas: reactive, not pushed

Canvas imports `getNlcaStore()` directly. Three scoped `$effect`s replace the imperative `canvas.setExperimentGrid(...)` push pattern.

**Effect 1 — Dimensions & auto-fit:**

```ts
$effect(() => {
    const active = store.active;
    if (!active || !simulation) return;
    const { gridWidth: w, gridHeight: h } = active.config;
    const dimsChanged = simState.gridWidth !== w || simState.gridHeight !== h;
    if (dimsChanged) resize(w, h);
    // Refit on dimension change OR active-id change:
    simulation.resetView(canvasWidth, canvasHeight, !prefersReducedMotion());
});
```

This is the fix for "plops in the middle." `simulation.resetView()` already has correct fit math in `calculateFitView()` at `packages/@games-of-life/webgpu/src/simulation.ts:1832`. It was never being called on experiment switch.

**Effect 2 — Grid data:**

```ts
$effect(() => {
    const active = store.active;
    if (!active || store.playback) return; // playback drives canvas directly
    if (!active.currentGrid) return;
    simulation.setCellData(active.currentGrid);
    if (nlcaUseCellColors && active.currentColorsHex && active.currentColorStatus8) {
        // merge packed colors — same logic as today
    }
});
```

**Effect 3 — Skeleton overlay (DOM):**

```svelte
{#if store.active && store.hydration[store.active.id] === 'loading'}
    <div class="canvas-skeleton" transition:fade={{ duration: 150 }} />
{/if}
```

DOM-level shimmer positioned absolutely over the WebGPU canvas. Cheaper than rendering loading state in WebGPU. No spinner, no text — a subtle sweep.

### Hydration lifecycle

State machine per experiment id:

```
                 setActive(id)
         ┌─────────────────────────┐
         │                         │
         ▼                         │
      idle ──── fetch ───▶ loading ───┬──▶ ready    (grid arrives)
         ▲                            │
         │                            └──▶ missing  (no tape on disk)
         │
      (evicted from cache)
```

`setActive(id)` pseudocode:

```ts
async setActive(id: string): Promise<void> {
    if (!(id in experiments)) return;
    if (playback) stopPlayback();

    activeId = id;
    lastAccessedAt.set(id, Date.now());
    const exp = experiments[id];

    // Fast path: grid already in memory (running, cached, or freshly hydrated)
    if (exp.currentGrid) {
        hydration[id] = 'ready';
        enforceLruBudget();
        return;
    }

    // Slow path: hydrate from JSONL, show skeleton
    hydration[id] = 'loading';
    const token = ++rehydrateToken;
    try {
        const frame = await persistence.loadFrame(id);
        if (rehydrateToken !== token) return; // superseded
        if (!frame) {
            hydration[id] = 'missing';
            exp.noTapeData = true;
            return;
        }
        applyFrameToExperiment(exp, frame);
        hydration[id] = 'ready';
        enforceLruBudget();
    } catch (err) {
        if (rehydrateToken !== token) return;
        hydration[id] = 'missing';
        console.warn(`[nlcaStore] hydrate ${id} failed:`, err);
    }
}
```

### LRU cache

Capacity: **5 evictable experiments**.

**Pinned (never counted, never evicted):**
- The `activeId` experiment.
- Any experiment with `status === 'running'` (compute loop writes `currentGrid` every step).

**Eviction trigger:** end of `setActive()` fast path and end of slow path (post-hydrate).

**Eviction:**

```ts
function enforceLruBudget() {
    const evictable = Object.values(experiments)
        .filter(e => e.currentGrid != null && e.id !== activeId && e.status !== 'running')
        .sort((a, b) => (lastAccessedAt.get(a.id) ?? 0) - (lastAccessedAt.get(b.id) ?? 0));
    while (evictable.length > 5) {
        const victim = evictable.shift()!;
        victim.currentGrid = null;
        victim.currentColorsHex = null;
        victim.currentColorStatus8 = null;
        hydration[victim.id] = 'idle';
    }
}
```

### Polling removal

Today: `MainAppNlca.svelte:239-248` runs `setInterval(..., 100ms)` polling `canvas.getIsRecording()`, `getNlcaBufferStatus()`, `getNlcaBatchRunTarget()`, `getNlcaBatchRunCompleted()`.

After: Canvas writes these values directly to stores on change. Readers subscribe reactively. The `setInterval` is deleted.

| Polled value | New home |
|---|---|
| `isRecording` | `simState.isRecording` (added to existing `simulation.svelte.ts`) |
| `nlcaBufferStatus` | `nlcaStore.bufferStatus` |
| `nlcaBatchRunTarget` | `nlcaStore.batchRunTarget` |
| `nlcaBatchRunCompleted` | `nlcaStore.batchRunCompleted` |

Canvas's local `$state` versions of these are removed; the Canvas function bodies (`startRecording`, `toggleRecording`, batch run callbacks) mutate the store fields directly.

### Data flow diagrams

**Before — switching experiments:**

```
User clicks exp B in panel
  → panel calls experimentManager.setActive(B)
  → activeId flips to B
  → MainAppNlca $effect re-runs:
      reads active
      calls canvas.setExperimentGrid(grid, w, h, colors, status)
  → Canvas method resizes if dims differ (no refit)
  → Canvas calls simulation.setCellData
  → simState.gridWidth/Height mutated
  → Grid renders at old camera position ("plops in middle")
```

**After:**

```
User clicks exp B in panel
  → panel calls store.setActive(B)
  → store flips activeId, marks hydration[B] = 'ready' (fast) or 'loading' (slow)
  → LRU eviction runs
  → [Canvas] Effect 1 re-runs: dims change → resize + resetView (with animation)
  → [Canvas] Effect 2 re-runs: grid populated → setCellData
  → [Canvas] Effect 3 toggles skeleton overlay based on hydration[B]
  → User sees grid fade in at correctly-fitted zoom
```

## Migration plan

Each step is a self-contained commit that leaves the app in a working state.

### Step 1 — Extract persistence module
Move CSV/SQLite/JSONL glue out of `experimentManager.svelte.ts` into `src/lib/nlca/persistence.ts`. Zero behavior change. `ExperimentManager` methods now call `persistence.loadAllMeta()`, `persistence.syncMeta()`, etc. Purely a refactor; all existing tests continue to pass.

### Step 2 — Create `nlcaStore.svelte.ts` singleton
New file, exports `getNlcaStore()`. Internally wraps a single private `ExperimentManager` instance. Update `MainAppNlca.svelte:47` to read `getNlcaStore()` instead of `new ExperimentManager()`. Any other component that would have needed `experimentManager` props now imports directly. Behavior identical.

### Step 3 — Canvas reactivity
Canvas imports `getNlcaStore()`. Add Effect 1 (dimensions + auto-fit) and Effect 2 (grid data). Delete `canvas.setExperimentGrid(...)` and `canvas.clearExperimentGrid(...)` from Canvas's public API and the corresponding `$effect` + `lastRendered*` tracking in `MainAppNlca.svelte:77-113`. **Auto-fit starts working here.**

### Step 4 — Hydration state + skeleton
Add `hydration: Record<id, HydrationState>` to the store. Rewrite `setActive()` per the pseudocode above. Add the skeleton DOM element in Canvas (Effect 3). The switching UX is now polished.

### Step 5 — LRU cache
Add `lastAccessedAt` and `enforceLruBudget()`. Evict grids beyond the 5-slot budget at the end of each `setActive()` path. Extract the `applyFrameToExperiment()` helper used by both the hydration path and `seekToGeneration`.

### Step 6 — Polling removal
Add `isRecording` to `simState`; add `bufferStatus`, `batchRunTarget`, `batchRunCompleted` to `nlcaStore`. Update Canvas to mutate them directly. Delete `setInterval` in `MainAppNlca.svelte:239`. Delete `canvas.getIsRecording()` / `getNlcaBufferStatus()` / etc. methods (consumers now subscribe to the stores).

### Step 7 — Housekeeping
Collapse `ExperimentManager` class into the store module — it has been a thin wrapper since Step 2. Delete the now-redundant `rehydrateToken` Map (replaced by the hydration state machine). Clean up imports.

## Testing strategy

### Unit tests (vitest)

- **Persistence:**
  - `loadAllMeta` with mocked fetch for CSV, SQLite, JSONL — verify merge priority.
  - `loadFrame` — SQLite hit, SQLite miss → JSONL hit, both miss → null.
- **Store actions:**
  - `createExperiment` — new id, added to registry, autoStart starts compute.
  - `setActive` fast path — grid present → hydration flips to 'ready' without fetch.
  - `setActive` slow path — grid absent → loading → ready on fetch resolve.
  - `setActive` missing — grid absent + no JSONL → marks `missing`.
  - `enforceLruBudget` — pinned (active + running) never evicted; oldest non-pinned evicted first.
  - `deleteExperiment` when active — activeId falls through to another experiment.

### Manual verification (preview_start)

- Switch between 5×5 and 30×30 experiments → camera smoothly animates to new fit-zoom.
- Switch to a non-cached experiment → skeleton shows briefly, then grid fades in.
- Open 10 experiments, switch back to the first → skeleton + rehydrate.
- `prefers-reduced-motion: reduce` → fit snaps instead of animating.
- Run two experiments concurrently → switch between them → instant (both pinned).
- Start recording → control buttons update without delay (no polling interval).
- Start batch run → modal progress updates live.

## Acceptance criteria

- [ ] Switching experiments with differing grid sizes auto-fits the camera.
- [ ] Switching to an un-cached experiment shows a skeleton instead of blank or ghosted canvas.
- [ ] Two experiments can be running in parallel; switching between them is instant.
- [ ] No `setInterval` remains in `MainAppNlca.svelte`.
- [ ] `ExperimentManager` is not instantiated via `new` inside any component.
- [ ] Opening 20 experiments and switching through them leaves at most `5 + runningCount` grids hydrated.
- [ ] All existing functionality works identically: create, pause, resume, extend, delete, playback, seek, batch run, recording, cost estimation.
- [ ] `prefers-reduced-motion` honored on auto-fit.
- [ ] `npm run check` passes.
- [ ] `npm test` passes (existing + new unit tests).

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| LRU eviction nulls a grid while a consumer still reads it | Low | Eviction only runs inside `setActive()` (synchronous with active change). Canvas $effect re-reads `active.currentGrid` reactively — evicted non-active experiments are not rendered. |
| Hydration state desyncs with `currentGrid` field | Medium | Single chokepoint: only `setActive()` and `seekToGeneration()` mutate both. Unit tests cover transitions. |
| Running experiment unexpectedly transitions to 'paused' but compute-loop writes continue | Low | `pauseExperiment()` aborts the controller synchronously before flipping status. Existing behavior preserved. |
| Persistence extraction changes load order | Medium | Step 1 is a pure refactor — port the existing priority logic (CSV → SQLite index → JSONL) unchanged. Covered by manual verification on first boot with existing on-disk data. |
| Canvas `$effect` fires before `simulation` is initialized | Low | Effects guard on `simulation` / `ctx`, same as current imperative code. |

## Open questions

None — all design choices confirmed with user.

## Out of scope (for future work)

- Collapsing the three persistence layers. Each is kept for good reason (human-readable CSV, reload-resistant JSONL, fast in-memory SQLite); unifying them would lose capability.
- Virtualization of the experiment list (if list grows past ~200 items).
- Background prefetch of grids the user is likely to switch to (e.g., prefetch the experiment immediately above/below the active one in the panel).
- Server-side persistence for sharing experiments across devices.
