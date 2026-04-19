# NLCA State Management Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild NLCA state management as a production-quality reactive singleton store with auto-fit camera on experiment switch, LRU grid cache, skeleton loading, and no polling loops.

**Architecture:** One module-level `$state` singleton (`nlcaStore.svelte.ts`) replaces the class-instantiated-in-component `ExperimentManager`. Persistence is hidden behind a dedicated `persistence.ts` module. Canvas subscribes reactively to the store via three scoped `$effect`s; imperative `canvas.setExperimentGrid(...)` pushes are deleted. A hydration state machine + LRU eviction (N=5) governs grid memory.

**Tech Stack:** Svelte 5 (`$state`, `$derived`, `$effect`), TypeScript, Vitest (tests), WebGPU (renderer), SvelteKit.

**Spec:** [2026-04-19-nlca-state-redesign-design.md](../specs/2026-04-19-nlca-state-redesign-design.md)

---

## File Structure

**Create:**
- `src/lib/nlca/persistence.ts` — single module hiding CSV + SQLite-wasm index + JSONL behind one interface.
- `src/lib/nlca/persistence.test.ts` — vitest unit tests for the persistence module (mocked `fetch`).
- `src/lib/stores/nlcaStore.svelte.ts` — module-level `$state` singleton wrapping the experiment manager.
- `src/lib/stores/nlcaStore.test.ts` — vitest unit tests for store actions (setActive, LRU eviction, hydration transitions).
- `src/lib/utils/motion.ts` — small util exporting `prefersReducedMotion()`.

**Modify:**
- `src/lib/nlca/experimentManager.svelte.ts` — shrink to reference `persistence.ts`; drop direct CSV/SQLite/JSONL calls.
- `src/lib/components/MainAppNlca.svelte` — use `getNlcaStore()`; drop imperative canvas pushes; delete `setInterval` polling.
- `src/lib/components/Canvas.svelte` — add three `$effect`s subscribing to store; delete `setExperimentGrid` / `clearExperimentGrid` / `getIsRecording` / `getNlcaBufferStatus` / `getNlcaBatchRunTarget` / `getNlcaBatchRunCompleted`; write to stores directly instead of exposing getters.
- `src/lib/components/NlcaExperimentPanel.svelte` — read `getNlcaStore()` instead of `manager` prop.
- `src/lib/stores/simulation.svelte.ts` — add `isRecording` to `simState`.

**Delete (end of Task 10):**
- None — `experimentManager.svelte.ts` is kept as a private implementation detail of `nlcaStore.svelte.ts`.

---

## Task 1: Extract persistence module — test scaffold

**Goal:** Write failing vitest tests for the new `persistence.ts` module. Green-field TDD for a clean persistence API.

**Files:**
- Create: `src/lib/nlca/persistence.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/nlca/persistence.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Experiment } from './experimentManager.svelte.js';
import * as persistence from './persistence.js';

type FetchArgs = Parameters<typeof fetch>;

describe('persistence.loadAllMeta', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('returns CSV rows when CSV endpoint succeeds', async () => {
        fetchMock.mockImplementation((url: FetchArgs[0]) => {
            const u = String(url);
            if (u.includes('/api/nlca-runs-csv')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        rows: [{ id: 'exp-1', label: 'From CSV', model: 'gpt', gridWidth: '10', gridHeight: '10', neighborhood: 'moore', frameCount: '5', targetFrames: '50', createdAt: '1000', totalCost: '0.01', status: 'paused', dbFilename: '/exp-1.sqlite3' }]
                    })
                } as Response);
            }
            return Promise.resolve({ ok: false } as Response);
        });

        const metas = await persistence.loadAllMeta();
        expect(metas).toHaveLength(1);
        expect(metas[0].id).toBe('exp-1');
        expect(metas[0].label).toBe('From CSV');
    });

    test('returns empty array when CSV endpoint fails', async () => {
        fetchMock.mockResolvedValue({ ok: false } as Response);
        const metas = await persistence.loadAllMeta();
        expect(metas).toEqual([]);
    });
});

describe('persistence.loadFrame', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('returns latest frame from JSONL when no generation given', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                latest: {
                    generation: 7,
                    width: 5,
                    height: 5,
                    grid01: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
                    colorsHex: null
                },
                frameCount: 7
            })
        } as Response);

        const frame = await persistence.loadFrame('exp-1');
        expect(frame).not.toBeNull();
        expect(frame!.generation).toBe(7);
        expect(frame!.width).toBe(5);
        expect(frame!.frameCount).toBe(7);
    });

    test('returns specific frame when generation given', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                frame: { generation: 3, width: 5, height: 5, grid01: new Array(25).fill(0), colorsHex: null },
                frameCount: 10
            })
        } as Response);

        const frame = await persistence.loadFrame('exp-1', 3);
        expect(frame!.generation).toBe(3);
        expect(frame!.frameCount).toBe(10);
    });

    test('returns null when fetch fails', async () => {
        fetchMock.mockResolvedValue({ ok: false } as Response);
        const frame = await persistence.loadFrame('exp-1');
        expect(frame).toBeNull();
    });
});

describe('persistence.syncMeta', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response);
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('posts to both CSV and JSONL endpoints (fire-and-forget)', async () => {
        const exp = {
            id: 'exp-1',
            label: 'Test',
            config: { apiProvider: 'openrouter' as const, model: 'm', gridWidth: 10, gridHeight: 10, neighborhood: 'moore' as const, cellColorEnabled: false, taskDescription: 't', useAdvancedMode: false, memoryWindow: 3, maxConcurrency: 50, batchSize: 200, frameBatched: true, frameStreamed: true, cellTimeoutMs: 30000, compressPayload: false, deduplicateRequests: false, targetFrames: 50, apiKey: '', sambaNovaApiKey: '', temperature: 0, maxOutputTokens: 64 },
            status: 'running' as const,
            progress: { current: 5, target: 50 },
            createdAt: 1000,
            dbFilename: '/exp-1.sqlite3',
            totalCost: 0.01
        } as unknown as Experiment;

        await persistence.syncMeta(exp);

        // Fire-and-forget, but the function should attempt both endpoints
        const urls = fetchMock.mock.calls.map((call: FetchArgs) => String(call[0]));
        expect(urls.some((u: string) => u.includes('/api/nlca-runs-csv'))).toBe(true);
        expect(urls.some((u: string) => u.includes('/api/nlca-frames-jsonl'))).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- src/lib/nlca/persistence.test.ts`

Expected: FAIL — `Cannot find module './persistence.js'` or `persistence` exports undefined.

- [ ] **Step 3: Commit the failing tests**

```bash
git add src/lib/nlca/persistence.test.ts
git commit -m "test(nlca): failing tests for persistence module"
```

---

## Task 2: Extract persistence module — implementation

