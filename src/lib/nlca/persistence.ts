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
let initPromise: Promise<void> | null = null;
// #region agent log
let debugLoadFrameInFlight = 0;
let debugSyncFrameInFlight = 0;
let debugSyncMetaInFlight = 0;

function postDebugLog(
    location: string,
    message: string,
    data: Record<string, unknown>,
    hypothesisId: string
): void {
    fetch('http://127.0.0.1:7569/ingest/ff2fa46d-1b83-4d22-8de5-bf276ff29f2d', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '9e7e3d' },
        body: JSON.stringify({
            sessionId: '9e7e3d',
            runId: 'initial',
            hypothesisId,
            location,
            message,
            data,
            timestamp: Date.now()
        })
    }).catch(() => {});
}
// #endregion

async function ensureIndex(): Promise<void> {
    if (!initPromise) initPromise = index.init();
    await initPromise;
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
        promptPresetId: row.promptPresetId || undefined,
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
    // #region agent log
    const requestStartedAt = performance.now();
    debugLoadFrameInFlight += 1;
    postDebugLog(
        'src/lib/nlca/persistence.ts:129',
        'Started loadFrame request',
        {
            runId: id,
            generation: generation ?? null,
            inFlight: debugLoadFrameInFlight
        },
        'G'
    );
    // #endregion
    try {
        const qs = new URLSearchParams({ runId: id });
        if (generation !== undefined) qs.set('generation', String(generation));
        const res = await fetch(`/api/nlca-frames-jsonl?${qs.toString()}`);
        // #region agent log
        const responseAt = performance.now();
        const responseDurationMs = Math.round((responseAt - requestStartedAt) * 100) / 100;
        // #endregion
        if (!res.ok) return null;
        const data = await res.json();
        // #region agent log
        const totalDurationMs = Math.round((performance.now() - requestStartedAt) * 100) / 100;
        if (totalDurationMs >= 100 || responseDurationMs >= 100 || debugLoadFrameInFlight >= 3) {
            postDebugLog(
                'src/lib/nlca/persistence.ts:133',
                'Completed loadFrame request',
                {
                    runId: id,
                    generation: generation ?? null,
                    status: res.status,
                    inFlight: debugLoadFrameInFlight,
                    responseDurationMs,
                    jsonDurationMs: Math.round((totalDurationMs - responseDurationMs) * 100) / 100,
                    totalDurationMs,
                    hasLatest: !!data?.latest,
                    hasFrame: !!data?.frame,
                    frameCount: data?.frameCount ?? null
                },
                'G'
            );
        }
        // #endregion
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
    } finally {
        // #region agent log
        debugLoadFrameInFlight = Math.max(0, debugLoadFrameInFlight - 1);
        // #endregion
    }
}

/**
 * Hot-path per-tick persistence. Writes ONLY meta.json (a single tiny file,
 * atomic `writeFile`). Deliberately skips the CSV rewrite and the SQLite
 * index update — those are reserved for actual state transitions via
 * `syncTransition`. Progress updates are coalesced per experiment: at most
 * one request in flight per id at any time; subsequent updates overwrite a
 * pending slot, so we never queue up a backlog when the server is slow.
 */
type PendingProgress = {
    runId: string;
    body: string;
};
const pendingProgress = new Map<string, PendingProgress>();
const inFlightProgress = new Set<string>();

function buildProgressBody(exp: Experiment, errorMessage: string | null): string {
    return JSON.stringify({
        runId: exp.id,
        meta: {
            id: exp.id,
            label: exp.label,
            status: exp.status,
            progress: exp.progress,
            createdAt: exp.createdAt,
            updatedAt: Date.now(),
            dbFilename: exp.dbFilename,
            errorMessage,
            config: redactExperimentConfigForPersistence(exp.config)
        }
    });
}

async function drainProgress(id: string): Promise<void> {
    const pending = pendingProgress.get(id);
    if (!pending) return;
    pendingProgress.delete(id);
    // #region agent log
    const startedAt = performance.now();
    // #endregion
    try {
        await fetch('/api/nlca-frames-jsonl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: pending.body
        });
    } catch (err) {
        if (typeof window !== 'undefined') console.debug('[persistence] progress sync skipped:', err);
    }
    // #region agent log
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    if (durationMs >= 100) {
        postDebugLog(
            'src/lib/nlca/persistence.ts:drainProgress',
            'syncProgress drained',
            { runId: id, durationMs },
            'post-fix-progress'
        );
    }
    // #endregion
    // If a newer payload arrived while we were in flight, flush it next.
    if (pendingProgress.has(id)) {
        await drainProgress(id);
    }
}

