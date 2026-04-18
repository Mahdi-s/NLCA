import type { BoundaryMode } from '$lib/stores/simulation.svelte.js';
import { base } from '$app/paths';
import type { CellContext, NlcaCellMetricsFrame, NlcaCellRequest, NlcaOrchestratorConfig, NlcaStepResult, NlcaNeighborhood, CellState01 } from './types.js';
import { extractCellContext } from './neighborhood.js';
import { NlcaOrchestrator, type CellDecisionResult, type NlcaCostStats, type DebugLogEntry } from './orchestrator.js';
import { CellAgentManager } from './agentManager.js';
import type { PromptConfig } from './prompt.js';

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

export class NlcaStepper {
	private orchestrator: NlcaOrchestrator;
	private agentManager: CellAgentManager;
	private cfg: NlcaStepperConfig;
	private frameHistory: Array<CellState01[]> | null = null;
	private frameBatchedFrames = 0;
	private frameBatchedFallbacks = 0;

	constructor(cfg: NlcaStepperConfig, agentManager: CellAgentManager) {
		this.cfg = cfg;
		this.agentManager = agentManager;
		this.orchestrator = new NlcaOrchestrator(cfg.orchestrator);
		console.log(`[NLCA] Stepper initialized - runId: ${cfg.runId}, neighborhood: ${cfg.neighborhood}`);
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

	private buildContexts(prev: Uint32Array, width: number, height: number): CellContext[] {
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
		try {
			const payloadCells = makePayloadCells(cells);

			if (this.cfg.orchestrator.frameStreamed) {
				const t0 = performance.now();
				const decoder = new TextDecoder();
				const provider = this.cfg.orchestrator.apiProvider ?? 'openrouter';
				const activeKey =
					provider === 'sambanova'
						? this.cfg.orchestrator.sambaNovaApiKey ?? ''
						: this.cfg.orchestrator.apiKey ?? '';
				const res = await fetch(`${base}/api/nlca/decideFrameStream`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
					body: JSON.stringify({
						apiProvider: provider,
						apiKey: activeKey,
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
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (this.cfg.orchestrator.frameStreamed) {
				// Hard-fail streamed frame-batched runs so provider incompatibilities are obvious.
				// (No silent “success” and no automatic fallback to chunking.)
				console.warn(`[NLCA] Frame-batched streamed call failed (no fallback): ${msg}`);
				throw e;
			}

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
		const parallelChunks = Math.max(1, this.cfg.orchestrator.parallelChunks ?? 4);
		
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

		// Split cells into chunks
		const chunks: CellContext[][] = [];
		for (let start = 0; start < cells.length; start += chunkSize) {
			chunks.push(cells.slice(start, Math.min(cells.length, start + chunkSize)) as CellContext[]);
		}

		console.log(
			`[NLCA] Parallel chunking: ${chunks.length} chunks of ~${chunkSize} cells, ` +
				`parallelism: ${parallelChunks}`
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

		// Process chunks with bounded parallelism. Fail fast on first chunk error so we
		// do not keep burning quota after a hard upstream failure (rate limit, invalid JSON).
		await asyncPool(parallelChunks, chunks, async (chunk, idx) => {
			try {
				await processChunk(chunk);
			} catch (err) {
				console.error(`[NLCA] Chunk ${idx} failed:`, err);
				throw err;
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

		const contexts = this.buildContexts(prev, width, height);

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
