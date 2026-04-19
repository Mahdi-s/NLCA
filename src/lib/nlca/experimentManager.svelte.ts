/**
 * ExperimentManager — owns N independent NLCA experiments.
 * Each experiment has its own NlcaStepper, NlcaTape, NlcaFrameBuffer, and CellAgentManager.
 * Svelte 5 reactive state via $state runes.
 */

import {
	NlcaTape,
	ExperimentIndex,
	pack01ToBitset,
	encodeMetrics,
	unpackBitsetTo01,
	buildFrameLine
} from './tape.js';
import { NlcaStepper } from './stepper.js';
import type { BufferStatus } from './frameBuffer.js';
import { CellAgentManager } from './agentManager.js';
import type {
	ExperimentConfig,
	ExperimentStatus,
	ExperimentMeta,
	NlcaOrchestratorConfig,
	NlcaNeighborhood
} from './types.js';
import type { PromptConfig } from './prompt.js';
import { estimateExperimentCost, getModelPricing } from './costEstimator.js';

export interface Experiment {
	id: string;
	label: string;
	config: ExperimentConfig;
	status: ExperimentStatus;
	stepper: NlcaStepper | null;
	tape: NlcaTape;
	frameBuffer: null;
	agentManager: CellAgentManager | null;
	progress: { current: number; target: number };
	createdAt: number;
	dbFilename: string;
	errorMessage?: string;
	currentGrid: Uint32Array | null;
	currentColorsHex: Array<string | null> | null;
	currentColorStatus8: Uint8Array | null;
	currentGeneration: number;
	bufferStatus: BufferStatus | null;
	totalCost: number;
	/** Full-run projection in USD — what we expect this experiment to cost at
	 * completion. Refreshed when pricing lands (see refreshEstimatedCost) or
	 * when progress.target changes. 0 while pricing is unknown. */
	estimatedCost: number;
	/** True when the provider didn't publish per-token pricing for this model.
	 * UI hides the dollar value in that case so the user isn't misled. */
	pricingUnknown: boolean;
	totalCalls: number;
	lastLatencyMs: number | null;
	/** True when this experiment's tape file is missing and frames cannot be loaded. */
	noTapeData?: boolean;
}

function generateDbFilename(config: ExperimentConfig): string {
	const ts = Date.now();
	const modelSlug = config.model.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 30);
	return `/nlca-${ts}-${modelSlug}-${config.gridWidth}x${config.gridHeight}.sqlite3`;
}

function generateLabel(config: ExperimentConfig, index: number): string {
	const modelShort = config.model.split('/').pop() ?? config.model;
	const task = config.taskDescription?.trim();
	const taskPreview = task
		? (task.length > 40 ? task.slice(0, 37) + '…' : task)
		: `Exp ${index}`;
	const providerTag = config.apiProvider === 'sambanova' ? 'SN' : 'OR';
	return `[${providerTag}] ${taskPreview} · ${modelShort} · ${config.gridWidth}×${config.gridHeight}`;
}

function buildOrchestratorConfig(config: ExperimentConfig): NlcaOrchestratorConfig {
	return {
		apiProvider: config.apiProvider ?? 'openrouter',
		apiKey: config.apiKey,
		sambaNovaApiKey: config.sambaNovaApiKey,
		model: {
			model: config.model,
			temperature: config.temperature,
			maxOutputTokens: config.maxOutputTokens
		},
		maxConcurrency: config.maxConcurrency,
		batchSize: config.batchSize,
		frameBatched: config.frameBatched,
		frameStreamed: config.frameStreamed,
		memoryWindow: config.memoryWindow,
		cellTimeoutMs: config.cellTimeoutMs,
		compressPayload: config.compressPayload,
		deduplicateRequests: config.deduplicateRequests
	};
}

function buildPromptConfig(config: ExperimentConfig): PromptConfig {
	return {
		taskDescription: config.taskDescription,
		useAdvancedMode: config.useAdvancedMode,
		advancedTemplate: config.advancedTemplate,
		cellColorHexEnabled: config.cellColorEnabled
	};
}

export interface PlaybackState {
	id: string;
	currentFrame: number;
	totalFrames: number;
	isPaused: boolean;
}

