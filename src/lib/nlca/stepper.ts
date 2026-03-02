import type { BoundaryMode } from '$lib/stores/simulation.svelte.js';
import { base } from '$app/paths';
import type { CellContext, NlcaCellMetricsFrame, NlcaCellRequest, NlcaOrchestratorConfig, NlcaStepResult, NlcaNeighborhood, CellState01 } from './types.js';
import { extractCellContext } from './neighborhood.js';
import { NlcaOrchestrator, calculateOptimalParallelism, type CellDecisionResult, type NlcaCostStats, type DebugLogEntry } from './orchestrator.js';
import { CellAgentManager } from './agentManager.js';
import type { PromptConfig } from './prompt.js';
import type { WorkerBuildContextsMsg, WorkerContextsResultMsg, WorkerInitSharedGridMsg } from './nlca-worker.js';
import { SharedGridBuffer } from './sharedGrid.js';

export interface NlcaStepperConfig {
	runId: string;
	neighborhood: NlcaNeighborhood;
	boundary: BoundaryMode;
	orchestrator: NlcaOrchestratorConfig;
}

export interface NlcaProgressCallback {
	/** Called after each cell decision completes */
	onCellComplete?: (cellId: number, result: CellDecisionResult, completed: number, total: number) => void;
	/** Called periodically with batch progress (for UI updates) */
	onBatchProgress?: (completed: number, total: number, partialGrid: Uint32Array) => void;
}

function latencyToU8(ms: number): number {
	// 0..255 where each unit is ~10ms (cap at 2550ms).
	if (!Number.isFinite(ms) || ms <= 0) return 0;
	return Math.max(1, Math.min(255, Math.round(ms / 10)));
}

async function asyncPool<T>(
	concurrency: number,
	items: readonly T[],
	fn: (item: T, idx: number) => Promise<void>
): Promise<void> {
	const workerCount = Math.max(1, Math.floor(concurrency));
	let nextIndex = 0;
	const workers = new Array(workerCount).fill(0).map(async () => {
		while (true) {
			const idx = nextIndex++;
			if (idx >= items.length) return;
			await fn(items[idx]!, idx);
		}
	});
	await Promise.all(workers);
}

/**
 * Minimum grid cell count to engage the worker pool instead of the synchronous
 * fallback. Below this threshold the synchronous loop is fast enough (~<5ms)
 * that worker round-trip overhead would not be worth it.
 */
const WORKER_THRESHOLD = 1_000;

/**
 * Manages a pool of Web Workers for parallelised context building.
 * Workers are created lazily on first use and reused across steps.
 * Each worker handles a horizontal shard (range of y-rows) of the grid.
 */
class NlcaContextWorkerPool {
	private workers: Worker[] = [];
	private pending = new Map<number, (result: { cells: CellContext[]; hashes?: string[] }) => void>();
	private nextId = 0;
	private workerCount: number;
	private sharedGrid: SharedGridBuffer | null = null;

	constructor() {
		// Clamp to a reasonable maximum to avoid spawning too many threads.
		this.workerCount = Math.max(1, Math.min(typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4, 8));
	}

	private ensureWorkers(): void {
		if (this.workers.length > 0) return;
		for (let i = 0; i < this.workerCount; i++) {
			const w = new Worker(new URL('./nlca-worker.ts', import.meta.url), { type: 'module' });
			w.onmessage = (e: MessageEvent<WorkerContextsResultMsg>) => {
				if (e.data.type !== 'contextsResult') return;
				const resolve = this.pending.get(e.data.id);
				if (resolve) {
					this.pending.delete(e.data.id);
					resolve({ cells: e.data.cells, hashes: e.data.hashes });
				}
			};
			this.workers.push(w);
		}
	}

	/**
	 * Initialise SharedArrayBuffer-backed grid for zero-copy worker communication.
	 * Idempotent — only allocates if dimensions change or SAB is not yet set up.
	 */
	initSharedGrid(width: number, height: number): void {
		if (!SharedGridBuffer.isAvailable()) return;
		// Already initialised for these dimensions.
		if (this.sharedGrid && this.sharedGrid.width === width && this.sharedGrid.height === height) return;

		this.sharedGrid = new SharedGridBuffer(width, height);
		this.ensureWorkers();

		const initMsg: WorkerInitSharedGridMsg = {
			type: 'initSharedGrid',
			buffer: this.sharedGrid.buffer,
			width,
			height,
			dataOffset: SharedGridBuffer.DATA_OFFSET
		};
		for (const w of this.workers) {
			w.postMessage(initMsg);
		}
		console.log(`[NLCA] Worker pool using SharedArrayBuffer (${width}x${height})`);
	}