export function syncProgress(exp: Experiment, extra?: { errorMessage?: string }): void {
    const errorMessage = extra?.errorMessage ?? exp.errorMessage ?? null;
    const body = buildProgressBody(exp, errorMessage);
    pendingProgress.set(exp.id, { runId: exp.id, body });
    if (inFlightProgress.has(exp.id)) return; // latest payload already scheduled.
    inFlightProgress.add(exp.id);
    void drainProgress(exp.id).finally(() => {
        inFlightProgress.delete(exp.id);
    });
}

/**
 * Per-experiment frame batcher. Frames are appended to `frames.jsonl`. We
 * buffer them on the client and flush as a single batched POST every
 * `FRAME_FLUSH_INTERVAL_MS` or once `FRAME_FLUSH_MAX_BATCH` accumulate. This
 * cuts HTTP pressure proportionally to the batch size, which matters
 * hugely when several experiments are running simultaneously.
 */
const FRAME_FLUSH_INTERVAL_MS = 300;
const FRAME_FLUSH_MAX_BATCH = 20;
const pendingFrames = new Map<string, string[]>();
const frameFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightFrameFlush = new Set<string>();

async function flushFrames(id: string): Promise<void> {
    const timer = frameFlushTimers.get(id);
    if (timer) {
        clearTimeout(timer);
        frameFlushTimers.delete(id);
    }
    if (inFlightFrameFlush.has(id)) return; // one flush at a time per experiment.
    const batch = pendingFrames.get(id);
    if (!batch || batch.length === 0) return;
    pendingFrames.set(id, []);
    inFlightFrameFlush.add(id);
    // #region agent log
    const startedAt = performance.now();
    const batchSize = batch.length;
    // #endregion
    try {
        await fetch('/api/nlca-frames-jsonl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runId: id, frames: batch })
        });
    } catch (err) {
        if (typeof window !== 'undefined') console.debug('[persistence] frame flush skipped:', err);
    } finally {
        inFlightFrameFlush.delete(id);
        // #region agent log
        const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
        if (durationMs >= 100 || batchSize >= 5) {
            postDebugLog(
                'src/lib/nlca/persistence.ts:flushFrames',
                'frame batch flushed',
                { runId: id, batchSize, durationMs },
                'post-fix-frames'
            );
        }
        // #endregion
        // If more frames arrived while we were in flight, schedule the next drain.
        const remaining = pendingFrames.get(id);
        if (remaining && remaining.length > 0) {
            void flushFrames(id);
        }
    }
}

function scheduleFrameFlush(id: string): void {
    if (frameFlushTimers.has(id)) return;
    const timer = setTimeout(() => {
        frameFlushTimers.delete(id);
        void flushFrames(id);
    }, FRAME_FLUSH_INTERVAL_MS);
    frameFlushTimers.set(id, timer);
}