**Goal:** Create the `persistence.ts` module that makes Task 1's tests pass. Copy the CSV/SQLite/JSONL logic from `experimentManager.svelte.ts` verbatim, but packaged behind the clean API.

**Files:**
- Create: `src/lib/nlca/persistence.ts`
- Modify: `src/lib/nlca/experimentManager.svelte.ts` — delegate to `persistence.ts`

- [ ] **Step 1: Create `src/lib/nlca/persistence.ts`**

Create the module. The existing private methods in `experimentManager.svelte.ts` (`syncCsvRow`, `syncJsonlMeta`, `appendJsonlFrame`, `fetchJsonlFrame`, `loadFromCsvIfPresent`, `deleteCsvRow`, `deleteJsonlRun`) become the implementation; the public exports are the clean interface.

```ts
/**
 * persistence — single module hiding the three NLCA storage layers
 * (CSV, SQLite-wasm index, JSONL tape) behind one interface.
 *
 * Storage layer roles:
 *   - CSV  /api/nlca-runs-csv       → human-readable, grep/Excel friendly
 *   - SQLite-wasm ExperimentIndex   → fast in-memory query path during a session
 *   - JSONL /api/nlca-frames-jsonl  → authoritative on-disk frames + meta
 *
 * The store never touches these layers directly; it calls this module.
 */

import type { Experiment } from './experimentManager.svelte.js';
import type { ExperimentConfig, ExperimentMeta } from './types.js';
import { redactExperimentConfigForPersistence } from './types.js';
import { NlcaTape, ExperimentIndex } from './tape.js';

export interface LoadedMeta {
    id: string;
    label: string;
    config: ExperimentConfig;
    status: ExperimentMeta['status'];
    dbFilename: string;
    createdAt: number;
    frameCount: number;
    totalCost: number;
    errorMessage?: string;
}

export interface LoadedFrame {
    generation: number;
    width: number;
    height: number;
    grid01: number[];
    colorsHex: Array<string | null> | null;
    frameCount: number;
}

const index = new ExperimentIndex();
let indexInitialized = false;

async function ensureIndex(): Promise<void> {
    if (indexInitialized) return;
    await index.init();
    indexInitialized = true;
}

function parseCsvRow(row: Record<string, string>): LoadedMeta | null {
    if (!row.id) return null;
    const config: ExperimentConfig = {
        apiKey: '',
        sambaNovaApiKey: '',
        apiProvider: (row.apiProvider as 'openrouter' | 'sambanova') || 'openrouter',
        model: row.model || '',
        temperature: 0,
        maxOutputTokens: 64,
        gridWidth: Number(row.gridWidth) || 10,
        gridHeight: Number(row.gridHeight) || 10,
        neighborhood: (row.neighborhood as ExperimentConfig['neighborhood']) || 'moore',
        cellColorEnabled: row.cellColorEnabled === 'true',
        taskDescription: row.taskDescription ?? '',
        useAdvancedMode: false,
        memoryWindow: Number(row.memoryWindow) || 0,
        maxConcurrency: Number(row.maxConcurrency) || 50,
        batchSize: Number(row.batchSize) || 200,
        frameBatched: row.frameBatched === 'true',
        frameStreamed: row.frameStreamed === 'true',
        cellTimeoutMs: 30_000,
        compressPayload: row.compressPayload === 'true',
        deduplicateRequests: row.deduplicateRequests === 'true',
        targetFrames: Number(row.targetFrames) || 50
    };
    const statusRaw = (row.status as ExperimentMeta['status']) || 'paused';
    const status = statusRaw === 'running' ? 'paused' : statusRaw;
    return {
        id: row.id,
        label: row.label || row.id,
        config,
        status,
        dbFilename: row.dbFilename || `/${row.id}.sqlite3`,
        createdAt: Number(row.createdAt) || Date.now(),
        frameCount: Number(row.frameCount) || 0,
        totalCost: Number(row.totalCost) || 0,
        errorMessage: row.errorMessage || undefined
    };
}

export async function loadAllMeta(): Promise<LoadedMeta[]> {
    const fromCsv: LoadedMeta[] = [];
    try {
        const res = await fetch('/api/nlca-runs-csv');
        if (res.ok) {
            const data = (await res.json()) as { rows?: Array<Record<string, string>> };
            for (const row of data?.rows ?? []) {
                const parsed = parseCsvRow(row);
                if (parsed) fromCsv.push(parsed);
            }
        }
    } catch {
        /* CSV unavailable in production builds — fall through */
    }

    // Merge SQLite index entries that aren't in the CSV set.
    try {
        await ensureIndex();
        const metas = await index.list();
        const seen = new Set(fromCsv.map((m) => m.id));
        for (const meta of metas) {
            if (seen.has(meta.id)) continue;
            fromCsv.push({
                id: meta.id,
                label: meta.label,
                config: meta.config,
                status: meta.status === 'running' ? 'paused' : meta.status,
                dbFilename: meta.dbFilename,
                createdAt: meta.createdAt,
                frameCount: meta.frameCount,
                totalCost: meta.totalCost ?? 0,
                errorMessage: meta.errorMessage
            });
        }
    } catch {
        /* SQLite miss is fine — CSV was primary */
    }

    return fromCsv;
}

export async function loadFrame(id: string, generation?: number): Promise<LoadedFrame | null> {
    try {
        const qs = new URLSearchParams({ runId: id });
        if (generation !== undefined) qs.set('generation', String(generation));
        const res = await fetch(`/api/nlca-frames-jsonl?${qs.toString()}`);
        if (!res.ok) return null;
        const data = await res.json();
        const chosen = generation !== undefined ? data?.frame : data?.latest;
        if (!chosen) return null;
        return {
            generation: chosen.generation,
            width: chosen.width,
            height: chosen.height,
            grid01: chosen.grid01,
            colorsHex: chosen.colorsHex,
            frameCount: data.frameCount ?? 0
        };
    } catch {
        return null;
    }
}

export async function syncMeta(exp: Experiment, extra?: { errorMessage?: string }): Promise<void> {
    // Fire-and-forget CSV write.
    try {
        await fetch('/api/nlca-runs-csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: exp.id,
                label: exp.label,
                apiProvider: exp.config.apiProvider ?? 'openrouter',
                model: exp.config.model,
                gridWidth: exp.config.gridWidth,
                gridHeight: exp.config.gridHeight,
                neighborhood: exp.config.neighborhood,
                cellColorEnabled: exp.config.cellColorEnabled ? 'true' : 'false',
                taskDescription: exp.config.taskDescription,
                memoryWindow: exp.config.memoryWindow,
                maxConcurrency: exp.config.maxConcurrency,
                batchSize: exp.config.batchSize,
                frameBatched: exp.config.frameBatched ? 'true' : 'false',
                frameStreamed: exp.config.frameStreamed ? 'true' : 'false',
                compressPayload: exp.config.compressPayload ? 'true' : 'false',
                deduplicateRequests: exp.config.deduplicateRequests ? 'true' : 'false',
                targetFrames: exp.config.targetFrames,
                status: exp.status,
                frameCount: exp.progress.current,
                totalCost: String(exp.totalCost ?? 0),
                createdAt: exp.createdAt,
                updatedAt: Date.now(),
                dbFilename: exp.dbFilename,
                errorMessage: extra?.errorMessage ?? exp.errorMessage ?? ''
            })
        });
    } catch (err) {
        if (typeof window !== 'undefined') console.debug('[persistence] CSV sync skipped:', err);
    }

    // Fire-and-forget JSONL meta write.
    try {
        await fetch('/api/nlca-frames-jsonl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                runId: exp.id,
                meta: {
                    id: exp.id,
                    label: exp.label,
                    status: exp.status,
                    progress: exp.progress,
                    createdAt: exp.createdAt,
                    updatedAt: Date.now(),
                    dbFilename: exp.dbFilename,
                    errorMessage: exp.errorMessage ?? null,
                    config: redactExperimentConfigForPersistence(exp.config)
                }
            })
        });
    } catch (err) {
        if (typeof window !== 'undefined') console.debug('[persistence] JSONL meta sync skipped:', err);
    }

    // SQLite index mirror.
    try {
        await ensureIndex();
        await index.updateStatus(
            exp.id,
            exp.status,
            exp.progress.current,
            extra?.errorMessage ?? exp.errorMessage,
            exp.totalCost
        );
    } catch (err) {
        if (typeof window !== 'undefined') console.debug('[persistence] SQLite index sync skipped:', err);
    }
}

export async function syncFrame(runId: string, frameLine: string): Promise<void> {
    try {
        await fetch('/api/nlca-frames-jsonl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId, frame: frameLine })
        });
    } catch (err) {
        if (typeof window !== 'undefined') console.debug('[persistence] JSONL frame sync skipped:', err);
    }
}

export async function registerMeta(exp: Experiment): Promise<void> {
    await ensureIndex();
    await index.register({
        id: exp.id,
        label: exp.label,
        dbFilename: exp.dbFilename,
        config: redactExperimentConfigForPersistence(exp.config),
        status: exp.status,
        createdAt: exp.createdAt,
        updatedAt: Date.now(),
        frameCount: exp.progress.current,
        totalCost: exp.totalCost
    });
}

export async function deleteExperiment(id: string): Promise<void> {
    try {
        await ensureIndex();
        await index.delete(id);
    } catch { /* ignore */ }
    try {
        await fetch(`/api/nlca-runs-csv?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch { /* ignore */ }
    try {
        await fetch(`/api/nlca-frames-jsonl?runId=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch { /* ignore */ }
}

export function newTape(dbFilename: string): NlcaTape {
    return new NlcaTape(dbFilename);
}
```

- [ ] **Step 2: Run persistence tests to verify they pass**

Run: `npm test -- src/lib/nlca/persistence.test.ts`

Expected: PASS (all 5 tests green).

- [ ] **Step 3: Wire `experimentManager.svelte.ts` to use persistence**

Replace the private persistence methods in `experimentManager.svelte.ts` with calls to the new module. Use Edit to replace the bodies of:

- `syncCsvRow` → `await persistence.syncMeta(exp, extra)` (drops CSV+JSONL+SQLite calls — `syncMeta` already covers all three)
- `deleteCsvRow` / `deleteJsonlRun` → delete methods; replace all call sites with `await persistence.deleteExperiment(id)` (once, not twice)
- `syncJsonlMeta` → delete; `syncCsvRow` replacement already covers it
- `appendJsonlFrame` → `await persistence.syncFrame(id, frameLine)`
- `fetchJsonlFrame` → `await persistence.loadFrame(id, generation)`
- `loadFromCsvIfPresent` → delete; `loadFromIndex` is rewritten below

Rewrite `loadFromIndex()`:

```ts
async loadFromIndex(): Promise<void> {
    const metas = await persistence.loadAllMeta();
    for (const meta of metas) {
        if (meta.id in this.experiments) continue;
        const tape = persistence.newTape(meta.dbFilename);
        // Defer tape.init — lazy on first seek; saves ~30ms per experiment at boot.
        const exp: Experiment = {
            id: meta.id,
            label: meta.label,
            config: meta.config,
            status: meta.status,
            stepper: null,
            tape,
            frameBuffer: null,
            agentManager: null,
            progress: { current: meta.frameCount, target: meta.config.targetFrames },
            createdAt: meta.createdAt,
            dbFilename: meta.dbFilename,
            errorMessage: meta.errorMessage,
            currentGrid: null,
            currentColorsHex: null,
            currentColorStatus8: null,
            currentGeneration: 0,
            bufferStatus: null,
            totalCost: meta.totalCost,
            estimatedCost: 0,
            pricingUnknown: true,
            totalCalls: 0,
            lastLatencyMs: null
        };
        this.experiments[meta.id] = exp;
        this.experimentCounter++;
        void this.refreshEstimatedCost(meta.id);
    }
}
```

Remove the private field `private index: ExperimentIndex` and its uses; persistence owns it now. Add `import * as persistence from './persistence.js';` at the top.

Replace `await this.index.register({...})` in `createExperiment` with `await persistence.registerMeta(exp)`.

Replace `await this.index.updateStatus(...)` calls with `await persistence.syncMeta(exp, ...)` (the updates propagate through CSV+JSONL+SQLite uniformly).

- [ ] **Step 4: Run full test suite**

Run: `npm test`

Expected: PASS. `prompt.test.ts` and `neighborhood.test.ts` unchanged. `persistence.test.ts` green.

- [ ] **Step 5: Type-check**

Run: `npm run check`

Expected: no errors. Fix any type mismatches surfaced by the refactor (most likely around the removed `index` field).

- [ ] **Step 6: Commit**

```bash
git add src/lib/nlca/persistence.ts src/lib/nlca/experimentManager.svelte.ts
git commit -m "refactor(nlca): extract CSV/SQLite/JSONL into persistence module"
```

---

## Task 3: Singleton store module

**Goal:** Create `nlcaStore.svelte.ts` as a module-level singleton that wraps a single `ExperimentManager` instance. Migrate all consumers to import the store instead of instantiating the manager.

**Files:**
- Create: `src/lib/stores/nlcaStore.svelte.ts`
- Modify: `src/lib/components/MainAppNlca.svelte`
- Modify: `src/lib/components/NlcaExperimentPanel.svelte`

- [ ] **Step 1: Create the singleton module**

Create `src/lib/stores/nlcaStore.svelte.ts`:

```ts
/**
 * nlcaStore — module-level singleton that owns all NLCA session state.
 *
 * Pattern matches simulation.svelte.ts and modalManager.svelte.ts — import the
 * accessor, get the same instance everywhere. Replaces the
 * new-ExperimentManager-inside-a-component pattern.
 */

import { ExperimentManager } from '$lib/nlca/experimentManager.svelte.js';

let instance: ExperimentManager | null = null;

export function getNlcaStore(): ExperimentManager {
    if (!instance) instance = new ExperimentManager();
    return instance;
}

/** Test-only: reset the singleton between tests. Do not call from app code. */
export function __resetNlcaStoreForTests(): void {
    instance = null;
}
```

- [ ] **Step 2: Update `MainAppNlca.svelte`**

In `src/lib/components/MainAppNlca.svelte`, replace `const experimentManager = new ExperimentManager();` on line 47 with an import:

```svelte
<script lang="ts">
    // ... other imports
    import { getNlcaStore } from '$lib/stores/nlcaStore.svelte.js';

    // ... other state
    const experimentManager = getNlcaStore();
    // (keep the variable name so downstream usage is unchanged)
```

Remove the `import { ExperimentManager } from '$lib/nlca/experimentManager.svelte.js'` line at the top — no longer needed.

- [ ] **Step 3: Update `NlcaExperimentPanel.svelte` to use the store directly**

In `src/lib/components/NlcaExperimentPanel.svelte`, replace the `manager` prop with a store import. Edit the `<script>` section:

```svelte
<script lang="ts">
    import type { Experiment } from '$lib/nlca/experimentManager.svelte.js';
    import { getNlcaStore } from '$lib/stores/nlcaStore.svelte.js';

    interface Props {
        open: boolean;
        onclose: () => void;
        onNew: () => void;
    }

    let { open, onclose, onNew }: Props = $props();
    const manager = getNlcaStore();

    // ... rest of the component unchanged
```

In `MainAppNlca.svelte`, update the `<NlcaExperimentPanel>` invocation at the bottom to drop the `manager` prop:

```svelte
<NlcaExperimentPanel
    open={showExperimentPanel}
    onclose={() => showExperimentPanel = false}
    onNew={handleNewExperiment}
/>
```

- [ ] **Step 4: Run check**

Run: `npm run check`

Expected: no errors.

- [ ] **Step 5: Manual verify — app still works**

Run: `npm run dev` and open the NLCA page. Existing flow (create experiment, pause, resume, switch, delete) should behave identically to before — no UX change is expected in this task.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stores/nlcaStore.svelte.ts src/lib/components/MainAppNlca.svelte src/lib/components/NlcaExperimentPanel.svelte
git commit -m "refactor(nlca): migrate to singleton store (getNlcaStore)"
```

---

## Task 4: Canvas Effect 1 — dimensions + auto-fit on switch

**Goal:** Add the reactive `$effect` in Canvas that watches the active experiment's dimensions and triggers auto-fit when they change or the active experiment changes. **This is where the "plops in the middle" bug gets fixed.**

**Files:**
- Create: `src/lib/utils/motion.ts`
- Modify: `src/lib/components/Canvas.svelte`

- [ ] **Step 1: Create the motion util**

Create `src/lib/utils/motion.ts`:

```ts
/** Respects the OS-level "reduce motion" preference. Returns true when the
 *  user has asked to minimize animation. Safe to call on the server (returns
 *  false). */
export function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}
```

- [ ] **Step 2: Add Effect 1 to Canvas**

In `src/lib/components/Canvas.svelte`, after the existing imports and early `let`s (around where other `$effect`s live), add:

```svelte
<script lang="ts">
    // ... existing imports
    import { getNlcaStore } from '$lib/stores/nlcaStore.svelte.js';
    import { prefersReducedMotion } from '$lib/utils/motion.js';

    // ... existing state

    const nlcaStore = getNlcaStore();

    /* Effect 1 — Dimensions + auto-fit.
     * Runs whenever the active experiment id or its grid dimensions change.
     * Resizes the simulation if needed, then refits the camera so the entire
     * grid is visible. This is what eliminates the "plops in the middle"
     * behavior on experiment switch. */
    let lastFittedExpId: string | null = null;
    $effect(() => {
        if (!nlcaMode) return;
        const active = nlcaStore.active;
        if (!active || !simulation || !ctx) return;

        const w = active.config.gridWidth;
        const h = active.config.gridHeight;
        const dimsChanged = simState.gridWidth !== w || simState.gridHeight !== h;

        if (dimsChanged) {
            resize(w, h);
        }

        if (dimsChanged || lastFittedExpId !== active.id) {
            simulation.resetView(canvasWidth, canvasHeight, !prefersReducedMotion(), 300);
            lastFittedExpId = active.id;
        }
    });
</script>
```

Place the effect inside the existing `<script lang="ts">` block, near the other effects around line 240.

- [ ] **Step 3: Run check**

Run: `npm run check`

Expected: no errors.

- [ ] **Step 4: Manual verify — auto-fit works**

Run: `npm run dev`. Create or open two experiments with different grid sizes (e.g., 10×10 and 30×30). Click to switch between them. The camera should animate smoothly to fit each grid — no more "plop in the middle."

Under `prefers-reduced-motion` (macOS: System Settings → Accessibility → Display → Reduce motion), the fit should snap instantly instead of animating.

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils/motion.ts src/lib/components/Canvas.svelte
git commit -m "feat(nlca): auto-fit camera on experiment switch"
```

---

## Task 5: Canvas Effect 2 — reactive grid data (delete imperative push)

**Goal:** Canvas subscribes to `store.active.currentGrid` directly, replacing the imperative `canvas.setExperimentGrid(...)` call from `MainAppNlca.svelte`'s `$effect`. Delete the imperative push path.

**Files:**
- Modify: `src/lib/components/Canvas.svelte`
- Modify: `src/lib/components/MainAppNlca.svelte`

- [ ] **Step 1: Add Effect 2 to Canvas**

In `src/lib/components/Canvas.svelte`, directly below Effect 1 from Task 4, add:

```svelte
    /* Effect 2 — Grid data.
     * Pushes the active experiment's grid + colors into the renderer whenever
     * they change. Skips while playback is driving the canvas directly. */
    $effect(() => {
        if (!nlcaMode) return;
        if (!simulation || !ctx) return;
        if (nlcaStore.playback) return; // playback loop drives canvas directly
        const active = nlcaStore.active;
        if (!active || !active.currentGrid) return;

        simulation.setCellData(active.currentGrid);

        if (nlcaUseCellColors && active.currentColorsHex && active.currentColorStatus8) {
            if (!nlcaCellColorsPacked || nlcaCellColorsPacked.length !== active.currentGrid.length) {
                nlcaCellColorsPacked = new Uint32Array(active.currentGrid.length);
            }
            mergePackedColors(
                nlcaCellColorsPacked,
                active.currentGrid,
                active.currentColorsHex,
                active.currentColorStatus8
            );
            simulation.setCellColorsPacked(nlcaCellColorsPacked);
        } else {
            nlcaCellColorsPacked = null;
            simulation.clearCellColors();
        }
    });
```

- [ ] **Step 2: Delete imperative push from MainAppNlca**

In `src/lib/components/MainAppNlca.svelte`, delete the `$effect` block at lines 77-113 (the block starting with `let lastRenderedExpId: string | null = null;` through the end of the effect). Also delete the unused `canvas` local variable reference if it becomes unused for this purpose — keep it since other buttons still call `canvas.clear()`, `canvas.stepOnce()`, etc.

- [ ] **Step 3: Delete the Canvas public methods that are no longer needed**

In `src/lib/components/Canvas.svelte`, delete:
- `export function setExperimentGrid(...)` (lines 1915-1937)
- `export function clearExperimentGrid(...)` (lines 1944-1953)

Leave `animateTransition` in place — playback still uses it.

- [ ] **Step 4: Run check + test**

Run in parallel: `npm run check` and `npm test`

Expected: both pass. No type errors. Any test that referenced `setExperimentGrid` should be updated or removed (likely none).

- [ ] **Step 5: Manual verify — switching still works**

Run: `npm run dev`. Create two experiments. Switch between them. Run, pause, scrub, seek — all should behave identically. The grid data now flows via the reactive effect.

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/Canvas.svelte src/lib/components/MainAppNlca.svelte
git commit -m "refactor(nlca): canvas subscribes to store (no imperative push)"
```

---

## Task 6: Hydration state machine

**Goal:** Add `hydration: Record<id, HydrationState>` to the store. Rewrite `setActive()` to use the fast/slow-path + state-machine logic from the spec.

**Files:**
- Modify: `src/lib/nlca/experimentManager.svelte.ts`
- Create: `src/lib/stores/nlcaStore.test.ts`

- [ ] **Step 1: Write failing tests for the state machine**

Create `src/lib/stores/nlcaStore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getNlcaStore, __resetNlcaStoreForTests } from './nlcaStore.svelte.js';