	private dispatchShard(
		workerIndex: number,
		prev: Uint32Array,
		width: number,
		height: number,
		neighborhood: NlcaNeighborhood,
		boundary: BoundaryMode,
		yStart: number,
		yEnd: number,
		useSharedGrid: boolean = false,
		computeHashes: boolean = false
	): Promise<{ cells: CellContext[]; hashes?: string[] }> {
		this.ensureWorkers();
		return new Promise<{ cells: CellContext[]; hashes?: string[] }>((resolve) => {
			const id = this.nextId++;
			this.pending.set(id, resolve);
			const msg: WorkerBuildContextsMsg = {
				type: 'buildContexts',
				id,
				prev: useSharedGrid ? new Uint32Array(0) : prev,
				width,
				height,
				neighborhood,
				boundary,
				yStart,
				yEnd,
				computeHashes
			};
			this.workers[workerIndex]!.postMessage(msg);
		});
	}

	async buildContexts(
		prev: Uint32Array,
		width: number,
		height: number,
		neighborhood: NlcaNeighborhood,
		boundary: BoundaryMode
	): Promise<CellContext[]> {
		const n = this.workerCount;
		const rowsPerShard = Math.ceil(height / n);
		const shards: Promise<CellContext[]>[] = [];

		// When SharedArrayBuffer is active and dimensions match, write once
		// and dispatch shards with empty prev to avoid structured clone overhead.
		const useShared =
			this.sharedGrid !== null &&
			this.sharedGrid.width === width &&
			this.sharedGrid.height === height;

		if (useShared) {
			this.sharedGrid!.writeGrid(prev, 0);
		}

		for (let i = 0; i < n; i++) {
			const yStart = i * rowsPerShard;
			const yEnd = Math.min(height, yStart + rowsPerShard);
			if (yStart >= height) break;
			shards.push(this.dispatchShard(i, prev, width, height, neighborhood, boundary, yStart, yEnd, useShared));
		}

		const results = await Promise.all(shards);
		// Shards are already in row order — concat in order to preserve cell ordering.
		return ([] as CellContext[]).concat(...results);
	}

	terminate(): void {
		for (const w of this.workers) w.terminate();
		this.workers = [];
		this.pending.clear();
		this.sharedGrid = null;
	}
}

export class NlcaStepper {
	private orchestrator: NlcaOrchestrator;
	private agentManager: CellAgentManager;
	private cfg: NlcaStepperConfig;
	private frameHistory: Array<CellState01[]> | null = null;
	private frameBatchedFrames = 0;
	private frameBatchedFallbacks = 0;
	private workerPool: NlcaContextWorkerPool | null = null;

	constructor(cfg: NlcaStepperConfig, agentManager: CellAgentManager) {
		this.cfg = cfg;
		this.agentManager = agentManager;
		this.orchestrator = new NlcaOrchestrator(cfg.orchestrator);
		// Spawn the worker pool eagerly so workers are warm by the time the first
		// step is requested. This is a no-op in SSR / non-browser environments.
		if (typeof Worker !== 'undefined') {
			try {
				this.workerPool = new NlcaContextWorkerPool();
			} catch {
				// Worker creation can fail in some embeddings (e.g. OPFS origin restrictions).
			}
		}
		console.log(`[NLCA] Stepper initialized - runId: ${cfg.runId}, neighborhood: ${cfg.neighborhood}`);
	}

	/** Release worker threads. Call when the stepper is being destroyed. */
	destroy(): void {
		this.workerPool?.terminate();
		this.workerPool = null;
	}

	updateOrchestratorConfig(partial: Partial<NlcaOrchestratorConfig>) {
		this.cfg = { ...this.cfg, orchestrator: { ...this.cfg.orchestrator, ...partial } };
		this.orchestrator.updateConfig(this.cfg.orchestrator);
	}

	updateNeighborhood(neighborhood: NlcaNeighborhood) {
		this.cfg = { ...this.cfg, neighborhood };
		console.log(`[NLCA] Neighborhood updated to: ${neighborhood}`);
	}

	updateBoundary(boundary: BoundaryMode) {
		this.cfg = { ...this.cfg, boundary };
		console.log(`[NLCA] Boundary updated to: ${boundary}`);
	}

	updateRunId(runId: string) {
		this.cfg = { ...this.cfg, runId };
		// Clear agent history for new run
		this.agentManager.clearAllHistory();
		this.orchestrator.resetCallCount();
		console.log(`[NLCA] New run started: ${runId}`);
	}

	/**
	 * Reset agent sessions when prompt configuration changes.
	 * This clears all agent history so the new prompt takes effect.
	 */
	resetAgentSessions(): void {
		this.agentManager.clearAllHistory();
		this.orchestrator.clearDebugLog();
		console.log(`[NLCA] Agent sessions reset - new prompt will take effect`);
	}

	/** Get cost statistics from orchestrator */
	getCostStats(): NlcaCostStats {
		return this.orchestrator.getCostStats();
	}