export async function syncTransition(exp: Experiment, extra?: { errorMessage?: string }): Promise<void> {
    const errorMessage = extra?.errorMessage ?? exp.errorMessage ?? null;
    // #region agent log
    const requestStartedAt = performance.now();
    debugSyncMetaInFlight += 1;
    // #endregion

    // #region agent log
    let csvDurationMs = 0;
    let jsonlDurationMs = 0;
    let sqliteDurationMs = 0;
    // #endregion

    // CSV + JSONL meta writes target different server files and different
    // mutation queues on the server. Run them in parallel rather than
    // sequentially — halves the client-observed latency in practice.
    // #region agent log
    const parallelStartedAt = performance.now();
    // #endregion
    const csvBody = JSON.stringify({
        id: exp.id,
        label: exp.label,
        apiProvider: exp.config.apiProvider ?? 'openrouter',
        model: exp.config.model,
        gridWidth: exp.config.gridWidth,
        gridHeight: exp.config.gridHeight,
        neighborhood: exp.config.neighborhood,
        cellColorEnabled: exp.config.cellColorEnabled ? 'true' : 'false',
        taskDescription: exp.config.taskDescription,
        promptPresetId: exp.config.promptPresetId ?? '',
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
        errorMessage: errorMessage ?? ''
    });
    const jsonlBody = JSON.stringify({
        runId: exp.id,
        meta: {
            id: exp.id,
            label: exp.label,
            status: exp.status,
            progress: exp.progress,
            createdAt: exp.createdAt,
            updatedAt: Date.now(),
            dbFilename: exp.dbFilename,
            errorMessage: errorMessage,
            config: redactExperimentConfigForPersistence(exp.config)
        }
    });

    const [csvResult, jsonlResult] = await Promise.allSettled([
        (async () => {
            // #region agent log
            const csvStartedAt = performance.now();
            // #endregion
            await fetch('/api/nlca-runs-csv', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: csvBody
            });
            // #region agent log
            csvDurationMs = Math.round((performance.now() - csvStartedAt) * 100) / 100;
            // #endregion
        })(),
        (async () => {
            // #region agent log
            const jsonlStartedAt = performance.now();
            // #endregion
            await fetch('/api/nlca-frames-jsonl', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: jsonlBody
            });
            // #region agent log
            jsonlDurationMs = Math.round((performance.now() - jsonlStartedAt) * 100) / 100;
            // #endregion
        })()
    ]);
    if (csvResult.status === 'rejected' && typeof window !== 'undefined') {
        console.debug('[persistence] CSV sync skipped:', csvResult.reason);
    }
    if (jsonlResult.status === 'rejected' && typeof window !== 'undefined') {
        console.debug('[persistence] JSONL meta sync skipped:', jsonlResult.reason);
    }
    // #region agent log
    void parallelStartedAt; // reserved for future instrumentation
    // #endregion

    // Fire-and-forget SQLite index mirror. Awaiting it here serialises the
    // compute loop behind an in-memory index update that, under load, can
    // stall for tens of seconds because the main thread is saturated with
    // pending microtasks. It's an in-session cache; losing a single update
    // is fine — the CSV + meta.json writes above are authoritative.
    // #region agent log
    const sqliteStartedAt = performance.now();
    // #endregion
    void (async () => {
        try {
            await ensureIndex();
            await index.updateStatus(
                exp.id,
                exp.status,
                exp.progress.current,
                errorMessage ?? undefined,
                exp.totalCost
            );
        } catch (err) {
            if (typeof window !== 'undefined') console.debug('[persistence] SQLite index sync skipped:', err);
        }
    })();
    // #region agent log
    sqliteDurationMs = Math.round((performance.now() - sqliteStartedAt) * 100) / 100;
    // #endregion
    try {
        // no-op; keep finally for log + counter bookkeeping
    } finally {
        // #region agent log
        const totalDurationMs = Math.round((performance.now() - requestStartedAt) * 100) / 100;
        if (totalDurationMs >= 100 || debugSyncMetaInFlight >= 3) {
            postDebugLog(
                'src/lib/nlca/persistence.ts:151',
                'Completed syncMeta request',
                {
                    runId: exp.id,
                    status: exp.status,
                    progressCurrent: exp.progress.current,
                    syncMetaInFlight: debugSyncMetaInFlight,
                    totalDurationMs,
                    csvDurationMs,
                    jsonlDurationMs,
                    sqliteDurationMs
                },
                'I|J|K'
            );
        }
        debugSyncMetaInFlight = Math.max(0, debugSyncMetaInFlight - 1);
        // #endregion
    }
}

/**
 * Enqueue a frame for the batched JSONL tape. Non-blocking: the compute loop
 * does not await this, and several frames coalesce into a single HTTP POST
 * once the batch timer fires. See `flushFrames` / `scheduleFrameFlush`.
 */
export function syncFrame(runId: string, frameLine: string): void {
    const queue = pendingFrames.get(runId) ?? [];
    queue.push(frameLine);
    pendingFrames.set(runId, queue);
    if (queue.length >= FRAME_FLUSH_MAX_BATCH) {
        void flushFrames(runId);
    } else {
        scheduleFrameFlush(runId);
    }
}

/** Flush any buffered frames for a run immediately. Used when the experiment
 * pauses or completes so the final batch is persisted before the UI reads
 * from disk. */
export async function flushPendingFrames(runId: string): Promise<void> {
    await flushFrames(runId);
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
    } catch (err) {
        if (typeof window !== 'undefined') console.debug('[persistence] SQLite delete skipped:', err);
    }
    try {
        await fetch(`/api/nlca-runs-csv?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
        if (typeof window !== 'undefined') console.debug('[persistence] CSV delete skipped:', err);
    }
    try {
        await fetch(`/api/nlca-frames-jsonl?runId=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
        if (typeof window !== 'undefined') console.debug('[persistence] JSONL delete skipped:', err);
    }
}

export function newTape(dbFilename: string): NlcaTape {
    return new NlcaTape(dbFilename);
}

/**
 * Back-compat alias. All non-hot-path callers (start, pause, resume,
 * complete, error, label change) should use `syncTransition`. The only
 * per-tick hot-path caller should use `syncProgress` instead — it skips
 * the CSV + SQLite layers entirely.
 */
export const syncMeta = syncTransition;