describe('nlcaStore hydration', () => {
    beforeEach(() => {
        __resetNlcaStoreForTests();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('setActive fast path — grid already in memory → ready', () => {
        const store = getNlcaStore();
        // Hand-craft a minimal experiment with currentGrid populated.
        store.experiments['exp-fast'] = {
            id: 'exp-fast',
            label: 't',
            config: { gridWidth: 5, gridHeight: 5 } as never,
            status: 'paused',
            stepper: null,
            tape: null as never,
            frameBuffer: null,
            agentManager: null,
            progress: { current: 1, target: 10 },
            createdAt: 0,
            dbFilename: '/x.sqlite3',
            currentGrid: new Uint32Array(25),
            currentColorsHex: null,
            currentColorStatus8: null,
            currentGeneration: 1,
            bufferStatus: null,
            totalCost: 0,
            estimatedCost: 0,
            pricingUnknown: true,
            totalCalls: 0,
            lastLatencyMs: null
        };

        store.setActive('exp-fast');
        expect(store.activeId).toBe('exp-fast');
        expect(store.hydration['exp-fast']).toBe('ready');
    });

    test('setActive slow path — missing frame → missing', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false } as Response));
        const store = getNlcaStore();

        store.experiments['exp-slow'] = {
            id: 'exp-slow',
            label: 't',
            config: { gridWidth: 5, gridHeight: 5 } as never,
            status: 'paused',
            stepper: null,
            tape: null as never,
            frameBuffer: null,
            agentManager: null,
            progress: { current: 1, target: 10 },
            createdAt: 0,
            dbFilename: '/x.sqlite3',
            currentGrid: null,
            currentColorsHex: null,
            currentColorStatus8: null,
            currentGeneration: 0,
            bufferStatus: null,
            totalCost: 0,
            estimatedCost: 0,
            pricingUnknown: true,
            totalCalls: 0,
            lastLatencyMs: null
        };

        store.setActive('exp-slow');
        expect(store.hydration['exp-slow']).toBe('loading');

        // Wait for rehydrate promise chain to settle
        await new Promise((r) => setTimeout(r, 10));
        expect(store.hydration['exp-slow']).toBe('missing');
    });

    test('setActive supersedes previous hydration when user clicks fast', async () => {
        let resolveFirst: (v: unknown) => void = () => {};
        const firstPromise = new Promise((r) => { resolveFirst = r; });
        const fetchMock = vi.fn()
            .mockReturnValueOnce(firstPromise)
            .mockResolvedValueOnce({ ok: false } as Response);
        vi.stubGlobal('fetch', fetchMock);

        const store = getNlcaStore();
        const mkExp = (id: string) => ({
            id, label: 't', config: { gridWidth: 5, gridHeight: 5 } as never,
            status: 'paused' as const, stepper: null, tape: null as never, frameBuffer: null,
            agentManager: null, progress: { current: 1, target: 10 }, createdAt: 0,
            dbFilename: '/x.sqlite3', currentGrid: null, currentColorsHex: null,
            currentColorStatus8: null, currentGeneration: 0, bufferStatus: null,
            totalCost: 0, estimatedCost: 0, pricingUnknown: true, totalCalls: 0,
            lastLatencyMs: null
        });
        store.experiments['a'] = mkExp('a');
        store.experiments['b'] = mkExp('b');

        store.setActive('a'); // kicks off first fetch
        store.setActive('b'); // supersedes
        expect(store.activeId).toBe('b');

        // Resolve the stale first fetch with a frame — should not affect 'a' hydration
        resolveFirst({
            ok: true,
            json: () => Promise.resolve({
                latest: { generation: 1, width: 5, height: 5, grid01: new Array(25).fill(0), colorsHex: null },
                frameCount: 1
            })
        });
        await new Promise((r) => setTimeout(r, 20));

        // 'a' hydration should NOT be 'ready' (superseded before resolve)
        expect(store.hydration['a']).not.toBe('ready');
    });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npm test -- src/lib/stores/nlcaStore.test.ts`

Expected: FAIL — `hydration` property is undefined on the manager.

- [ ] **Step 3: Add hydration state to the manager**

In `src/lib/nlca/experimentManager.svelte.ts`, inside the `ExperimentManager` class, add a new field next to the existing `$state` fields:

```ts
export type HydrationState = 'idle' | 'loading' | 'ready' | 'missing';