/** Per-frame animation driver passed in by the UI coordinator (MainAppNlca).
 * Resolves when the transition completes, or early when cancelled. */
export type PlaybackAnimator = (
	currentGrid: Uint32Array | null,
	nextGrid: Uint32Array,
	currentColorsHex: Array<string | null> | null,
	nextColorsHex: Array<string | null> | null,
	width: number,
	height: number,
	totalMs: number
) => Promise<void>;

export class ExperimentManager {
	experiments = $state<Record<string, Experiment>>({});
	activeId = $state<string | null>(null);
	playback = $state<PlaybackState | null>(null);
	experimentList = $derived(Object.values(this.experiments));
	private experimentCounter = 0;
	private index: ExperimentIndex;
	private computeAbortControllers = new Map<string, AbortController>();
	/** Per-experiment generation counter used to void stale async rehydrates when
	 * the user switches active experiments faster than disk reads complete. */
	private rehydrateToken = new Map<string, number>();
	/** Token bumped on every startPlayback/stopPlayback so in-flight loops can
	 * detect they've been superseded and bail out cleanly. */
	private playbackToken = 0;
	private playbackCancelAnim: (() => void) | null = null;

	constructor() {
		this.index = new ExperimentIndex();
	}

	/** Append or merge a row into the local runs.csv. Fire-and-forget — any
	 * failure is logged but never throws (the CSV is a convenience artefact;
	 * the SQLite index remains the authoritative state store). */
	private async syncCsvRow(exp: Experiment, extra?: { errorMessage?: string }): Promise<void> {
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
					createdAt: exp.createdAt,
					updatedAt: Date.now(),
					dbFilename: exp.dbFilename,
					errorMessage: extra?.errorMessage ?? exp.errorMessage ?? ''
				})
			});
		} catch (err) {
			// Production build / no server → silently skip.
			if (typeof window !== 'undefined') {
				console.debug('[ExperimentManager] CSV sync skipped:', err);
			}
		}
	}

	private async deleteCsvRow(id: string): Promise<void> {
		try {
			await fetch(`/api/nlca-runs-csv?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
		} catch {
			// ignore
		}
	}

	/** Write the meta.json snapshot for an experiment. Fire-and-forget — the
	 * JSONL tape is a convenience artefact; SQLite remains authoritative. */
	private async syncJsonlMeta(exp: Experiment): Promise<void> {
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
						config: exp.config
					}
				})
			});
		} catch (err) {
			if (typeof window !== 'undefined') {
				console.debug('[ExperimentManager] JSONL meta sync skipped:', err);
			}
		}
	}

	/** Append one pre-serialised frame line to the experiment's frames.jsonl. */
	private async appendJsonlFrame(runId: string, frameLine: string): Promise<void> {
		try {
			await fetch('/api/nlca-frames-jsonl', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ runId, frame: frameLine })
			});
		} catch (err) {
			if (typeof window !== 'undefined') {
				console.debug('[ExperimentManager] JSONL frame sync skipped:', err);
			}
		}
	}

	private async deleteJsonlRun(id: string): Promise<void> {
		try {
			await fetch(`/api/nlca-frames-jsonl?runId=${encodeURIComponent(id)}`, { method: 'DELETE' });
		} catch {
			// ignore
		}
	}

	/** Fetch live pricing for this experiment's model and project the full-run
	 * cost at completion. Called when the experiment is created and whenever
	 * the target frames or config changes. No-op when pricing is unavailable
	 * (leaves the UI in its "pricing unknown" state). */
	async refreshEstimatedCost(id: string): Promise<void> {
		const exp = this.experiments[id];
		if (!exp) return;
		const provider = exp.config.apiProvider === 'sambanova' ? 'sambanova' : 'openrouter';
		const apiKey =
			provider === 'sambanova' ? exp.config.sambaNovaApiKey ?? '' : exp.config.apiKey ?? '';
		try {
			const pricing = await getModelPricing(provider, exp.config.model, apiKey);
			if (!this.experiments[id]) return;
			const est = estimateExperimentCost(exp.config, pricing);
			exp.estimatedCost = est.cost;
			exp.pricingUnknown = est.pricingUnknown;
		} catch (err) {
			console.debug('[ExperimentManager] refreshEstimatedCost failed:', err);
		}
	}

	/** Fetch a frame from the disk-backed JSONL tape. Pass `generation` to
	 * read a specific frame (used by scrub / prev / next), or omit to read
	 * the latest (used by rehydrate-on-load). The browser's sqlite-wasm
	 * handle is in-memory only in dev mode, so seeks that miss SQLite have
	 * to go to disk here. */
	private async fetchJsonlFrame(
		id: string,
		generation?: number
	): Promise<{
		generation: number;
		width: number;
		height: number;
		grid01: number[];
		colorsHex: Array<string | null> | null;
		frameCount: number;
	} | null> {
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

	get active(): Experiment | null {
		if (!this.activeId) return null;
		return this.experiments[this.activeId] ?? null;
	}

	/**
	 * Attempt to load experiments from the local runs.csv first (dev-mode only).
	 * Falls back silently to the SQLite index if CSV is unavailable — the CSV is
	 * the user-visible artefact and this keeps the Runs panel populated even when
	 * SQLite hasn't been migrated in a new checkout.
	 */
	private async loadFromCsvIfPresent(): Promise<Array<{ id: string }>> {
		try {
			const res = await fetch('/api/nlca-runs-csv');
			if (!res.ok) return [];
			const data = (await res.json()) as { rows?: Array<Record<string, string>> };
			const rows = data?.rows ?? [];
			for (const row of rows) {
				if (!row.id || row.id in this.experiments) continue;
				const config: ExperimentConfig = {
					apiKey: '', // never persisted to CSV
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
				const tape = new NlcaTape(row.dbFilename || `/${row.id}.sqlite3`);
				// Don't init — defer to lazy init when the run is actually opened.
				const statusRaw = (row.status as Experiment['status']) || 'paused';
				const status: Experiment['status'] = statusRaw === 'running' ? 'paused' : statusRaw;
				const createdAt = Number(row.createdAt) || Date.now();
				const exp: Experiment = {
					id: row.id,
					label: row.label || row.id,
					config,
					status,
					stepper: null,
					tape,
					frameBuffer: null,
					agentManager: null,
					progress: {
						current: Number(row.frameCount) || 0,
						target: config.targetFrames
					},
					createdAt,
					dbFilename: row.dbFilename || '',
					errorMessage: row.errorMessage || undefined,
					currentGrid: null,
					currentColorsHex: null,
					currentColorStatus8: null,
					currentGeneration: Number(row.frameCount) || 0,
					bufferStatus: null,
					totalCost: 0,
					estimatedCost: 0,
					pricingUnknown: true,
					totalCalls: 0,
					lastLatencyMs: null
				};
				this.experiments[row.id] = exp;
				this.experimentCounter++;
				void this.refreshEstimatedCost(row.id);
			}
			return rows.map((r) => ({ id: r.id }));
		} catch {
			return [];
		}
	}

	async loadFromIndex(): Promise<void> {
		// Prefer CSV (authoritative for the Runs panel) — it's a single plain file
		// the user can open in Excel/grep/Python and is the spec'd data source.
		await this.loadFromCsvIfPresent();

		await this.index.init();
		const metas = await this.index.list();
		for (const meta of metas) {
			if (meta.id in this.experiments) continue;
			const tape = new NlcaTape(meta.dbFilename);
			await tape.init();
			const exp: Experiment = {
				id: meta.id,
				label: meta.label,
				config: meta.config,
				status: meta.status === 'running' ? 'paused' : meta.status,
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
				totalCost: 0,
				estimatedCost: 0,
				pricingUnknown: true,
				totalCalls: 0,
				lastLatencyMs: null
			};
			this.experiments[meta.id] = exp;
			this.experimentCounter++;
		}
	}

	async createExperiment(config: ExperimentConfig, autoStart = true): Promise<string> {
		const id = crypto.randomUUID();
		this.experimentCounter++;
		const label = generateLabel(config, this.experimentCounter);
		const dbFilename = generateDbFilename(config);

		const tape = new NlcaTape(dbFilename);
		await tape.init();

		const exp: Experiment = {
			id,
			label,
			config,
			status: 'paused',
			stepper: null,
			tape,
			frameBuffer: null,
			agentManager: null,
			progress: { current: 0, target: config.targetFrames },
			createdAt: Date.now(),
			dbFilename,
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

		this.experiments[id] = exp;
		this.activeId = id;
		void this.refreshEstimatedCost(id);

		await this.index.init();
		await this.index.register({
			id,
			label,
			dbFilename,
			config,
			status: 'paused',
			createdAt: exp.createdAt,
			updatedAt: exp.createdAt,
			frameCount: 0
		});
		void this.syncCsvRow(exp);

		if (autoStart) {
			await this.startExperiment(id);
		}

		return id;
	}

	async startExperiment(id: string): Promise<void> {
		const exp = this.experiments[id];
		if (!exp) throw new Error(`Experiment ${id} not found`);

		const orchestratorConfig = buildOrchestratorConfig(exp.config);
		// CellAgentManager requires (width, height)
		const agentManager = new CellAgentManager(exp.config.gridWidth, exp.config.gridHeight);
		const stepper = new NlcaStepper(
			{
				runId: id,
				neighborhood: exp.config.neighborhood,
				boundary: 'torus',
				orchestrator: orchestratorConfig
			},
			agentManager
		);

		await exp.tape.startRun({
			runId: id,
			createdAt: Date.now(),
			width: exp.config.gridWidth,
			height: exp.config.gridHeight,
			neighborhood: exp.config.neighborhood,
			model: exp.config.model,
			maxConcurrency: exp.config.maxConcurrency,
			configJson: JSON.stringify(exp.config)
		});

		exp.stepper = stepper;
		exp.agentManager = agentManager;
		exp.status = 'running';

		await this.index.updateStatus(id, 'running');
		void this.syncCsvRow(exp);
		void this.syncJsonlMeta(exp);

		if (!exp.currentGrid) {
			const totalCells = exp.config.gridWidth * exp.config.gridHeight;
			exp.currentGrid = new Uint32Array(totalCells);
		}

		this.startComputeLoop(id);
	}

	private startComputeLoop(id: string): void {
		const controller = new AbortController();
		this.computeAbortControllers.set(id, controller);

		const loop = async () => {
			const exp = this.experiments[id];
			if (!exp || !exp.stepper || !exp.currentGrid) return;

			while (!controller.signal.aborted && exp.status === 'running' && exp.progress.current < exp.progress.target) {
				try {
					const generation = exp.progress.current + 1;
					const promptConfig = buildPromptConfig(exp.config);

					const result = await exp.stepper.step(
						exp.currentGrid,
						exp.config.gridWidth,
						exp.config.gridHeight,
						generation,
						undefined,
						promptConfig
					);

					if (controller.signal.aborted) break;

					exp.currentGrid = result.next;
					exp.currentColorsHex = result.colorsHex ?? null;
					exp.currentColorStatus8 = result.colorStatus8 ?? null;
					exp.currentGeneration = generation;
					exp.progress = { current: generation, target: exp.progress.target };

					if (exp.stepper) {
						const stats = exp.stepper.getCostStats();
						exp.totalCost = stats.totalCost;
						exp.totalCalls = stats.callCount;
					}
					if (result.metrics && result.metrics.latency8.length > 0) {
						let sum = 0;
						for (let j = 0; j < result.metrics.latency8.length; j++) {
							sum += result.metrics.latency8[j] ?? 0;
						}
						exp.lastLatencyMs = (sum / result.metrics.latency8.length) * 10;
					}

					const now = Date.now();
					await exp.tape.appendFrame({
						runId: id,
						generation,
						createdAt: now,
						stateBits: pack01ToBitset(result.next),
						metrics: result.metrics ? encodeMetrics(result.metrics) : undefined,
						colorsHex: result.colorsHex ?? undefined
					});

					void this.appendJsonlFrame(
						id,
						buildFrameLine(
							generation,
							now,
							result.next,
							exp.config.gridWidth,
							exp.config.gridHeight,
							result.colorsHex ?? null,
							result.metrics ?? null
						)
					);

					if (generation % 5 === 0) {
						await this.index.updateStatus(id, 'running', generation);
						void this.syncCsvRow(exp);
						void this.syncJsonlMeta(exp);
					}
				} catch (err) {
					if (controller.signal.aborted) break;
					let msg = err instanceof Error ? err.message : String(err);
					// Try to extract JSON error from HTML responses
					const jsonMatch = msg.match(/"message":"([^"]+)"/);
					if (jsonMatch) msg = jsonMatch[1];

					// Daily / long-window rate-limit responses — surfaced as HTTP 429 by the
					// server, commonly with phrases like "exceed rate limit", "duration_s:
					// 86400", or "Rate limit exceeded". These are not bugs to retry around;
					// the quota resets later. Pause the experiment instead of erroring so
					// the user can resume tomorrow without losing progress.
					const isRateLimit =
						/\bHTTP\s+429\b|rate\s*limit|rate_limit_exceeded|Request would exceed rate limit/i.test(
							msg
						);
					this.computeAbortControllers.delete(id);
					if (isRateLimit) {
						exp.status = 'paused';
						exp.errorMessage = `Rate limit — paused. Resume when your provider quota resets. (${msg.slice(0, 160)})`;
						await this.index.updateStatus(id, 'paused', exp.progress.current, exp.errorMessage);
						void this.syncCsvRow(exp);
						void this.syncJsonlMeta(exp);
						console.warn(
							`[ExperimentManager] Experiment ${id} paused on rate limit:`,
							msg.slice(0, 200)
						);
						return;
					}

					exp.status = 'error';
					exp.errorMessage = msg.slice(0, 200);
					await this.index.updateStatus(id, 'error', exp.progress.current, exp.errorMessage);
					void this.syncCsvRow(exp);
					void this.syncJsonlMeta(exp);
					console.error(`[ExperimentManager] Experiment ${id} error:`, err);
					return;
				}
			}

			if (!controller.signal.aborted && exp.progress.current >= exp.progress.target) {
				exp.status = 'completed';
				await this.index.updateStatus(id, 'completed', exp.progress.current);
				void this.syncCsvRow(exp);
				void this.syncJsonlMeta(exp);
			}
		};

		loop();
	}

	/**
	 * Replay saved frames 1..frameCount with a per-cell staggered animation
	 * between each pair of consecutive frames, starting from an empty grid so
	 * the first frame also "comes to life" rather than snapping on.
	 *
	 * @param id           Experiment to play back.
	 * @param animator     Canvas-level animation primitive (see PlaybackAnimator).
	 * @param getFrameMs   Called before each frame transition to read the user's
	 *                     current speed knob; returns the desired per-transition
	 *                     duration in milliseconds.
	 * @param onCancelAnim Optional hook invoked when playback stops — lets the
	 *                     caller cancel any in-flight animation immediately.
	 */
	async startPlayback(
		id: string,
		animator: PlaybackAnimator,
		getFrameMs: () => number,
		onCancelAnim?: () => void
	): Promise<void> {
		const exp = this.experiments[id];
		if (!exp || exp.progress.current <= 0) return;
		this.stopPlayback();

		const token = ++this.playbackToken;
		if (onCancelAnim) this.playbackCancelAnim = onCancelAnim;
		this.activeId = id;
		const totalFrames = exp.progress.current;
		this.playback = { id, currentFrame: 0, totalFrames, isPaused: false };

		let prevGrid: Uint32Array | null = null;
		let prevColorsHex: Array<string | null> | null = null;

		for (let gen = 1; gen <= totalFrames; gen++) {
			if (this.playbackToken !== token) return; // superseded
			// Wait out any paused state, bailing if the user cancels or restarts.
			while (this.playback && this.playbackToken === token && this.playback.isPaused) {
				await new Promise((r) => setTimeout(r, 80));
			}
			if (this.playbackToken !== token || !this.playback) return;

			const frame = await this.fetchJsonlFrame(id, gen);
			if (this.playbackToken !== token) return;
			if (!frame) continue;

			const totalCells = frame.width * frame.height;
			const nextGrid = new Uint32Array(totalCells);
			for (let i = 0; i < totalCells; i++) nextGrid[i] = frame.grid01[i] ?? 0;

			const frameMs = Math.max(200, getFrameMs());
			const frameStart = performance.now();
			await animator(
				prevGrid,
				nextGrid,
				prevColorsHex,
				frame.colorsHex,
				frame.width,
				frame.height,
				frameMs
			);

			// Pad to the target frame duration even when the diff is tiny/empty,
			// so successive identical frames still pace with the user's speed
			// setting rather than flashing past in one animation frame.
			if (this.playbackToken === token && this.playback && !this.playback.isPaused) {
				const elapsed = performance.now() - frameStart;
				const hold = Math.max(0, frameMs - elapsed);
				if (hold > 8) await new Promise((r) => setTimeout(r, hold));
			}

			if (this.playbackToken !== token || !this.playback) return;

			// Snap the experiment state to the just-animated frame so the scrubber
			// and HUD follow along.
			exp.currentGrid = nextGrid;
			exp.currentGeneration = gen;
			exp.currentColorsHex = frame.colorsHex;
			if (frame.colorsHex) {
				const status = new Uint8Array(totalCells);
				for (let i = 0; i < totalCells; i++) status[i] = frame.colorsHex[i] != null ? 1 : 0;
				exp.currentColorStatus8 = status;
			} else {
				exp.currentColorStatus8 = null;
			}

			this.playback = { id, currentFrame: gen, totalFrames, isPaused: false };
			prevGrid = nextGrid;
			prevColorsHex = frame.colorsHex;
		}

		if (this.playbackToken === token) {
			this.playback = null;
			this.playbackCancelAnim = null;
		}
	}

	pausePlayback(): void {
		if (this.playback) this.playback = { ...this.playback, isPaused: true };
	}

	resumePlayback(): void {
		if (this.playback) this.playback = { ...this.playback, isPaused: false };
	}

	/** Cancel any in-flight playback loop + in-flight canvas animation. Safe to
	 * call when nothing is playing. */
	stopPlayback(): void {
		this.playbackToken++; // invalidate any running loop
		if (this.playbackCancelAnim) {
			const fn = this.playbackCancelAnim;
			this.playbackCancelAnim = null;
			try { fn(); } catch { /* ignore */ }
		}
		this.playback = null;
	}

	async pauseExperiment(id: string): Promise<void> {
		const exp = this.experiments[id];
		if (!exp || exp.status !== 'running') return;

		const controller = this.computeAbortControllers.get(id);
		if (controller) {
			controller.abort();
			this.computeAbortControllers.delete(id);
		}

		exp.status = 'paused';
		await this.index.updateStatus(id, 'paused', exp.progress.current);
		void this.syncCsvRow(exp);
		void this.syncJsonlMeta(exp);
	}

	async resumeExperiment(id: string): Promise<void> {
		const exp = this.experiments[id];
		if (!exp || exp.status !== 'paused') return;

		if (!exp.stepper) {
			await this.startExperiment(id);
		} else {
			exp.status = 'running';
			await this.index.updateStatus(id, 'running', exp.progress.current);
			void this.syncJsonlMeta(exp);
			this.startComputeLoop(id);
		}
	}

	async deleteExperiment(id: string): Promise<void> {
		const controller = this.computeAbortControllers.get(id);
		if (controller) {
			controller.abort();
			this.computeAbortControllers.delete(id);
		}

		delete this.experiments[id];
		await this.index.delete(id);
		void this.deleteCsvRow(id);
		void this.deleteJsonlRun(id);

		if (this.activeId === id) {
			const remaining = Object.keys(this.experiments);
			this.activeId = remaining.length > 0 ? remaining[0] : null;
		}
	}

	setActive(id: string): void {
		if (!(id in this.experiments)) return;
		this.activeId = id;
		const exp = this.experiments[id];
		if (!exp) return;
		// Running experiments have fresh in-memory state from the compute loop —
		// skip rehydrate so we don't race the loop. For any other status, refresh
		// from disk in case a prior session or sibling tab advanced the tape.
		if (exp.status === 'running') return;
		if (exp.progress.current <= 0) return;
		const token = (this.rehydrateToken.get(id) ?? 0) + 1;
		this.rehydrateToken.set(id, token);
		void this.rehydrateFromTape(id, token).catch((err) => {
			console.warn(`[ExperimentManager] Failed to rehydrate grid for ${id}:`, err);
		});
	}

	/** Reads the actual latest frame count from the DB, updates progress, then seeks to that frame.
	 * Falls back to the disk-backed JSONL tape when SQLite has no data — the
	 * browser's sqlite-wasm handle is in-memory only in dev mode so SQLite
	 * won't survive a page reload, but the JSONL file will. */
	private async rehydrateFromTape(id: string, token: number): Promise<void> {
		const exp = this.experiments[id];
		if (!exp) return;
		try {
			const fileExists = await exp.tape.fileExists();
			if (this.rehydrateToken.get(id) !== token) return;

			let latestGen = fileExists ? await exp.tape.getLatestGeneration(id) : 0;
			if (this.rehydrateToken.get(id) !== token) return;

			if (fileExists && latestGen > 0) {
				exp.noTapeData = false;
				if (latestGen !== exp.progress.current) {
					exp.progress = { current: latestGen, target: exp.progress.target };
					exp.currentGeneration = latestGen;
				}
				await this.seekToGeneration(id, latestGen);
				if (this.rehydrateToken.get(id) !== token) return;
				return;
			}

			// SQLite has no rows for this run — fall back to the on-disk JSONL tape.
			const jsonl = await this.fetchJsonlFrame(id);
			if (this.rehydrateToken.get(id) !== token) return;
			if (jsonl) {
				const totalCells = jsonl.width * jsonl.height;
				const grid = new Uint32Array(totalCells);
				for (let i = 0; i < totalCells; i++) grid[i] = jsonl.grid01[i] ?? 0;
				exp.currentGrid = grid;
				exp.currentGeneration = jsonl.generation;
				exp.currentColorsHex = jsonl.colorsHex;
				if (jsonl.colorsHex) {
					const status = new Uint8Array(totalCells);
					for (let i = 0; i < totalCells; i++) status[i] = jsonl.colorsHex[i] != null ? 1 : 0;
					exp.currentColorStatus8 = status;
				} else {
					exp.currentColorStatus8 = null;
				}
				if (jsonl.frameCount !== exp.progress.current) {
					exp.progress = { current: jsonl.frameCount, target: exp.progress.target };
				}
				exp.noTapeData = false;
				return;
			}

			console.warn(`[ExperimentManager] No frame data on disk for experiment ${id}.`);
			exp.noTapeData = true;
			exp.currentGrid = null;
			exp.currentColorsHex = null;
			exp.currentColorStatus8 = null;
		} catch (err) {
			console.warn(`[ExperimentManager] Could not read tape for ${id}:`, err);
		}
	}

	async seekToGeneration(id: string, generation: number): Promise<void> {
		const exp = this.experiments[id];
		if (!exp) return;

		const totalCells = exp.config.gridWidth * exp.config.gridHeight;
		const frame = await exp.tape.getFrame(id, generation);

		if (frame) {
			exp.currentGrid = unpackBitsetTo01(frame.stateBits, totalCells);
			exp.currentGeneration = generation;
			exp.currentColorsHex = frame.colorsHex ?? null;

			// Derive colorStatus8 from colorsHex: present hex = valid (1), null = missing (0).
			// Without this, Canvas.setExperimentGrid falls through to clearCellColors() and the
			// shader renders every alive cell with the default (pink) colour.
			if (frame.colorsHex) {
				const status = new Uint8Array(totalCells);
				for (let i = 0; i < totalCells; i++) status[i] = frame.colorsHex[i] != null ? 1 : 0;
				exp.currentColorStatus8 = status;
			} else {
				exp.currentColorStatus8 = null;
			}
			return;
		}

		// SQLite miss — in-memory browser DB doesn't carry old frames across
		// reloads. Try the on-disk JSONL tape.
		const jsonl = await this.fetchJsonlFrame(id, generation);
		if (!jsonl) {
			console.warn(
				`[ExperimentManager] Frame ${generation} not found for experiment ${id} in either SQLite or JSONL.`
			);
			return;
		}
		const grid = new Uint32Array(totalCells);
		for (let i = 0; i < totalCells; i++) grid[i] = jsonl.grid01[i] ?? 0;
		exp.currentGrid = grid;
		exp.currentGeneration = generation;
		exp.currentColorsHex = jsonl.colorsHex;
		if (jsonl.colorsHex) {
			const status = new Uint8Array(totalCells);
			for (let i = 0; i < totalCells; i++) status[i] = jsonl.colorsHex[i] != null ? 1 : 0;
			exp.currentColorStatus8 = status;
		} else {
			exp.currentColorStatus8 = null;
		}
	}
}
