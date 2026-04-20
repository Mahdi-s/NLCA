/**
 * ExperimentManager — owns N independent NLCA experiments.
 * Each experiment has its own NlcaStepper, NlcaTape, NlcaFrameBuffer, and CellAgentManager.
 * Svelte 5 reactive state via $state runes.
 */

import {
	pack01ToBitset,
	encodeMetrics,
	unpackBitsetTo01,
	buildFrameLine,
	type NlcaTape
} from './tape.js';
import * as persistence from './persistence.js';
import { NlcaStepper } from './stepper.js';
import type { BufferStatus } from './frameBuffer.js';
import { CellAgentManager } from './agentManager.js';
import {
	redactExperimentConfigForPersistence,
	type ExperimentConfig,
	type ExperimentStatus,
	type NlcaOrchestratorConfig,
	type NlcaNeighborhood
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

export type HydrationState = 'idle' | 'loading' | 'ready' | 'missing';

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
	hydration = $state<Record<string, HydrationState>>({});
	experimentList = $derived(Object.values(this.experiments));
	/** Session-only API keys — never persisted to disk. Set by the UI on load and
	 * whenever settings change; used as fallback when a loaded experiment's
	 * stored key is blank (keys are intentionally stripped at persist time). */
	sessionApiKey = $state('');
	sessionSambaNovaApiKey = $state('');
	private experimentCounter = 0;
	private computeAbortControllers = new Map<string, AbortController>();
	/** Per-experiment generation counter used to void stale async rehydrates when
	 * the user switches active experiments faster than disk reads complete. */
	private rehydrateToken = new Map<string, number>();
	private lastAccessedAt = new Map<string, number>();
	private lruClock = 0;
	private static readonly LRU_BUDGET = 5;
	/** Token bumped on every startPlayback/stopPlayback so in-flight loops can
	 * detect they've been superseded and bail out cleanly. */
	private playbackToken = 0;
	private playbackCancelAnim: (() => void) | null = null;

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

	get active(): Experiment | null {
		if (!this.activeId) return null;
		return this.experiments[this.activeId] ?? null;
	}

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

	async createExperiment(config: ExperimentConfig, autoStart = true): Promise<string> {
		const id = crypto.randomUUID();
		this.experimentCounter++;
		const label = generateLabel(config, this.experimentCounter);
		const dbFilename = generateDbFilename(config);

		const tape = persistence.newTape(dbFilename);
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
		this.lastAccessedAt.set(id, ++this.lruClock);
		void this.refreshEstimatedCost(id);

		await persistence.registerMeta(exp);
		void persistence.syncMeta(exp);

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
			configJson: JSON.stringify(redactExperimentConfigForPersistence(exp.config))
		});

		exp.stepper = stepper;
		exp.agentManager = agentManager;
		exp.status = 'running';

		void persistence.syncMeta(exp);

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

					void persistence.syncFrame(
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
						void persistence.syncMeta(exp);
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
						/\bHTTP\s+402\b|\bHTTP\s+429\b|rate\s*limit|rate_limit_exceeded|Insufficient credits|Request would exceed rate limit/i.test(
							msg
						);
					this.computeAbortControllers.delete(id);
					if (isRateLimit) {
						exp.status = 'paused';
						exp.errorMessage = `Rate limit — paused. Resume when your provider quota resets. (${msg.slice(0, 160)})`;
						void persistence.syncMeta(exp, { errorMessage: exp.errorMessage });
						console.warn(
							`[ExperimentManager] Experiment ${id} paused on rate limit:`,
							msg.slice(0, 200)
						);
						return;
					}

					exp.status = 'error';
					exp.errorMessage = msg.slice(0, 200);
					void persistence.syncMeta(exp, { errorMessage: exp.errorMessage });
					console.error(`[ExperimentManager] Experiment ${id} error:`, err);
					return;
				}
			}

			if (!controller.signal.aborted && exp.progress.current >= exp.progress.target) {
				exp.status = 'completed';
				void persistence.syncMeta(exp);
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
		this.lastAccessedAt.set(id, ++this.lruClock);
		const totalFrames = exp.progress.current;
		this.playback = { id, currentFrame: 0, totalFrames, isPaused: false };

		// Pre-load all frames so playback doesn't stall on per-frame HTTP fetches.
		const frames: Array<Awaited<ReturnType<typeof persistence.loadFrame>>> = [];
		for (let gen = 1; gen <= totalFrames; gen++) {
			if (this.playbackToken !== token) return;
			frames.push(await persistence.loadFrame(id, gen));
		}
		if (this.playbackToken !== token) return;

		let prevGrid: Uint32Array | null = null;
		let prevColorsHex: Array<string | null> | null = null;

		for (let gen = 1; gen <= totalFrames; gen++) {
			if (this.playbackToken !== token) return; // superseded
			// Wait out any paused state, bailing if the user cancels or restarts.
			while (this.playback && this.playbackToken === token && this.playback.isPaused) {
				await new Promise((r) => setTimeout(r, 80));
			}
			if (this.playbackToken !== token || !this.playback) return;

			const frame = frames[gen - 1];
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

			// Pad to the target frame duration so identical frames still pace with
			// the user's speed setting rather than flashing past instantly.
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
		void persistence.syncMeta(exp);
	}

	async resumeExperiment(id: string): Promise<void> {
		const exp = this.experiments[id];
		if (!exp || exp.status !== 'paused') return;

		// API keys are never persisted — inject session keys if blank.
		if (!exp.config.apiKey && this.sessionApiKey)
			exp.config = { ...exp.config, apiKey: this.sessionApiKey };
		if (!exp.config.sambaNovaApiKey && this.sessionSambaNovaApiKey)
			exp.config = { ...exp.config, sambaNovaApiKey: this.sessionSambaNovaApiKey };

		if (!exp.stepper) {
			await this.startExperiment(id);
		} else {
			exp.status = 'running';
			void persistence.syncMeta(exp);
			this.startComputeLoop(id);
		}
	}

	/**
	 * Extend a completed, error, or stepper-less paused experiment by
	 * `additionalFrames` more frames.
	 *
	 * Restores grid state and memory context from the JSONL tape, then resumes
	 * the compute loop. Does NOT call tape.startRun() — existing frame rows are
	 * preserved and the loop continues from progress.current + 1.
	 */
	async extendExperiment(id: string, additionalFrames: number): Promise<void> {
		const exp = this.experiments[id];
		if (!exp) throw new Error(`Experiment ${id} not found`);

		if (exp.status === 'running') return;

		// Delegate to resumeExperiment for a paused experiment that still has a
		// live in-memory stepper (in-session pause, browser not reloaded).
		if (exp.status === 'paused' && exp.stepper !== null) {
			await this.resumeExperiment(id);
			return;
		}

		// -------------------------------------------------------------------
		// 1. Restore current grid from the latest JSONL frame.
		// -------------------------------------------------------------------
		const latestFrame = await persistence.loadFrame(id);
		if (!latestFrame) {
			throw new Error(`Cannot extend experiment ${id}: no frames found on disk.`);
		}

		const totalCells = latestFrame.width * latestFrame.height;
		const restoredGrid = new Uint32Array(totalCells);
		for (let i = 0; i < totalCells; i++) restoredGrid[i] = latestFrame.grid01[i] ?? 0;

		exp.currentGrid = restoredGrid;
		exp.currentColorsHex = latestFrame.colorsHex;
		exp.currentGeneration = latestFrame.generation;
		exp.progress = { current: latestFrame.generation, target: exp.progress.target };
		if (latestFrame.colorsHex) {
			const cs = new Uint8Array(totalCells);
			for (let i = 0; i < totalCells; i++) cs[i] = latestFrame.colorsHex[i] != null ? 1 : 0;
			exp.currentColorStatus8 = cs;
		} else {
			exp.currentColorStatus8 = null;
		}

		// -------------------------------------------------------------------
		// 2. Fetch seed frames for memory context (last memoryWindow frames).
		// -------------------------------------------------------------------
		const memoryWindow = Math.max(0, Math.floor(exp.config.memoryWindow ?? 0));
		const seedGrids: Uint32Array[] = [];
		if (memoryWindow > 0 && latestFrame.generation > 0) {
			const firstGen = Math.max(1, latestFrame.generation - memoryWindow + 1);
			for (let gen = firstGen; gen <= latestFrame.generation; gen++) {
				const frame = await persistence.loadFrame(id, gen);
				if (frame) {
					const g = new Uint32Array(totalCells);
					for (let i = 0; i < totalCells; i++) g[i] = frame.grid01[i] ?? 0;
					seedGrids.push(g);
				}
			}
		}

		// -------------------------------------------------------------------
		// 3. Fresh stepper — tape.startRun() is intentionally skipped so
		//    existing nlca_frames rows are preserved.
		// -------------------------------------------------------------------
		// API keys are never persisted — fall back to the session keys set by the UI.
		if (!exp.config.apiKey && this.sessionApiKey) {
			exp.config = { ...exp.config, apiKey: this.sessionApiKey };
		}
		if (!exp.config.sambaNovaApiKey && this.sessionSambaNovaApiKey) {
			exp.config = { ...exp.config, sambaNovaApiKey: this.sessionSambaNovaApiKey };
		}
		const orchestratorConfig = buildOrchestratorConfig(exp.config);
		const agentManager = new CellAgentManager(exp.config.gridWidth, exp.config.gridHeight);
		const stepper = new NlcaStepper(
			{ runId: id, neighborhood: exp.config.neighborhood, boundary: 'torus', orchestrator: orchestratorConfig },
			agentManager
		);
		stepper.seedPreviousFrames(seedGrids, latestFrame.colorsHex ?? null);

		// -------------------------------------------------------------------
		// 4. Bump progress target and persist updated config.
		// -------------------------------------------------------------------
		const newTarget = exp.progress.current + Math.max(1, Math.floor(additionalFrames));
		exp.config = { ...exp.config, targetFrames: newTarget };
		exp.progress = { current: exp.progress.current, target: newTarget };

		// -------------------------------------------------------------------
		// 5. Attach stepper, mark running, sync persistence.
		// -------------------------------------------------------------------
		exp.stepper = stepper;
		exp.agentManager = agentManager;
		exp.status = 'running';
		exp.errorMessage = undefined;

		// register() uses INSERT OR REPLACE — the only path that updates config_json
		// (which carries the new targetFrames value).
		await persistence.registerMeta(exp);
		void persistence.syncMeta(exp);
		void this.refreshEstimatedCost(id);

		this.startComputeLoop(id);
	}

	async deleteExperiment(id: string): Promise<void> {
		const controller = this.computeAbortControllers.get(id);
		if (controller) {
			controller.abort();
			this.computeAbortControllers.delete(id);
		}

		delete this.experiments[id];
		await persistence.deleteExperiment(id);

		if (this.activeId === id) {
			const remaining = Object.keys(this.experiments);
			this.activeId = remaining.length > 0 ? remaining[0] : null;
		}
	}

	setActive(id: string): void {
		if (!(id in this.experiments)) return;
		if (this.playback) this.stopPlayback();

		// Supersede any in-flight hydration for the previously-active experiment so
		// a stale slow-path load can't flip a background experiment to 'ready' after
		// the user has already switched away.
		if (this.activeId && this.activeId !== id) {
			const prev = this.activeId;
			this.rehydrateToken.set(prev, (this.rehydrateToken.get(prev) ?? 0) + 1);
		}

		this.activeId = id;
		this.lastAccessedAt.set(id, ++this.lruClock);
		const exp = this.experiments[id];
		if (!exp) return;

		// Fast path: grid already in memory (running, cached, or recently loaded).
		if (exp.currentGrid) {
			this.hydration[id] = 'ready';
			this.enforceLruBudget();
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
			.filter(
				(e) =>
					e.currentGrid != null &&
					e.id !== this.activeId &&
					e.status !== 'running' &&
					this.lastAccessedAt.has(e.id)
			)
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
			// Without this, Canvas's grid-data effect falls through to clearCellColors() and the
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
		const jsonl = await persistence.loadFrame(id, generation);
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