export class ExperimentManager {
    experiments = $state<Record<string, Experiment>>({});
    activeId = $state<string | null>(null);
    playback = $state<PlaybackState | null>(null);
    hydration = $state<Record<string, HydrationState>>({});
    experimentList = $derived(Object.values(this.experiments));
    // ... rest unchanged
```

- [ ] **Step 4: Rewrite setActive with the state machine**

Replace the existing `setActive` method (lines 952-972 in the current file):

```ts
setActive(id: string): void {
    if (!(id in this.experiments)) return;
    if (this.playback) this.stopPlayback();

    this.activeId = id;
    const exp = this.experiments[id];
    if (!exp) return;

    // Fast path: grid already in memory (running, cached, or recently loaded).
    if (exp.currentGrid) {
        this.hydration[id] = 'ready';
        return;
    }

    // Running experiment with no grid yet — compute loop will populate.
    if (exp.status === 'running') {
        this.hydration[id] = 'loading';
        return;
    }

    // Slow path: hydrate from disk.
    this.hydration[id] = 'loading';
    const token = (this.rehydrateToken.get(id) ?? 0) + 1;
    this.rehydrateToken.set(id, token);
    void this.hydrateFromDisk(id, token).catch((err) => {
        if (this.rehydrateToken.get(id) !== token) return;
        this.hydration[id] = 'missing';
        console.warn(`[ExperimentManager] Failed to rehydrate grid for ${id}:`, err);
    });
}

private async hydrateFromDisk(id: string, token: number): Promise<void> {
    const exp = this.experiments[id];
    if (!exp) return;

    const frame = await persistence.loadFrame(id);
    if (this.rehydrateToken.get(id) !== token) return;

    if (!frame) {
        this.hydration[id] = 'missing';
        exp.noTapeData = true;
        return;
    }

    const totalCells = frame.width * frame.height;
    const grid = new Uint32Array(totalCells);
    for (let i = 0; i < totalCells; i++) grid[i] = frame.grid01[i] ?? 0;
    exp.currentGrid = grid;
    exp.currentGeneration = frame.generation;
    exp.currentColorsHex = frame.colorsHex;
    if (frame.colorsHex) {
        const status = new Uint8Array(totalCells);
        for (let i = 0; i < totalCells; i++) status[i] = frame.colorsHex[i] != null ? 1 : 0;
        exp.currentColorStatus8 = status;
    } else {
        exp.currentColorStatus8 = null;
    }
    if (frame.frameCount !== exp.progress.current) {
        exp.progress = { current: frame.frameCount, target: exp.progress.target };
    }
    exp.noTapeData = false;
    this.hydration[id] = 'ready';
}
```

Remove the old `rehydrateFromTape` method (lines 978-1034). The new `hydrateFromDisk` replaces it. The SQLite tape check is gone because `persistence.loadFrame` handles both paths internally.

- [ ] **Step 5: Run tests**

Run: `npm test`

Expected: PASS. The three new `nlcaStore.test.ts` tests green, all existing tests still green.

- [ ] **Step 6: Manual verify — hydration flags are observable**

Add a temporary log line in `Canvas.svelte` Effect 2: `console.log('[NLCA]', nlcaStore.activeId, nlcaStore.hydration[nlcaStore.activeId ?? '']);`. Run `npm run dev`, switch between experiments, verify the hydration state transitions logged in the console match expectations (`ready` for cached, `loading` → `ready` or `missing` for un-cached). Remove the log after.

- [ ] **Step 7: Commit**

```bash
git add src/lib/stores/nlcaStore.test.ts src/lib/nlca/experimentManager.svelte.ts
git commit -m "feat(nlca): hydration state machine for setActive"
```

---

## Task 7: Skeleton overlay (Effect 3)

**Goal:** Show a subtle shimmer overlay over the canvas while `hydration[active.id] === 'loading'`. Fades out when grid arrives.

**Files:**
- Modify: `src/lib/components/Canvas.svelte`

- [ ] **Step 1: Add the skeleton DOM overlay**

In `src/lib/components/Canvas.svelte`, find the template markup (after the `<script>` block). Locate the container that wraps the `<canvas>`. Add the skeleton sibling:

```svelte
<div class="canvas-container" bind:this={container}>
    <canvas bind:this={canvas} />
    {#if nlcaMode && nlcaStore.active && nlcaStore.hydration[nlcaStore.active.id] === 'loading'}
        <div class="canvas-skeleton" transition:fade={{ duration: 150 }}></div>
    {/if}
</div>
```

Add the `import { fade } from 'svelte/transition';` at the top of the `<script>` block if it's not already present.

- [ ] **Step 2: Add the skeleton styles**

In the `<style>` block of `Canvas.svelte`, add:

```svelte
<style>
    /* Skeleton shimmer overlay — shown while experiment frame data hydrates. */
    .canvas-skeleton {
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(255, 255, 255, 0.04) 50%,
            transparent 100%
        );
        background-size: 200% 100%;
        animation: canvas-shimmer 1.2s linear infinite;
    }

