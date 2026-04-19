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