	/** Get debug log from orchestrator */
	getDebugLog(): DebugLogEntry[] {
		return this.orchestrator.getDebugLog();
	}

	/** Clear debug log */
	clearDebugLog(): void {
		this.orchestrator.clearDebugLog();
	}

	/** Enable/disable debug logging */
	setDebugEnabled(enabled: boolean): void {
		this.orchestrator.setDebugEnabled(enabled);
	}

	/** Check if debug is enabled */
	isDebugEnabled(): boolean {
		return this.orchestrator.isDebugEnabled();
	}

	getFrameBatchedStats(): { frames: number; fallbacks: number } {
		return { frames: this.frameBatchedFrames, fallbacks: this.frameBatchedFallbacks };
	}

	/** Get the size of the current neighborhood (number of neighbors per cell) */
	private getNeighborhoodSize(): number {
		switch (this.cfg.neighborhood) {
			case 'vonNeumann':
				return 4;
			case 'extendedMoore':
				return 24;
			case 'moore':
			default:
				return 8;
		}
	}

	private ensureFrameHistory(expected: number): Array<CellState01[]> {
		if (!this.frameHistory || this.frameHistory.length !== expected) {
			this.frameHistory = new Array<CellState01[]>(expected);
			for (let i = 0; i < expected; i++) this.frameHistory[i] = [];
		}
		return this.frameHistory;
	}