    @keyframes canvas-shimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
    }

    @media (prefers-reduced-motion: reduce) {
        .canvas-skeleton { animation: none; }
    }

    /* ... existing styles unchanged */
</style>
```

- [ ] **Step 3: Verify the container is `position: relative`**

The skeleton uses `position: absolute; inset: 0;` which needs a positioned ancestor. Check the existing `.canvas-container` style — if it does not have `position: relative`, add it:

```svelte
.canvas-container {
    position: relative;
    /* ... existing rules */
}
```

- [ ] **Step 4: Manual verify — skeleton appears briefly on cold-hydrate switch**

Run: `npm run dev`. Refresh the page so all grid caches drop. Open the experiment panel and click a non-active experiment whose grid data needs to load from JSONL. You should see a subtle left-to-right shimmer sweep across the canvas for 50-200ms, then fade out as the grid appears.

Switch to an already-loaded experiment — no skeleton should appear.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/Canvas.svelte
git commit -m "feat(nlca): skeleton overlay during experiment hydration"
```

---

## Task 8: LRU cache (N=5)

**Goal:** Evict the oldest non-pinned grid when more than 5 evictable experiments have `currentGrid` populated.

**Files:**
- Modify: `src/lib/nlca/experimentManager.svelte.ts`
- Modify: `src/lib/stores/nlcaStore.test.ts`

- [ ] **Step 1: Add failing LRU test**

Append to `src/lib/stores/nlcaStore.test.ts`:

```ts
describe('nlcaStore LRU cache', () => {
    beforeEach(() => {
        __resetNlcaStoreForTests();
    });

    test('evicts oldest non-pinned experiment when budget exceeded', () => {
        const store = getNlcaStore();
        const mkExp = (id: string) => ({
            id, label: id, config: { gridWidth: 5, gridHeight: 5 } as never,
            status: 'paused' as const, stepper: null, tape: null as never, frameBuffer: null,
            agentManager: null, progress: { current: 1, target: 10 }, createdAt: 0,
            dbFilename: `/${id}.sqlite3`, currentGrid: new Uint32Array(25),
            currentColorsHex: null, currentColorStatus8: null, currentGeneration: 1,
            bufferStatus: null, totalCost: 0, estimatedCost: 0, pricingUnknown: true,
            totalCalls: 0, lastLatencyMs: null
        });

        // Seed 7 experiments, all with currentGrid populated.
        for (let i = 1; i <= 7; i++) {
            store.experiments[`e${i}`] = mkExp(`e${i}`);
        }

        // Switch through them in order — each setActive bumps lastAccessedAt.
        for (let i = 1; i <= 7; i++) {
            store.setActive(`e${i}`);
        }

        // Active = e7. Budget = 5 evictable (e1..e6 all eligible). Oldest 1 evicted.
        expect(store.experiments['e7'].currentGrid).not.toBeNull(); // active
        const evictedCount = [1, 2, 3, 4, 5, 6].filter(
            (i) => store.experiments[`e${i}`].currentGrid === null
        ).length;
        expect(evictedCount).toBe(1); // e1 is oldest
        expect(store.experiments['e1'].currentGrid).toBeNull();
    });

    test('never evicts running experiments even if past budget', () => {
        const store = getNlcaStore();
        const mkRunning = (id: string) => ({
            id, label: id, config: { gridWidth: 5, gridHeight: 5 } as never,
            status: 'running' as const, stepper: null, tape: null as never, frameBuffer: null,
            agentManager: null, progress: { current: 1, target: 10 }, createdAt: 0,
            dbFilename: `/${id}.sqlite3`, currentGrid: new Uint32Array(25),
            currentColorsHex: null, currentColorStatus8: null, currentGeneration: 1,
            bufferStatus: null, totalCost: 0, estimatedCost: 0, pricingUnknown: true,
            totalCalls: 0, lastLatencyMs: null
        });

        for (let i = 1; i <= 8; i++) {
            store.experiments[`r${i}`] = mkRunning(`r${i}`);
            store.setActive(`r${i}`);
        }

        // All running → all pinned → none evicted.
        for (let i = 1; i <= 8; i++) {
            expect(store.experiments[`r${i}`].currentGrid).not.toBeNull();
        }
    });
});
```