	private async buildContexts(prev: Uint32Array, width: number, height: number): Promise<CellContext[]> {
		const totalCells = width * height;

		// For large grids, offload to the worker pool to keep the main thread free.
		if (totalCells >= WORKER_THRESHOLD && this.workerPool) {
			try {
				// Initialise SharedArrayBuffer for zero-copy communication (idempotent).
				this.workerPool.initSharedGrid(width, height);
				return await this.workerPool.buildContexts(prev, width, height, this.cfg.neighborhood, this.cfg.boundary);
			} catch (err) {
				// Fall through to synchronous path on any worker error.
				console.warn('[NLCA] Worker context building failed, falling back to sync:', err);
			}
		}

		// Synchronous fallback for small grids or when the worker pool is unavailable.
		const cells: CellContext[] = [];
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				cells.push(extractCellContext(prev, width, height, x, y, this.cfg.neighborhood, this.cfg.boundary));
			}
		}
		return cells;
	}

	private async decideFrameBatched(
		cells: readonly CellContext[],
		width: number,
		height: number,
		generation: number,
		latency8: Uint8Array,
		prev: Uint32Array,
		callbacks?: NlcaProgressCallback,
		promptConfig?: PromptConfig
	): Promise<{
		decisionMap: Map<number, CellState01>;
		colorsHex?: Array<string | null>;
		colorStatus8?: Uint8Array;
	}> {
		this.frameBatchedFrames++;
		const totalCells = cells.length;
		const decisions = new Map<number, CellState01>();
		const workingGrid = new Uint32Array(prev);

		const wantColor = promptConfig?.cellColorHexEnabled === true;
		const colorsHex = wantColor ? new Array<string | null>(totalCells).fill(null) : undefined;
		const colorStatus8 = wantColor ? new Uint8Array(totalCells) : undefined;

		const memoryWindow = Math.max(0, Math.floor(this.cfg.orchestrator.memoryWindow ?? 0));
		const history = this.ensureFrameHistory(totalCells);

		const makePayloadCells = (subset: readonly CellContext[]) =>
			subset.map((c) => ({
				cellId: c.id,
				x: c.x,
				y: c.y,
				self: c.self,
				neighbors: c.neighbors.map((n) => [n.dx, n.dy, n.state] as [number, number, CellState01]),
				history: memoryWindow > 0 ? history[c.id]!.slice(-memoryWindow) : undefined
			}));

		// Initialize per-frame progress immediately (0/total) so the HUD shows a counter
		// while the single upstream request is in flight.
		callbacks?.onBatchProgress?.(0, totalCells, workingGrid);

		// Attempt streaming (if enabled), otherwise single-call-per-frame; then fallback chunking.
		// When parallelChunks > 1 and the grid is large enough, use parallel multi-stream dispatch
		// for dramatically improved throughput (N concurrent Cerebras inference passes).
		const cfgParallel = this.cfg.orchestrator.parallelChunks ?? 0;
		const resolvedParallel = cfgParallel > 0 ? cfgParallel : calculateOptimalParallelism(totalCells, 300);
		const useParallelStreams = this.cfg.orchestrator.frameStreamed && resolvedParallel > 1 && totalCells > 200;

		try {
			if (useParallelStreams) {
				// ── Parallel multi-stream dispatch ──────────────────────────
				await this.decideFrameParallelStreams(
					cells, width, height, generation, latency8, workingGrid,
					decisions, colorsHex, colorStatus8, wantColor,
					makePayloadCells, callbacks, promptConfig
				);
			} else {
			const payloadCells = makePayloadCells(cells);

			if (this.cfg.orchestrator.frameStreamed) {
				const t0 = performance.now();
				const decoder = new TextDecoder();
				const res = await fetch(`${base}/api/nlca/decideFrameStream`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
					body: JSON.stringify({
						apiKey: this.cfg.orchestrator.apiKey,
						model: this.cfg.orchestrator.model.model,
						temperature: this.cfg.orchestrator.model.temperature,
						timeoutMs: this.cfg.orchestrator.cellTimeoutMs,
						maxOutputTokens: Math.max(8192, this.cfg.orchestrator.model.maxOutputTokens),
						width,
						height,
						generation,
						cells: payloadCells.map((c) => ({
							cellId: c.cellId,
							x: c.x,
							y: c.y,
							self: c.self,
							neighborhood: c.neighbors,
							history: c.history
						})),
						promptConfig: {
							...(promptConfig ?? { taskDescription: '', useAdvancedMode: false }),
							compressPayload: this.cfg.orchestrator.compressPayload === true
						}
					})
				});

				if (!res.ok || !res.body) {
					const text = await res.text().catch(() => '');
					throw new Error(text || `decideFrameStream failed (${res.status})`);
				}

				const reader = res.body.getReader();
				let carry = '';
				let completed = 0;
				let lastUiFlushAt = performance.now();
				const uiFlushIntervalMs = 100;
				const uiFlushEveryN = 50;
				let lastUiFlushCompleted = 0;

				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (!value) continue;
					carry += decoder.decode(value, { stream: true });

					while (true) {
						const sep = carry.indexOf('\n\n');
						if (sep < 0) break;
						const block = carry.slice(0, sep);
						carry = carry.slice(sep + 2);

						let eventName = 'message';
						const dataLines: string[] = [];
						for (const ln of block.split('\n')) {
							if (ln.startsWith('event:')) eventName = ln.slice(6).trim();
							else if (ln.startsWith('data:')) dataLines.push(ln.slice(5).trimStart());
						}
						const dataStr = dataLines.join('\n');
						if (!dataStr) continue;

						let payload: any;
						try {
							payload = JSON.parse(dataStr);
						} catch {
							continue;
						}

						if (eventName === 'decision') {
							const cellId = Number(payload.cellId);
							const stateNum = Number(payload.state);
							if (!Number.isFinite(cellId) || cellId < 0 || cellId >= totalCells) continue;
							const state: CellState01 = stateNum === 1 ? 1 : 0;

							workingGrid[cellId] = state;
							decisions.set(cellId, state);
							completed++;

							const latencyMs = performance.now() - t0;
							latency8[cellId] = latencyToU8(latencyMs);

							let colorHex: string | undefined;
							let colorStatus: any;
							if (wantColor && colorsHex && colorStatus8) {
								const c = typeof payload.color === 'string' ? String(payload.color).trim().toUpperCase() : '';
								if (c && /^#[0-9A-F]{6}$/.test(c)) {
									colorHex = c;
									colorStatus = 'valid';
									colorsHex[cellId] = c;
									colorStatus8[cellId] = 1;
								} else {
									colorStatus = 'missing';
									colorStatus8[cellId] = 0;
								}
							}

							callbacks?.onCellComplete?.(
								cellId,
								{ state, colorHex, colorStatus, latencyMs, raw: dataStr, success: true },
								completed,
								totalCells
							);

							const now = performance.now();
							const shouldFlush =
								completed - lastUiFlushCompleted >= uiFlushEveryN || now - lastUiFlushAt >= uiFlushIntervalMs || completed === totalCells;
							if (shouldFlush) {
								lastUiFlushAt = now;
								lastUiFlushCompleted = completed;
								callbacks?.onBatchProgress?.(completed, totalCells, workingGrid);
							}
						} else if (eventName === 'progress') {
							// Server-side progress, still update HUD counter
							const c = Number(payload.completed ?? NaN);
							if (Number.isFinite(c)) callbacks?.onBatchProgress?.(Math.max(completed, c), totalCells, workingGrid);
						} else if (eventName === 'done') {
							// Ensure final flush (but fail loudly if the stream ended incomplete).
							const doneCompleted = Number(payload.completed ?? NaN);
							const doneTotal = Number(payload.total ?? NaN);
							if (Number.isFinite(doneCompleted) && doneCompleted !== totalCells) {
								throw new Error(`Stream ended incomplete: completed=${doneCompleted} expected=${totalCells}`);
							}
							if (Number.isFinite(doneTotal) && doneTotal !== totalCells) {
								throw new Error(`Stream total mismatch: total=${doneTotal} expected=${totalCells}`);
							}
							callbacks?.onBatchProgress?.(totalCells, totalCells, workingGrid);
						} else if (eventName === 'error') {
							throw new Error(String(payload.message ?? 'stream error'));
						}
					}
				}
			} else {
				const { results, frameLatencyMs } = await this.orchestrator.decideFrame(
					{ width, height, generation, cells: payloadCells },
					promptConfig ?? { taskDescription: '', useAdvancedMode: false }
				);

				const l8 = latencyToU8(frameLatencyMs);
				for (let i = 0; i < totalCells; i++) latency8[i] = l8;

				let completed = 0;
				for (const c of cells) {
					const r = results.get(c.id);
					if (!r) continue;
					decisions.set(c.id, r.state);
					workingGrid[c.id] = r.state;
					completed++;
					callbacks?.onCellComplete?.(c.id, r, completed, totalCells);
					if (wantColor && colorsHex && colorStatus8) {
						if (r.colorHex) colorsHex[c.id] = r.colorHex;
						switch (r.colorStatus) {
							case 'valid':
								colorStatus8[c.id] = 1;
								break;
							case 'invalid':
								colorStatus8[c.id] = 2;
								break;
							case 'missing':
							default:
								colorStatus8[c.id] = 0;
								break;
						}
					}
				}
				callbacks?.onBatchProgress?.(totalCells, totalCells, workingGrid);
			}
			} // end else (single-stream / non-streaming path)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);

			// Fall back to parallel non-streaming chunks on any failure.
			// This replaces the old hard-fail for streaming: parallel chunking preserves throughput.
			this.frameBatchedFallbacks++;
			console.warn(`[NLCA] Frame-batched call failed, falling back to parallel chunking: ${msg}`);

			// Use parallel chunk dispatch for better throughput
			await this.decideFrameParallelChunks(
				cells,
				width,
				height,
				generation,
				latency8,
				workingGrid,
				decisions,
				colorsHex,
				colorStatus8,
				wantColor,
				makePayloadCells,
				callbacks,
				promptConfig
			);
		}

		// Update per-cell history window with decided next state (or keep self).
		if (memoryWindow > 0) {
			for (let i = 0; i < totalCells; i++) {
				const self: CellState01 = (prev[i] ?? 0) === 0 ? 0 : 1;
				const next = decisions.get(i) ?? self;
				const h = history[i]!;
				h.push(next);
				if (h.length > memoryWindow) h.splice(0, h.length - memoryWindow);
			}
		}

		return { decisionMap: decisions, colorsHex, colorStatus8 };
	}

	/**
	 * Dispatch frame decisions using parallel chunks for improved throughput.
	 * Chunks are processed concurrently up to `parallelChunks` limit.
	 */
	private async decideFrameParallelChunks(
		cells: readonly CellContext[],
		width: number,
		height: number,
		generation: number,
		latency8: Uint8Array,
		workingGrid: Uint32Array,
		decisions: Map<number, CellState01>,
		colorsHex: Array<string | null> | undefined,
		colorStatus8: Uint8Array | undefined,
		wantColor: boolean,
		makePayloadCells: (subset: readonly CellContext[]) => Array<{
			cellId: number;
			x: number;
			y: number;
			self: CellState01;
			neighbors: Array<[number, number, CellState01]>;
			history?: CellState01[];
		}>,
		callbacks?: NlcaProgressCallback,
		promptConfig?: PromptConfig
	): Promise<void> {
		const totalCells = cells.length;
		const cfgParallel = this.cfg.orchestrator.parallelChunks ?? 0;

		// Calculate chunk size: use adaptive sizing if enabled, otherwise use configured or default
		let chunkSize: number;
		if (this.cfg.orchestrator.chunkSize && this.cfg.orchestrator.chunkSize > 0) {
			// Explicit chunk size configured
			chunkSize = this.cfg.orchestrator.chunkSize;
		} else {
			// Use adaptive chunk sizing based on model context window
			const neighborhoodSize = this.getNeighborhoodSize();
			chunkSize = this.orchestrator.calculateChunkSize(wantColor, neighborhoodSize);
		}
		chunkSize = Math.max(1, chunkSize);

		// Resolve parallelism: 0 means auto
		const parallelChunks = cfgParallel > 0
			? cfgParallel
			: calculateOptimalParallelism(totalCells, chunkSize);

		// Split cells into chunks
		const chunks: CellContext[][] = [];
		for (let start = 0; start < cells.length; start += chunkSize) {
			chunks.push(cells.slice(start, Math.min(cells.length, start + chunkSize)) as CellContext[]);
		}

		console.log(
			`[NLCA] Parallel chunking: ${chunks.length} chunks of ~${chunkSize} cells, ` +
				`parallelism: ${parallelChunks}${cfgParallel === 0 ? ' (auto)' : ''}`
		);

		let completedCells = 0;

		const processChunk = async (chunk: CellContext[]): Promise<void> => {
			const payloadCells = makePayloadCells(chunk);
			const { results, frameLatencyMs } = await this.orchestrator.decideFrame(
				{ width, height, generation, cells: payloadCells },
				promptConfig ?? { taskDescription: '', useAdvancedMode: false }
			);

			// Apply chunk results (thread-safe: each chunk has unique cellIds)
			for (const c of chunk) {
				const r = results.get(c.id);
				if (!r) continue;
				decisions.set(c.id, r.state);
				workingGrid[c.id] = r.state;
				latency8[c.id] = latencyToU8(frameLatencyMs);

				if (wantColor && colorsHex && colorStatus8) {
					if (r.colorHex) colorsHex[c.id] = r.colorHex;
					switch (r.colorStatus) {
						case 'valid':
							colorStatus8[c.id] = 1;
							break;
						case 'invalid':
							colorStatus8[c.id] = 2;
							break;
						case 'missing':
						default:
							colorStatus8[c.id] = 0;
							break;
					}
				}

				completedCells++;
				callbacks?.onCellComplete?.(c.id, r, completedCells, totalCells);
			}

			// Update progress after each chunk completes
			callbacks?.onBatchProgress?.(completedCells, totalCells, workingGrid);
		};

		// Process chunks with bounded parallelism
		await asyncPool(parallelChunks, chunks, async (chunk, idx) => {
			try {
				await processChunk(chunk);
			} catch (err) {
				console.error(`[NLCA] Chunk ${idx} failed:`, err);
			}
		});

		// Final progress update
		callbacks?.onBatchProgress?.(totalCells, totalCells, workingGrid);
	}

	/**
	 * Dispatch frame decisions using parallel SSE streams for maximum throughput.
	 * Each chunk gets its own concurrent streaming request to the Cerebras API,
	 * allowing N inference passes to run simultaneously and merge results as they arrive.
	 */
	private async decideFrameParallelStreams(
		cells: readonly CellContext[],
		width: number,
		height: number,
		generation: number,
		latency8: Uint8Array,
		workingGrid: Uint32Array,
		decisions: Map<number, CellState01>,
		colorsHex: Array<string | null> | undefined,
		colorStatus8: Uint8Array | undefined,
		wantColor: boolean,
		makePayloadCells: (subset: readonly CellContext[]) => Array<{
			cellId: number;
			x: number;
			y: number;
			self: CellState01;
			neighbors: Array<[number, number, CellState01]>;
			history?: CellState01[];
		}>,
		callbacks?: NlcaProgressCallback,
		promptConfig?: PromptConfig
	): Promise<void> {
		const totalCells = cells.length;

		// Resolve parallelism: 0 means auto
		const cfgParallel = this.cfg.orchestrator.parallelChunks ?? 0;

		// Calculate chunk size
		let chunkSize: number;
		if (this.cfg.orchestrator.chunkSize && this.cfg.orchestrator.chunkSize > 0) {
			chunkSize = this.cfg.orchestrator.chunkSize;
		} else {
			const neighborhoodSize = this.getNeighborhoodSize();
			chunkSize = this.orchestrator.calculateChunkSize(wantColor, neighborhoodSize);
		}
		chunkSize = Math.max(1, chunkSize);

		const parallelChunks = cfgParallel > 0
			? cfgParallel
			: calculateOptimalParallelism(totalCells, chunkSize);

		// Split cells into chunks
		const chunks: CellContext[][] = [];
		for (let start = 0; start < cells.length; start += chunkSize) {
			chunks.push(cells.slice(start, Math.min(cells.length, start + chunkSize)) as CellContext[]);
		}

		console.log(
			`[NLCA] Parallel streams: ${chunks.length} chunks of ~${chunkSize} cells, ` +
				`parallelism: ${parallelChunks}${cfgParallel === 0 ? ' (auto)' : ''}`
		);

		// Shared progress tracking (safe: JS single-threaded event loop)
		let completedCells = 0;
		const t0 = performance.now();
		let lastUiFlushAt = t0;
		const uiFlushIntervalMs = 100;
		const uiFlushEveryN = 50;
		let lastUiFlushCompleted = 0;

		callbacks?.onBatchProgress?.(0, totalCells, workingGrid);

		// Process a single chunk via SSE stream
		const processChunkStream = async (chunk: CellContext[], chunkIdx: number): Promise<void> => {
			const payloadCells = makePayloadCells(chunk);
			const decoder = new TextDecoder();

			const res = await fetch(`${base}/api/nlca/decideFrameStream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
				body: JSON.stringify({
					apiKey: this.cfg.orchestrator.apiKey,
					model: this.cfg.orchestrator.model.model,
					temperature: this.cfg.orchestrator.model.temperature,
					timeoutMs: this.cfg.orchestrator.cellTimeoutMs,
					maxOutputTokens: Math.max(8192, this.cfg.orchestrator.model.maxOutputTokens),
					width,
					height,
					generation,
					cells: payloadCells.map((c) => ({
						cellId: c.cellId,
						x: c.x,
						y: c.y,
						self: c.self,
						neighborhood: c.neighbors,
						history: c.history
					})),
					promptConfig: {
						...(promptConfig ?? { taskDescription: '', useAdvancedMode: false }),
						compressPayload: this.cfg.orchestrator.compressPayload === true
					}
				})
			});

			if (!res.ok || !res.body) {
				const text = await res.text().catch(() => '');
				throw new Error(text || `decideFrameStream chunk ${chunkIdx} failed (${res.status})`);
			}

			// Read SSE stream — same parsing logic as the single-stream code path
			const reader = res.body.getReader();
			let carry = '';

			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value) continue;
				carry += decoder.decode(value, { stream: true });

				while (true) {
					const sep = carry.indexOf('\n\n');
					if (sep < 0) break;
					const block = carry.slice(0, sep);
					carry = carry.slice(sep + 2);

					let eventName = 'message';
					const dataLines: string[] = [];
					for (const ln of block.split('\n')) {
						if (ln.startsWith('event:')) eventName = ln.slice(6).trim();
						else if (ln.startsWith('data:')) dataLines.push(ln.slice(5).trimStart());
					}
					const dataStr = dataLines.join('\n');
					if (!dataStr) continue;

					let payload: any;
					try {
						payload = JSON.parse(dataStr);
					} catch {
						continue;
					}

					if (eventName === 'decision') {
						const cellId = Number(payload.cellId);
						const stateNum = Number(payload.state);
						if (!Number.isFinite(cellId) || cellId < 0 || cellId >= width * height) continue;
						const state: CellState01 = stateNum === 1 ? 1 : 0;

						workingGrid[cellId] = state;
						decisions.set(cellId, state);
						completedCells++;

						const latencyMs = performance.now() - t0;
						latency8[cellId] = latencyToU8(latencyMs);

						let colorHex: string | undefined;
						let colorStatus: any;
						if (wantColor && colorsHex && colorStatus8) {
							const c = typeof payload.color === 'string' ? String(payload.color).trim().toUpperCase() : '';
							if (c && /^#[0-9A-F]{6}$/.test(c)) {
								colorHex = c;
								colorStatus = 'valid';
								colorsHex[cellId] = c;
								colorStatus8[cellId] = 1;
							} else {
								colorStatus = 'missing';
								colorStatus8[cellId] = 0;
							}
						}

						callbacks?.onCellComplete?.(
							cellId,
							{ state, colorHex, colorStatus, latencyMs, raw: dataStr, success: true },
							completedCells,
							totalCells
						);

						// Throttled UI flush (shared across all concurrent streams)
						const now = performance.now();
						const shouldFlush =
							completedCells - lastUiFlushCompleted >= uiFlushEveryN ||
							now - lastUiFlushAt >= uiFlushIntervalMs ||
							completedCells === totalCells;
						if (shouldFlush) {
							lastUiFlushAt = now;
							lastUiFlushCompleted = completedCells;
							callbacks?.onBatchProgress?.(completedCells, totalCells, workingGrid);
						}
					} else if (eventName === 'error') {
						throw new Error(String(payload.message ?? `stream error (chunk ${chunkIdx})`));
					}
				}
			}
		};

		// Dispatch all chunks via bounded parallelism
		await asyncPool(parallelChunks, chunks, async (chunk, idx) => {
			try {
				await processChunkStream(chunk, idx);
			} catch (err) {
				console.error(`[NLCA] Stream chunk ${idx} failed:`, err);
			}
		});

		// Final progress update
		callbacks?.onBatchProgress?.(totalCells, totalCells, workingGrid);
	}

	private async decideCells(
		cells: readonly CellContext[],
		width: number,
		height: number,
		generation: number,
		latency8: Uint8Array,
		prev: Uint32Array,
		callbacks?: NlcaProgressCallback,
		promptConfig?: PromptConfig
	): Promise<{
		decisionMap: Map<number, CellState01>;
		colorsHex?: Array<string | null>;
		colorStatus8?: Uint8Array;
	}> {
		if (this.cfg.orchestrator.frameBatched) {
			return await this.decideFrameBatched(cells, width, height, generation, latency8, prev, callbacks, promptConfig);
		}

		const decisions = new Map<number, CellState01>();
		const totalCells = cells.length;

		const wantColor = promptConfig?.cellColorHexEnabled === true;
		const colorsHex = wantColor ? new Array<string | null>(totalCells).fill(null) : undefined;
		const colorStatus8 = wantColor ? new Uint8Array(totalCells) : undefined; // 0=missing, 1=valid, 2=invalid

		let successCount = 0;
		let failCount = 0;
		let totalLatency = 0;
		let lastLogTime = Date.now();
		let lastBatchTime = Date.now();
		let completedCount = 0;
		const logInterval = 2000; // Log progress every 2 seconds
		const batchUpdateInterval = 500; // Update UI every 500ms

		const maxConcurrency = Math.max(1, this.cfg.orchestrator.maxConcurrency);
		const batchSize = Math.max(1, Math.floor(this.cfg.orchestrator.batchSize || totalCells));

		console.log(
			`[NLCA] Generation ${generation} starting - ${totalCells} cells, ` +
				`batchSize: ${batchSize}, upstream concurrency: ${maxConcurrency}`
		);
		const genStartTime = performance.now();

		// Create a working grid for streaming updates
		const workingGrid = new Uint32Array(prev);

		for (let start = 0; start < cells.length; start += batchSize) {
			const chunk = cells.slice(start, Math.min(cells.length, start + batchSize));

			const items = chunk.map((cell) => {
				const agent = this.agentManager.getAgent(cell.id);
				const req: NlcaCellRequest = {
					cellId: cell.id,
					x: cell.x,
					y: cell.y,
					self: cell.self,
					neighbors: cell.neighbors,
					generation,
					runId: this.cfg.runId,
					width,
					height
				};
				return { agent, req };
			});

			const resultMap = await this.orchestrator.decideCellsBatch(items, promptConfig);

			for (const cell of chunk) {
				const result = resultMap.get(cell.id);
				if (!result) continue;

				decisions.set(cell.id, result.state);
				workingGrid[cell.id] = result.state;
				latency8[cell.id] = latencyToU8(result.latencyMs);
				totalLatency += result.latencyMs;

				if (wantColor && colorsHex && colorStatus8) {
					if (result.colorHex) colorsHex[cell.id] = result.colorHex;
					switch (result.colorStatus) {
						case 'valid':
							colorStatus8[cell.id] = 1;
							break;
						case 'invalid':
							colorStatus8[cell.id] = 2;
							break;
						case 'missing':
						default:
							colorStatus8[cell.id] = 0;
							break;
					}
				}

				if (result.success) successCount++;
				else failCount++;

				completedCount++;
				callbacks?.onCellComplete?.(cell.id, result, completedCount, totalCells);
			}

			// Log progress periodically
			const now = Date.now();
			if (now - lastLogTime >= logInterval) {
				const pct = ((completedCount / totalCells) * 100).toFixed(1);
				console.log(`[NLCA] Progress: ${completedCount}/${totalCells} cells (${pct}%)`);
				lastLogTime = now;
			}

			// Send batch progress for UI updates (streaming grid)
			if (callbacks?.onBatchProgress && now - lastBatchTime >= batchUpdateInterval) {
				callbacks.onBatchProgress(completedCount, totalCells, workingGrid);
				lastBatchTime = now;
			}
		}

		// Final batch progress update
		callbacks?.onBatchProgress?.(totalCells, totalCells, workingGrid);

		const genDuration = performance.now() - genStartTime;
		const avgLatency = totalLatency / totalCells;

		console.log(
			`[NLCA] Generation ${generation} complete - ` +
			`${successCount} success, ${failCount} failed, ` +
			`avg latency: ${avgLatency.toFixed(0)}ms, ` +
			`total time: ${(genDuration / 1000).toFixed(1)}s`
		);

		return { decisionMap: decisions, colorsHex, colorStatus8 };
	}

	async step(
		prev: Uint32Array,
		width: number,
		height: number,
		generation: number,
		callbacks?: NlcaProgressCallback,
		promptConfig?: PromptConfig
	): Promise<NlcaStepResult> {
		const expected = width * height;
		if (prev.length !== expected) {
			throw new Error(`NLCA stepper: grid length mismatch (have ${prev.length}, expected ${expected})`);
		}

		// Ensure agent manager has correct dimensions
		const dims = this.agentManager.getDimensions();
		if (dims.width !== width || dims.height !== height) {
			this.agentManager.reset(width, height);
		}

		const contexts = await this.buildContexts(prev, width, height);

		const latency8 = new Uint8Array(expected);
		const changed01 = new Uint8Array(expected);

		const { decisionMap, colorsHex, colorStatus8 } = await this.decideCells(
			contexts,
			width,
			height,
			generation,
			latency8,
			prev,
			callbacks,
			promptConfig
		);

		const next = new Uint32Array(expected);
		let changedCount = 0;

		for (let i = 0; i < expected; i++) {
			const self: CellState01 = (prev[i] ?? 0) === 0 ? 0 : 1;
			const v = decisionMap.get(i) ?? self;
			next[i] = v;
			if (v !== self) {
				changed01[i] = 1;
				changedCount++;
			} else {
				changed01[i] = 0;
			}
		}

		console.log(`[NLCA] Generation ${generation}: ${changedCount} cells changed state`);

		const metrics: NlcaCellMetricsFrame = { latency8, changed01 };
		return { next, metrics, colorsHex, colorStatus8 };
	}
}