- [ ] **Step 2: Run — verify LRU tests fail**

Run: `npm test -- src/lib/stores/nlcaStore.test.ts`

Expected: FAIL on the two new tests — no eviction happens.

- [ ] **Step 3: Add LRU tracking and eviction**

In `src/lib/nlca/experimentManager.svelte.ts`, add the tracking map as a private field:

```ts
export class ExperimentManager {
    experiments = $state<Record<string, Experiment>>({});
    activeId = $state<string | null>(null);
    playback = $state<PlaybackState | null>(null);
    hydration = $state<Record<string, HydrationState>>({});
    experimentList = $derived(Object.values(this.experiments));
    // ... existing fields

    private lastAccessedAt = new Map<string, number>();
    private static readonly LRU_BUDGET = 5;
```

In `setActive()`, bump the access time and call `enforceLruBudget()` in both paths:

```ts
setActive(id: string): void {
    if (!(id in this.experiments)) return;
    if (this.playback) this.stopPlayback();

    this.activeId = id;
    this.lastAccessedAt.set(id, Date.now());
    const exp = this.experiments[id];
    if (!exp) return;

    if (exp.currentGrid) {
        this.hydration[id] = 'ready';
        this.enforceLruBudget();
        return;
    }

    if (exp.status === 'running') {
        this.hydration[id] = 'loading';
        return;
    }

    this.hydration[id] = 'loading';
    const token = (this.rehydrateToken.get(id) ?? 0) + 1;
    this.rehydrateToken.set(id, token);
    void this.hydrateFromDisk(id, token)
        .then(() => this.enforceLruBudget())
        .catch((err) => {
            if (this.rehydrateToken.get(id) !== token) return;
            this.hydration[id] = 'missing';
            console.warn(`[ExperimentManager] Failed to rehydrate grid for ${id}:`, err);
        });
}

private enforceLruBudget(): void {
    const evictable = Object.values(this.experiments)
        .filter((e) => e.currentGrid != null && e.id !== this.activeId && e.status !== 'running')
        .sort(
            (a, b) =>
                (this.lastAccessedAt.get(a.id) ?? 0) - (this.lastAccessedAt.get(b.id) ?? 0)
        );
    while (evictable.length > ExperimentManager.LRU_BUDGET) {
        const victim = evictable.shift();
        if (!victim) break;
        victim.currentGrid = null;
        victim.currentColorsHex = null;
        victim.currentColorStatus8 = null;
        this.hydration[victim.id] = 'idle';
    }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `npm test`

Expected: PASS. LRU tests green, existing tests still green.

- [ ] **Step 5: Manual verify — memory stable**

Run: `npm run dev`. Open DevTools Memory tab. Open 10 experiments (create or load existing ones with frames on disk). Switch through each. Take a heap snapshot — confirm that at most `5 + runningCount` `Uint32Array` objects of meaningful size are retained under the ExperimentManager's `experiments` record. Evicted experiments should show `currentGrid: null`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stores/nlcaStore.test.ts src/lib/nlca/experimentManager.svelte.ts
git commit -m "feat(nlca): LRU grid cache with N=5 + pinning"
```

---

## Task 9: Remove setInterval polling

**Goal:** Kill the `setInterval(..., 100)` in `MainAppNlca.svelte`. Canvas writes recording + buffer state directly to stores; consumers subscribe reactively.

**Files:**
- Modify: `src/lib/stores/simulation.svelte.ts` — add `isRecording`
- Modify: `src/lib/nlca/experimentManager.svelte.ts` — already has `bufferStatus`, `batchRunTarget`, `batchRunCompleted` fields to add
- Modify: `src/lib/components/Canvas.svelte`
- Modify: `src/lib/components/MainAppNlca.svelte`

- [ ] **Step 1: Add `isRecording` to simState**

In `src/lib/stores/simulation.svelte.ts`, locate the simState object literal. Add `isRecording` next to other fields:

```ts
let isRecording = $state(false);

// In the getSimulationState() exported return:
//   ...
//   get isRecording() { return isRecording; },
//   set isRecording(value: boolean) { isRecording = value; },
//   ...
```

Place the `let` near the other `$state` declarations (around line 13 with `isPlaying`, `speed`, etc.), and the getter/setter pair in `getSimulationState()` alongside them.

- [ ] **Step 2: Add buffer + batch-run fields to the manager**

In `src/lib/nlca/experimentManager.svelte.ts`, add to the class body alongside existing `$state` fields:

```ts
import type { BufferStatus } from './frameBuffer.js';

export class ExperimentManager {
    // ... existing fields
    bufferStatus = $state<BufferStatus | null>(null);
    batchRunTarget = $state(0);
    batchRunCompleted = $state(0);
```

- [ ] **Step 3: Canvas writes to stores, removes getter methods**

In `src/lib/components/Canvas.svelte`:

1. Delete the local `let isRecording = $state(false);` (around line 2175). All reads of `isRecording` in this file now reference `simState.isRecording` — use Grep to find occurrences and replace.
2. Inside the recording start function, replace `isRecording = true;` with `simState.isRecording = true;`. Same for `isRecording = false;`.
3. Delete the `export function getIsRecording()` (around line 2180).
4. Delete `export function getNlcaBufferStatus()`, `getNlcaBatchRunTarget()`, `getNlcaBatchRunCompleted()`.
5. Find where `nlcaBufferStatus`, `nlcaBatchRunTarget`, `nlcaBatchRunCompleted` are mutated internally (in NLCA batch run logic). Replace those writes with `nlcaStore.bufferStatus = ...`, `nlcaStore.batchRunTarget = ...`, `nlcaStore.batchRunCompleted = ...`.
6. Delete the local `$state` declarations for those three fields at the top of the `<script>` block.

- [ ] **Step 4: MainAppNlca reads from stores directly**

In `src/lib/components/MainAppNlca.svelte`:

1. Delete the `onMount(() => { const interval = setInterval(...); ... });` block (lines 239-248).
2. Delete the local `let isRecording = $state(false);`, `let nlcaBufferStatus = $state<BufferStatus | null>(null);`, `let nlcaBatchRunTarget = $state(0);`, `let nlcaBatchRunCompleted = $state(0);` (around lines 42-44).
3. Replace the references in the `<ControlsNlca>` / `<NlcaBatchRunModal>` prop passes:
   - `isRecording={isRecording}` → `isRecording={simState.isRecording}`
   - `bufferStatus={nlcaBufferStatus}` → `bufferStatus={experimentManager.bufferStatus}`
   - `batchRunActive={nlcaBatchRunTarget > 0}` → `batchRunActive={experimentManager.batchRunTarget > 0}`
   - `batchRunTarget={nlcaBatchRunTarget}` → `batchRunTarget={experimentManager.batchRunTarget}`
   - `batchRunCompleted={nlcaBatchRunCompleted}` → `batchRunCompleted={experimentManager.batchRunCompleted}`

- [ ] **Step 5: Run check**

Run: `npm run check`

Expected: no errors. If any other component read from the deleted Canvas getters, update it to read from the store instead.

- [ ] **Step 6: Manual verify — recording + batch run still responsive**

Run: `npm run dev`. Click Record — the UI should reflect the recording state immediately (no 100ms delay). Start a batch run — the modal progress bar should update as frames complete. No `setInterval` is needed.

- [ ] **Step 7: Commit**

```bash
git add src/lib/stores/simulation.svelte.ts src/lib/nlca/experimentManager.svelte.ts src/lib/components/Canvas.svelte src/lib/components/MainAppNlca.svelte
git commit -m "refactor(nlca): kill setInterval polling, canvas writes to stores"
```

---

## Task 10: Final verification + acceptance

**Goal:** Run the acceptance checklist from the spec end-to-end. Catch any regressions the per-task manual checks missed.

**Files:** none (verification only)

- [ ] **Step 1: Full test + check + lint**

Run in parallel:

```bash
npm test
npm run check
npm run lint
```

Expected: all green. Fix any failures before proceeding.

- [ ] **Step 2: Walk the acceptance criteria**

Run `npm run dev`. In a browser, verify each spec acceptance criterion:

1. **Auto-fit on dimension change.** Create two experiments with clearly different grid sizes (8×8 and 40×40). Switch between them — camera animates to fit each. ✅ / ❌
2. **Skeleton on uncached switch.** Reload the page so the in-memory cache clears. Click a non-active experiment whose JSONL has frames — verify shimmer appears briefly. ✅ / ❌
3. **Parallel running experiments.** Start two experiments simultaneously (both `running`). Switch between them — each shows its latest frame, both continue advancing in the background. ✅ / ❌
4. **No `setInterval` in MainAppNlca.** Run `grep -n setInterval src/lib/components/MainAppNlca.svelte` — expect no matches. ✅ / ❌
5. **No `new ExperimentManager` in components.** Run `grep -rn "new ExperimentManager" src/lib/components/` — expect no matches. ✅ / ❌
6. **LRU memory cap.** Open 10 experiments (create or load), switch through all. Inspect `experimentManager.experiments` in DevTools — at most `5 + (running count)` have non-null `currentGrid`. ✅ / ❌
7. **Existing functionality intact.** Spot-check: create, pause, resume, extend, delete, playback (Play after completion), seek (frame scrubber), batch run, recording. All behave as before. ✅ / ❌
8. **Reduced motion.** Toggle OS-level "Reduce Motion" (macOS: System Settings → Accessibility → Display). Switch experiments — camera snaps instead of animating; skeleton shimmer is static. ✅ / ❌

- [ ] **Step 3: Commit any fixes**

If any criterion failed, fix it, re-run Step 1, then:

```bash
git add <files>
git commit -m "fix(nlca): <description of what was off>"
```

- [ ] **Step 4: Final summary commit (optional)**

If the work spans a single feature branch, add a summary commit pointing to the spec:

```bash
git commit --allow-empty -m "$(cat <<'EOF'
feat(nlca): state management redesign complete

Implements docs/superpowers/specs/2026-04-19-nlca-state-redesign-design.md.

- Singleton nlcaStore replaces new-in-component ExperimentManager
- persistence.ts hides CSV/SQLite-wasm/JSONL behind one interface
- Canvas subscribes reactively (no more imperative setExperimentGrid pushes)
- Auto-fit camera on experiment switch
- Hydration state machine + skeleton overlay for un-cached experiments
- LRU grid cache (N=5) with pinning for active + running experiments
- setInterval polling eliminated; Canvas writes to stores directly

All acceptance criteria pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

**Spec coverage:**
- Store shape → Task 3 (singleton), Task 6 (hydration), Task 8 (LRU)
- Persistence module → Tasks 1, 2
- Canvas reactivity (3 effects) → Tasks 4 (Effect 1), 5 (Effect 2), 7 (Effect 3)
- Hydration state machine → Task 6
- LRU cache → Task 8
- Polling removal → Task 9
- Migration step 7 (housekeeping) → absorbed across Tasks 5 (delete setExperimentGrid) and 9 (delete getters); no separate cleanup task needed because each migration step cleaned as it went.

**Type consistency:** `HydrationState` / `getNlcaStore` / `enforceLruBudget` / `hydrateFromDisk` named consistently across all tasks. `persistence.syncMeta` / `persistence.syncFrame` / `persistence.loadAllMeta` / `persistence.loadFrame` / `persistence.deleteExperiment` / `persistence.registerMeta` / `persistence.newTape` match between Tasks 1, 2, 6.

**Placeholder scan:** No "TBD", "TODO", "implement later", or "similar to Task N" references. Every step has concrete code or exact commands.
