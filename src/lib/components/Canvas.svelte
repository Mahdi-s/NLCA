<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { initWebGPU, type WebGPUContext, type WebGPUError } from '@games-of-life/webgpu';
	import { Simulation } from '@games-of-life/webgpu';
	import { getSimulationState, getUIState, GRID_SCALES, type GridScale, type SpectrumMode, type BrushShape, setSimulationRef, wasBrushEditorSnapshotTaken, markBrushEditorSnapshotTaken, markBrushEditorEdited } from '../stores/simulation.svelte.js';
	import type { BoundaryMode } from '../stores/simulation.svelte.js';
	import { addSnapshotWithBefore, resetHistory } from '../stores/history.js';
	import { isTourActive } from '../utils/tour.js';
	import { isModalOpen } from '../stores/modalManager.svelte.js';
	import { brushShapeToIndex, spectrumModeToIndex } from '@games-of-life/core';
	import { initializeAudio, getAudioState, updateAudio, updateAudioSimulation, silenceAudio } from '../stores/audio.svelte.js';

	// NLCA imports (lazy-loaded when nlcaMode is true)
	import { NlcaStepper } from '$lib/nlca/stepper.js';
	import { NlcaTape, encodeMetrics, pack01ToBitset } from '$lib/nlca/tape.js';
	import { CellAgentManager } from '$lib/nlca/agentManager.js';
	import type { NlcaNeighborhood } from '$lib/nlca/types.js';
	import { getNlcaPromptState } from '$lib/stores/nlcaPrompt.svelte.js';
	import { getNlcaSettingsState } from '$lib/stores/nlcaSettings.svelte.js';
	import { packCellColorHexToU32, type PromptConfig } from '$lib/nlca/prompt.js';
	import { NlcaFrameBuffer, type BufferStatus, type BufferedFrame } from '$lib/nlca/frameBuffer.js';
	import NlcaTimeline from '$lib/components/NlcaTimeline.svelte';
	import { getNlcaStore } from '$lib/stores/nlcaStore.svelte.js';
	import { prefersReducedMotion } from '$lib/utils/motion.js';

	// Props
	interface Props {
		nlcaMode?: boolean;
	}
	let { nlcaMode = false }: Props = $props();

	const simState = getSimulationState();
	const uiState = getUIState();
	const audioState = getAudioState();
	const nlcaSettings = getNlcaSettingsState();
	const initialNlcaSettings = nlcaSettings.toJSON();
	const nlcaStore = getNlcaStore();
	
	// Convert spectrum mode string to number for shader
	function getSpectrumModeIndex(mode: SpectrumMode): number {
		return spectrumModeToIndex(mode);
	}
	
	// Convert neighbor shading mode string to number for shader
	function getNeighborShadingIndex(mode: string): number {
		if (mode === 'off') return 0;
		if (mode === 'alive') return 1;
		if (mode === 'vitality') return 2;
		return 0;
	}

	// Convert brush shape string to number for shader
	// Must match order in BRUSH_SHAPES and shader is_in_brush function
	function getBrushShapeIndex(shape: BrushShape): number {
		return brushShapeToIndex(shape);
	}

	let canvas: HTMLCanvasElement;
	let container: HTMLDivElement;
	let ctx: WebGPUContext | null = null;
	let simulation: Simulation | null = null;
	let error = $state<WebGPUError | null>(null);

	function attachCanvas(node: HTMLCanvasElement) {
		canvas = node;
	}
	function attachContainer(node: HTMLDivElement) {
		container = node;
	}

	let canvasWidth = $state(0);
	let canvasHeight = $state(0);

	// NLCA (LLM-driven) stepping state - only active when nlcaMode is true
	let nlcaApiKey = $state(initialNlcaSettings.apiKey);
	let nlcaModel = $state(initialNlcaSettings.model);
	let nlcaMaxConcurrency = $state(initialNlcaSettings.maxConcurrency);
	let nlcaBatchSize = $state(initialNlcaSettings.batchSize);
	let nlcaFrameBatched = $state(initialNlcaSettings.frameBatched);
	let nlcaFrameStreamed = $state(initialNlcaSettings.frameStreamed);
	let nlcaMemoryWindow = $state(initialNlcaSettings.memoryWindow);
	let nlcaNeighborhood = $state<NlcaNeighborhood>(initialNlcaSettings.neighborhood);
	let nlcaRunId = $state('');
	let nlcaStepInFlight = $state(false);
	let nlcaLastError = $state<string | null>(null);
	let nlcaAvgLatencyMs = $state<number | null>(null);
	let nlcaLastStoredGen = $state<number | null>(null);
	let nlcaBenchmarkSummary = $state<string | null>(null);
	
	// Cost tracking
	let nlcaTotalCost = $state(0);
	let nlcaTotalInputTokens = $state(0);
	let nlcaTotalOutputTokens = $state(0);
	let nlcaTotalCalls = $state(0);
	
	// Progress tracking for streaming visualization
	let nlcaProgress = $state<{ completed: number; total: number } | null>(null);
	
	// Debug panel state
	let nlcaShowDebug = $state(false);
	let nlcaDebugEntries = $state<Array<{ timestamp: number; cellId: number; x: number; y: number; generation: number; input: string; fullPrompt?: string; output: string; latencyMs: number; success: boolean; cost?: number }>>([]);

	// Prompt state (includes output options)
	const nlcaPromptState = getNlcaPromptState();
	const nlcaUseCellColors = $derived.by(() => nlcaMode && nlcaPromptState.cellColorHexEnabled);
	let nlcaCellColorsPacked: Uint32Array | null = null;

	function setPackedColorStatus(packed: number, status: 'missing' | 'valid' | 'invalid'): number {
		const statusBits = status === 'valid' ? 1 : status === 'invalid' ? 2 : 0;
		// Preserve RGB (low 24 bits), overwrite status (high bits).
		return (((packed & 0x00ffffff) | ((statusBits & 0x3) << 24)) >>> 0) >>> 0;
	}

	function mergePackedColors(
		target: Uint32Array,
		grid01: Uint32Array,
		colorsHex?: Array<string | null>,
		colorStatus8?: Uint8Array
	): void {
		const expected = simState.gridWidth * simState.gridHeight;
		if (target.length !== expected) return;
		if (grid01.length !== expected) return;

		// If we don't have any color metadata, just clear colors for dead cells and keep RGB/status for alive cells.
		const hasColorMeta = !!colorsHex && !!colorStatus8;

		for (let i = 0; i < expected; i++) {
			const alive = (grid01[i] ?? 0) === 0 ? 0 : 1;

			if (alive === 0) {
				// Dead cells: clear packed color so we don't carry confusing indicators.
				target[i] = 0;
				continue;
			}

			if (!hasColorMeta) continue;

			const status8 = colorStatus8![i] ?? 0;
			const status = status8 === 1 ? 'valid' : status8 === 2 ? 'invalid' : 'missing';

			if (status === 'valid') {
				const hex = colorsHex![i] ?? null;
				target[i] = packCellColorHexToU32(hex, 'valid');
			} else {
				// Missing/invalid: keep last RGB to avoid collapsing back to default alive color,
				// but still mark the status for shader indicators.
				target[i] = setPackedColorStatus(target[i] ?? 0, status);
			}
		}
	}

	// Frame buffer state for buffered playback
	let nlcaFrameBuffer: NlcaFrameBuffer | null = null;
	let nlcaBufferStatus = $state<BufferStatus | null>(null);
	let nlcaIsBuffering = $state(false); // True when waiting for min buffer
	let nlcaBatchRunTarget = $state(0); // Target generations for batch run (0 = disabled)
	let nlcaBatchRunCompleted = $state(0); // Completed generations in batch run
	
	// Computed: buffered frames for timeline display
	const nlcaBufferedFrames = $derived.by(() => {
		if (!nlcaFrameBuffer) return [];
		return nlcaFrameBuffer.getAllFrames();
	});

	let nlcaStepper: NlcaStepper | null = null;
	let nlcaTape: NlcaTape | null = null;
	let nlcaAgentManager: CellAgentManager | null = null;

	type AppliedNlcaSettings = {
		apiKey: string;
		model: string;
		maxConcurrency: number;
		batchSize: number;
		frameBatched: boolean;
		frameStreamed: boolean;
		memoryWindow: number;
		neighborhood: NlcaNeighborhood;
		gridWidth: number;
		gridHeight: number;
	};

	let lastAppliedNlcaSettings: AppliedNlcaSettings | null = null;

	function resetNlcaBufferState() {
		nlcaFrameBuffer?.stopComputing();
		nlcaFrameBuffer = null;
		nlcaBufferStatus = null;
		nlcaIsBuffering = false;
		nlcaBatchRunTarget = 0;
		nlcaBatchRunCompleted = 0;
	}

	$effect(() => {
		if (!nlcaMode) return;

		const cfg = nlcaSettings.toJSON();
		const applied: AppliedNlcaSettings = {
			apiKey: cfg.apiKey,
			model: cfg.model,
			maxConcurrency: cfg.maxConcurrency,
			batchSize: cfg.batchSize,
			frameBatched: cfg.frameBatched,
			frameStreamed: cfg.frameStreamed,
			memoryWindow: cfg.memoryWindow,
			neighborhood: cfg.neighborhood,
			gridWidth: cfg.gridWidth,
			gridHeight: cfg.gridHeight
		};

		const prev = lastAppliedNlcaSettings;
		lastAppliedNlcaSettings = applied;

		// Keep local state aligned (used by UI + stepper construction).
		nlcaApiKey = applied.apiKey;
		nlcaModel = applied.model;
		nlcaMaxConcurrency = applied.maxConcurrency;
		nlcaBatchSize = applied.batchSize;
		nlcaFrameBatched = applied.frameBatched;
		nlcaFrameStreamed = applied.frameStreamed;
		nlcaMemoryWindow = applied.memoryWindow;
		nlcaNeighborhood = applied.neighborhood;

		// Keep rule neighborhood in sync for display + any neighborhood-based visuals.
		simState.currentRule.neighborhood = applied.neighborhood;
		simulation?.setRule(simState.currentRule);

		if (!prev) return;

		const dimensionsChanging = applied.gridWidth !== prev.gridWidth || applied.gridHeight !== prev.gridHeight;
		const neighborhoodChanging = applied.neighborhood !== prev.neighborhood;
		const stepperConfigChanging =
			applied.apiKey !== prev.apiKey ||
			applied.model !== prev.model ||
			applied.maxConcurrency !== prev.maxConcurrency ||
			applied.batchSize !== prev.batchSize ||
			applied.frameBatched !== prev.frameBatched ||
			applied.frameStreamed !== prev.frameStreamed ||
			applied.memoryWindow !== prev.memoryWindow ||
			neighborhoodChanging;

		if (neighborhoodChanging) {
			nlcaStepper?.updateNeighborhood(applied.neighborhood);
		}

		if (dimensionsChanging) {
			if (simulation) resize(applied.gridWidth, applied.gridHeight);
			return;
		}

		if (stepperConfigChanging) {
			resetNlcaBufferState();
			nlcaRunId = '';
			nlcaLastStoredGen = null;
			nlcaAvgLatencyMs = null;
			nlcaLastError = null;
			if (simulation) void ensureNlcaReady(simState.gridWidth, simState.gridHeight);
		}
	});

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

	function newRunId(): string {
		return (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
			? crypto.randomUUID()
			: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	}

	async function ensureNlcaReady(width: number, height: number) {
		if (!nlcaMode) return;
		console.log(`[NLCA] ensureNlcaReady called: ${width}x${height}`);
		
		if (!nlcaTape) nlcaTape = new NlcaTape();
		await nlcaTape.init();

		if (!nlcaAgentManager) {
			console.log(`[NLCA] Creating new CellAgentManager: ${width}x${height}`);
			nlcaAgentManager = new CellAgentManager(width, height);
		} else {
			const dims = nlcaAgentManager.getDimensions();
			if (dims.width !== width || dims.height !== height) {
				console.log(`[NLCA] Agent dimensions mismatch (${dims.width}x${dims.height} -> ${width}x${height}), resetting`);
				nlcaAgentManager.reset(width, height);
			} else {
				console.log(`[NLCA] Agent dimensions match: ${dims.width}x${dims.height}`);
			}
		}

		if (!nlcaRunId) {
			nlcaRunId = newRunId();
			nlcaAgentManager.clearAllHistory();
			await nlcaTape.startRun({
				runId: nlcaRunId,
				createdAt: Date.now(),
				width,
				height,
				neighborhood: nlcaNeighborhood,
				model: nlcaModel,
				maxConcurrency: nlcaMaxConcurrency
			});
			console.log(`[NLCA] New run started: ${nlcaRunId}, grid: ${width}x${height}, agents: ${width * height}`);
		}

		nlcaStepper =
			nlcaApiKey.trim().length > 0
				? new NlcaStepper(
						{
							runId: nlcaRunId,
							neighborhood: nlcaNeighborhood,
							boundary: simState.boundaryMode as BoundaryMode,
							orchestrator: {
								apiKey: nlcaApiKey.trim(),
								model: { model: nlcaModel, temperature: 0, maxOutputTokens: 64 },
								maxConcurrency: nlcaMaxConcurrency,
								batchSize: nlcaBatchSize,
								frameBatched: nlcaFrameBatched,
								frameStreamed: nlcaFrameStreamed,
								memoryWindow: nlcaMemoryWindow,
								cellTimeoutMs: 30_000
							}
						},
						nlcaAgentManager
					)
				: null;
	}

	async function runNlcaBenchmark(width = 30, height = 30, frames = 5) {
		if (!nlcaMode) return;
		if (!simulation) return;

		// Pause playback to avoid interfering with the main loop
		simState.isPlaying = false;
		nlcaBenchmarkSummary = `Benchmark running (${width}×${height}, ${frames} frames)…`;
		nlcaLastError = null;

		// Resize grid for benchmark (also resets run)
		resize(width, height);
		await ensureNlcaReady(width, height);
		if (!nlcaStepper) {
			nlcaBenchmarkSummary = 'Benchmark failed: NLCA stepper not initialized';
			return;
		}

		const promptConfig: PromptConfig = nlcaPromptState.toPromptConfig();
		const times: number[] = [];
		const tokensIn: number[] = [];
		const tokensOut: number[] = [];

		const beforeCost = nlcaStepper.getCostStats();
		const beforeFrameStats = nlcaStepper.getFrameBatchedStats();

		let prev = await simulation.getCellDataAsync();
		let gen = simState.generation;

		for (let i = 0; i < frames; i++) {
			const c0 = nlcaStepper.getCostStats();
			const t0 = performance.now();
			const { next, metrics } = await nlcaStepper.step(prev, width, height, gen, undefined, promptConfig);
			const dt = performance.now() - t0;
			times.push(dt);

			const c1 = nlcaStepper.getCostStats();
			tokensIn.push(Math.max(0, (c1.totalInputTokens ?? 0) - (c0.totalInputTokens ?? 0)));
			tokensOut.push(Math.max(0, (c1.totalOutputTokens ?? 0) - (c0.totalOutputTokens ?? 0)));

			// Apply frame so you can visually confirm output
			simulation.setCellData(next);
			simState.generation = gen + 1;
			gen++;
			prev = next;

			// Keep latency display roughly meaningful
			if (metrics) {
				let sum = 0;
				for (let j = 0; j < metrics.latency8.length; j++) sum += metrics.latency8[j] ?? 0;
				nlcaAvgLatencyMs = (sum / Math.max(1, metrics.latency8.length)) * 10;
			}
		}

		const afterCost = nlcaStepper.getCostStats();
		const afterFrameStats = nlcaStepper.getFrameBatchedStats();
		const fallbacks = Math.max(0, afterFrameStats.fallbacks - beforeFrameStats.fallbacks);

		const sorted = [...times].sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
		const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? avg;
		const avgIn = tokensIn.reduce((a, b) => a + b, 0) / Math.max(1, tokensIn.length);
		const avgOut = tokensOut.reduce((a, b) => a + b, 0) / Math.max(1, tokensOut.length);

		nlcaBenchmarkSummary =
			`Benchmark ${width}×${height}: avg ${(avg / 1000).toFixed(2)}s, p95 ${(p95 / 1000).toFixed(2)}s, ` +
			`avg tokens/frame ${Math.round(avgIn)} in / ${Math.round(avgOut)} out, fallbacks ${fallbacks}. ` +
			`Total tokens: ${afterCost.totalInputTokens - beforeCost.totalInputTokens} in / ${afterCost.totalOutputTokens - beforeCost.totalOutputTokens} out.`;
	}

	/**
	 * Initialize the frame buffer for NLCA playback
	 */
	async function initNlcaFrameBuffer() {
		if (!simulation || !nlcaStepper) return;
		
		// Create buffer if needed
		if (!nlcaFrameBuffer) {
			nlcaFrameBuffer = new NlcaFrameBuffer(5, 10);
		}
		
		// Get current grid state
		const currentGrid = await simulation.getCellDataAsync();
		
		// Build prompt config
		const promptConfig: PromptConfig = nlcaPromptState.toPromptConfig();
		// Clear any previous per-cell colors; they'll be applied per buffered frame as needed.
		simulation.clearCellColors();
		
		// Initialize and configure buffer
		nlcaFrameBuffer.initialize(currentGrid, simState.generation);
		nlcaFrameBuffer.setConfig({
			stepper: nlcaStepper,
			width: simState.gridWidth,
			height: simState.gridHeight,
			promptConfig,
			onProgress: {
				onBatchProgress: (completed, total, _partialGrid) => {
					nlcaProgress = { completed, total };
				}
			},
			onFrameComplete: async (frame: BufferedFrame) => {
				// Update cost stats from stepper
				if (nlcaStepper) {
					const costStats = nlcaStepper.getCostStats();
					nlcaTotalCost = costStats.totalCost;
					nlcaTotalInputTokens = costStats.totalInputTokens;
					nlcaTotalOutputTokens = costStats.totalOutputTokens;
					nlcaTotalCalls = costStats.callCount;
					nlcaDebugEntries = nlcaStepper.getDebugLog().slice(-100);
				}

				// Persist to tape as soon as the frame is computed (batch runs should not depend on playback consumption).
				if (nlcaTape) {
					await nlcaTape.appendFrame({
						runId: nlcaRunId,
						generation: frame.generation,
						createdAt: frame.computedAt,
						stateBits: pack01ToBitset(frame.grid),
						metrics: frame.metrics ? encodeMetrics(frame.metrics) : undefined
					});
					nlcaLastStoredGen = frame.generation;
				}
				
				// Update batch run progress
				if (nlcaBatchRunTarget > 0) {
					nlcaBatchRunCompleted++;
				}
			},
			onStatusChange: (status: BufferStatus) => {
				nlcaBufferStatus = status;
			}
		});
	}

	/**
	 * Start a batch run of N generations
	 */
	export async function startNlcaBatchRun(targetGenerations: number) {
		if (!simulation || !nlcaStepper || !nlcaTape) return;
		if (nlcaStepInFlight) return;
		
		const targetFrames = Math.max(1, Math.floor(targetGenerations));
		const startGen = simState.generation;
		const stopAtGeneration = startGen + targetFrames;

		nlcaBatchRunTarget = targetFrames;
		nlcaBatchRunCompleted = 0;
		nlcaLastError = null;
		
		// Initialize buffer if needed
		await initNlcaFrameBuffer();
		if (!nlcaFrameBuffer) return;
		
		// Keep the playback buffer bounded; batch completion is controlled by stopAtGeneration, not buffer size.
		const minBuffer = Math.min(5, targetFrames);
		const targetBuffer = Math.min(Math.max(minBuffer, 10), targetFrames);
		nlcaFrameBuffer.setBufferSizes(minBuffer, targetBuffer);
		
		// Start computing
		nlcaIsBuffering = true;
		simState.isPlaying = true; // This will start consuming frames
		
		try {
			await nlcaFrameBuffer.startComputing({ stopAtGeneration });
		} catch (err) {
			nlcaLastError = err instanceof Error ? err.message : String(err);
		} finally {
			// Stop playback when the batch run finishes (success or failure).
			simState.isPlaying = false;
			nlcaBatchRunTarget = 0;
		}
	}

	/**
	 * Cancel the current batch run
	 */
	export function cancelNlcaBatchRun() {
		nlcaFrameBuffer?.stopComputing();
		simState.isPlaying = false;
		nlcaBatchRunTarget = 0;
		nlcaBatchRunCompleted = 0;
		nlcaIsBuffering = false;
	}

	/**
	 * Get estimated time for N generations
	 */
	export function estimateNlcaTime(generations: number): number {
		if (nlcaFrameBuffer) {
			return nlcaFrameBuffer.estimateTime(generations);
		}
		// Default estimate: ~5s per frame for a 10x10 grid
		const cellCount = simState.gridWidth * simState.gridHeight;
		const avgTimePerCell = 50; // ms
		return (cellCount * avgTimePerCell * generations) / Math.max(1, nlcaMaxConcurrency);
	}

	/** Expose NLCA buffer status to parent UI (e.g. Batch Run modal). */
	export function getNlcaBufferStatus(): BufferStatus | null {
		return nlcaBufferStatus;
	}

	export function getNlcaBatchRunTarget(): number {
		return nlcaBatchRunTarget;
	}

	export function getNlcaBatchRunCompleted(): number {
		return nlcaBatchRunCompleted;
	}

	/**
	 * Consume a frame from the buffer and display it
	 */
	async function consumeBufferedFrame() {
		if (!simulation || !nlcaFrameBuffer) return false;
		
		const frame = nlcaFrameBuffer.popNextFrame();
		if (!frame) return false;
		
		// Apply the frame
		simulation.setCellData(frame.grid);
		simState.generation = frame.generation;

		// Apply cell colors for this frame (NLCA WebGPU render-only buffer)
		if (nlcaUseCellColors && frame.colorsHex && frame.colorStatus8) {
			if (!nlcaCellColorsPacked || nlcaCellColorsPacked.length !== simState.gridWidth * simState.gridHeight) {
				nlcaCellColorsPacked = new Uint32Array(simState.gridWidth * simState.gridHeight);
			}
			mergePackedColors(nlcaCellColorsPacked, frame.grid, frame.colorsHex, frame.colorStatus8);
			simulation.setCellColorsPacked(nlcaCellColorsPacked);
		} else {
			nlcaCellColorsPacked = null;
			simulation.clearCellColors();
		}
		
		// Update metrics
		if (frame.metrics) {
			let sum = 0;
			for (let i = 0; i < frame.metrics.latency8.length; i++) sum += frame.metrics.latency8[i] ?? 0;
			nlcaAvgLatencyMs = (sum / Math.max(1, frame.metrics.latency8.length)) * 10;
			simulation.setAgentMetrics(frame.metrics.latency8, frame.metrics.changed01);
		}
		
		return true;
	}

	/**
	 * Legacy single-step function (used when not in buffered mode)
	 */
	async function startNlcaStep() {
		if (!simulation) return;
		if (!nlcaStepper) return;
		if (!nlcaTape) return;
		if (nlcaStepInFlight) return;

		nlcaStepInFlight = true;
		nlcaLastError = null;
		nlcaProgress = { completed: 0, total: simState.gridWidth * simState.gridHeight };

		(async () => {
			try {
				if (simState.seedingEnabled && simState.seedingRate > 0) {
					simulation.continuousSeed(simState.seedingRate, simState.seedPattern, simState.seedAlive);
				}

				const width = simState.gridWidth;
				const height = simState.gridHeight;
				const gen = simState.generation;

				const prev = await simulation.getCellDataAsync();
				
				// Build prompt config from user settings
				const promptConfig: PromptConfig = nlcaPromptState.toPromptConfig();
				const wantColors = promptConfig.cellColorHexEnabled === true;
				if (wantColors) {
					if (!nlcaCellColorsPacked || nlcaCellColorsPacked.length !== width * height) {
						nlcaCellColorsPacked = new Uint32Array(width * height);
					}
					// Don't wipe colors at the start of a step; keep last RGB as a stable baseline.
					simulation.setCellColorsPacked(nlcaCellColorsPacked);
				} else {
					nlcaCellColorsPacked = null;
					simulation.clearCellColors();
				}
				
				// Step with progress callbacks for streaming visualization
				const { next, metrics, colorsHex, colorStatus8 } = await nlcaStepper.step(prev, width, height, gen, {
					onCellComplete: (cellId, result) => {
						if (!wantColors || !nlcaCellColorsPacked) return;
						// Clear for dead cells.
						if (result.state === 0) {
							nlcaCellColorsPacked[cellId] = 0;
							return;
						}

						const status = result.colorStatus ?? 'missing';
						if (status === 'valid' && result.colorHex) {
							nlcaCellColorsPacked[cellId] = packCellColorHexToU32(result.colorHex, 'valid');
						} else {
							// Preserve last RGB while updating status (so we don't fall back to default alive color).
							nlcaCellColorsPacked[cellId] = setPackedColorStatus(nlcaCellColorsPacked[cellId] ?? 0, status);
						}
					},
					onBatchProgress: (completed, total, partialGrid) => {
						nlcaProgress = { completed, total };
						// Update grid in real-time as results stream in
						simulation?.setCellData(partialGrid);
						// Upload colors at the same cadence as batch UI updates
						if (wantColors && nlcaCellColorsPacked) {
							simulation?.setCellColorsPacked(nlcaCellColorsPacked);
						}
					}
				}, promptConfig);
				
				simulation.setCellData(next);
				simState.incrementGeneration();

				if (wantColors) {
					if (!nlcaCellColorsPacked || nlcaCellColorsPacked.length !== width * height) {
						nlcaCellColorsPacked = new Uint32Array(width * height);
					}
					if (colorsHex && colorStatus8) {
						mergePackedColors(nlcaCellColorsPacked, next, colorsHex, colorStatus8);
						let validCount = 0;
						for (let i = 0; i < colorStatus8.length; i++) if ((colorStatus8[i] ?? 0) === 1) validCount++;
						console.log(`[NLCA] Color outputs: ${validCount}/${colorStatus8.length} valid`);
					} else {
						mergePackedColors(nlcaCellColorsPacked, next);
					}
					simulation.setCellColorsPacked(nlcaCellColorsPacked);
				}

				// Update cost stats from stepper
				const costStats = nlcaStepper.getCostStats();
				nlcaTotalCost = costStats.totalCost;
				nlcaTotalInputTokens = costStats.totalInputTokens;
				nlcaTotalOutputTokens = costStats.totalOutputTokens;
				nlcaTotalCalls = costStats.callCount;
				
				// Update debug log
				nlcaDebugEntries = nlcaStepper.getDebugLog().slice(-100); // Keep last 100 for display

				if (metrics) {
					let sum = 0;
					for (let i = 0; i < metrics.latency8.length; i++) sum += metrics.latency8[i] ?? 0;
					nlcaAvgLatencyMs = (sum / Math.max(1, metrics.latency8.length)) * 10;
					simulation.setAgentMetrics(metrics.latency8, metrics.changed01);
				} else {
					nlcaAvgLatencyMs = null;
				}

				await nlcaTape.appendFrame({
					runId: nlcaRunId,
					generation: gen + 1,
					createdAt: Date.now(),
					stateBits: pack01ToBitset(next),
					metrics: metrics ? encodeMetrics(metrics) : undefined
				});
				nlcaLastStoredGen = gen + 1;
			} catch (err) {
				nlcaLastError = err instanceof Error ? err.message : String(err);
				simState.isPlaying = false;
			} finally {
				nlcaStepInFlight = false;
				nlcaProgress = null;
			}
		})();
	}

	// Mouse state
	let isDrawing = $state(false);
	let isPanning = $state(false);
	let mouseInCanvas = $state(false);
	let gridMouseX = $state(0);
	let gridMouseY = $state(0);
	let lastMouseX = 0;
	let lastMouseY = 0;
	let drawingState = 1; // 1 = draw, 0 = erase
	let continuousDrawInterval: ReturnType<typeof setInterval> | null = null;
	let strokeTracked = false;
	let pendingStrokeBefore: Promise<Uint32Array> | null = null;
	function capturePreStroke() {
		if (!simulation) return;
		if (!pendingStrokeBefore) {
			// Start capture asynchronously; we'll await when finishing the stroke
			pendingStrokeBefore = simulation.getCellDataAsync().catch(() => null as unknown as Uint32Array);
		}
	}
	
	// Effective tool mode: pan if pan mode selected OR space is held
	const effectiveToolMode = $derived(simState.isSpaceHeld ? 'pan' : simState.toolMode);

	function ensureBrushEditorSnapshot() {
		if (isModalOpen('brushEditor') && simulation && !wasBrushEditorSnapshotTaken()) {
			simulation.snapshotUndo().catch(() => {});
			markBrushEditorSnapshotTaken();
		}
	}

	// Get brush configuration for painting
	function getBrushConfig() {
		return {
			shape: simState.brushShape,
			rotation: simState.brushRotation,
			density: simState.brushDensity,
			intensity: simState.brushIntensity,
			aspectRatio: simState.brushAspectRatio,
			// Text brush options
			text: simState.brushText,
			textFont: simState.brushTextFont,
			textBold: simState.brushTextBold,
			textItalic: simState.brushTextItalic
		};
	}

	// Touch state
	let touchMode: 'none' | 'draw' | 'pan' | 'pinch' = 'none';
	let lastTouchX = 0;
	let lastTouchY = 0;
	let lastPinchDistance = 0;
	// (Long-press detection removed; touch logic doesn't currently use it.)

	// Animation
	let animationId: number | null = null;
	let lastFrameTime = 0;
	let simAccMs = 0;



	/**
	 * Get the actual visible viewport dimensions
	 * Uses visualViewport API on mobile for accurate dimensions that account for browser UI
	 */
	function getVisibleViewportSize(): { width: number; height: number } {
		// On mobile, visualViewport gives the actual visible area excluding browser UI
		if (window.visualViewport) {
			return {
				width: window.visualViewport.width,
				height: window.visualViewport.height
			};
		}
		// Fallback to container dimensions, then window
		if (container && container.clientWidth > 0 && container.clientHeight > 0) {
			return {
				width: container.clientWidth,
				height: container.clientHeight
			};
		}
		return {
			width: window.innerWidth,
			height: window.innerHeight
		};
	}

	/**
	 * Constrain view to keep the grid reasonably centered (NLCA mode only).
	 * Allows panning around but not so far that the grid disappears entirely.
	 * The grid should always be at least partially visible.
	 */
	function constrainViewToGrid(): void {
		if (!simulation || !nlcaMode) return;
		
		const w = simState.gridWidth;
		const h = simState.gridHeight;
		const aspect = canvasWidth / canvasHeight;
		const viewState = simulation.getViewState();
		const zoom = viewState.zoom;
		
		// Calculate how many cells are visible
		const cellsVisibleX = zoom;
		const cellsVisibleY = zoom / aspect;
		
		// Allow panning within a generous range - the grid should stay at least 
		// partially visible (within 30% of the view from center)
		const padding = 0.3; // 30% of view size
		
		// Calculate the center of the grid
		const gridCenterX = w / 2;
		const gridCenterY = h / 2;
		
		// Calculate the visible area center based on current offset
		const viewCenterX = viewState.offsetX + cellsVisibleX / 2;
		const viewCenterY = viewState.offsetY + cellsVisibleY / 2;
		
		// Calculate the maximum allowed distance from grid center
		const maxOffsetFromGridX = cellsVisibleX * (0.5 + padding) + w / 2;
		const maxOffsetFromGridY = cellsVisibleY * (0.5 + padding) + h / 2;
		
		// Clamp the offset to keep grid at least partially in view
		let newOffsetX = viewState.offsetX;
		let newOffsetY = viewState.offsetY;
		
		// If view center is too far from grid center, pull it back
		if (viewCenterX < gridCenterX - maxOffsetFromGridX) {
			newOffsetX = gridCenterX - maxOffsetFromGridX - cellsVisibleX / 2;
		} else if (viewCenterX > gridCenterX + maxOffsetFromGridX) {
			newOffsetX = gridCenterX + maxOffsetFromGridX - cellsVisibleX / 2;
		}
		
		if (viewCenterY < gridCenterY - maxOffsetFromGridY) {
			newOffsetY = gridCenterY - maxOffsetFromGridY - cellsVisibleY / 2;
		} else if (viewCenterY > gridCenterY + maxOffsetFromGridY) {
			newOffsetY = gridCenterY + maxOffsetFromGridY - cellsVisibleY / 2;
		}
		
		// Apply constraints if needed
		if (newOffsetX !== viewState.offsetX || newOffsetY !== viewState.offsetY) {
			simulation.setView({
				offsetX: newOffsetX,
				offsetY: newOffsetY
			});
		}
	}
	
	/**
	 * Constrain zoom level for NLCA mode.
	 * Allows zooming out to see the entire grid with padding, and zooming in to cell level.
	 * Returns clamped zoom factor.
	 */
	function constrainNlcaZoom(factor: number): number {
		if (!simulation || !nlcaMode) return factor;
		
		const viewState = simulation.getViewState();
		const newZoom = viewState.zoom * factor;
		const w = simState.gridWidth;
		const h = simState.gridHeight;
		const aspect = canvasWidth / canvasHeight;
		
		// Minimum zoom: how many cell-widths fit across the viewport at maximum
		// zoom-out. Larger = more empty space around the grid. 4x padding gives
		// the user room to pull back and see the whole piece with a generous
		// margin for the HUD / panels without the grid feeling cramped.
		const gridVisualWidth = w;
		const gridVisualHeight = h;
		const minZoomForWidth = gridVisualWidth * 4.0;
		const minZoomForHeight = gridVisualHeight * aspect * 4.0;
		const minZoom = Math.max(minZoomForWidth, minZoomForHeight);
		
		// Maximum zoom: don't zoom in more than 1 cell per 20 pixels
		const maxZoom = 3;
		
		if (newZoom > minZoom) {
			// Would zoom out too far - limit the factor
			return minZoom / viewState.zoom;
		}
		if (newZoom < maxZoom) {
			// Would zoom in too much - limit the factor
			return maxZoom / viewState.zoom;
		}
		
		return factor;
	}

	/**
	 * Calculate grid dimensions from scale.
	 * Grids are now always square - seamless panning handles filling any screen aspect ratio.
	 * For hexagonal grids, we add extra rows to compensate for visual compression.
	 * IMPORTANT: Hex grid height must be EVEN for proper torus wrapping (row parity must match at boundaries).
	 */
	function calculateGridDimensions(scale: GridScale, _screenWidth: number, _screenHeight: number, isHexagonal: boolean = false): { width: number; height: number } {
		const scaleConfig = GRID_SCALES.find(s => s.name === scale) ?? GRID_SCALES[2]; // Default to medium
		const size = scaleConfig.baseCells;
		
		// For hexagonal grids, rows are visually compressed by sqrt(3)/2 ≈ 0.866
		// So we need ~15.5% more rows to fill the same visual height as width
		// This keeps the VISUAL aspect ratio close to square
		const HEX_HEIGHT_RATIO = 0.866025404; // sqrt(3)/2
		let height = isHexagonal ? Math.round(size / HEX_HEIGHT_RATIO) : size;
		
		// CRITICAL: For hex grids, height must be EVEN for proper torus boundary wrapping.
		// In odd-r hex layout, row parity determines neighbor offsets. When wrapping vertically,
		// row -1 (conceptually odd) must wrap to row height-1 (also odd) for correct neighbors.
		// This only works if height is even: row 0=even, row height-1=odd.
		if (isHexagonal && (height & 1) === 1) {
			height += 1; // Make it even
		}
		
		return { width: size, height };
	}

	onMount(() => {
		initializeWebGPU();
		// Handle NLCA prompt changes (reset agent sessions)
		const onNlcaPromptChanged = () => {
			if (!nlcaMode) return;
			console.log('[NLCA] Prompt changed - resetting agent sessions');
			nlcaStepper?.resetAgentSessions();
			nlcaAgentManager?.clearAllHistory();
			nlcaCellColorsPacked = null;
			simulation?.clearCellColors();
		};
		const onNlcaBenchmark = (e: Event) => {
			if (!nlcaMode) return;
			const detail = (e as CustomEvent).detail as { width?: number; height?: number; frames?: number } | undefined;
			void runNlcaBenchmark(detail?.width ?? 30, detail?.height ?? 30, detail?.frames ?? 5);
		};

		if (nlcaMode) {
			window.addEventListener('nlca-prompt-changed', onNlcaPromptChanged);
			window.addEventListener('nlca-benchmark', onNlcaBenchmark as EventListener);
		}

		// Handle resize
		const resizeObserver = new ResizeObserver(handleResize);
		resizeObserver.observe(container);

		// Orientation change is handled automatically:
		// - ResizeObserver updates canvas dimensions
		// - Seamless panning fills any viewport shape
		// - View (zoom, offset) stays the same, keeping center point stable
		// No special handling needed!

		// Add touch event listeners with { passive: false } to allow preventDefault
		canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
		canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
		canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
		canvas.addEventListener('touchcancel', handleTouchEnd, { passive: false });

		return () => {
			if (nlcaMode) {
				window.removeEventListener('nlca-prompt-changed', onNlcaPromptChanged);
				window.removeEventListener('nlca-benchmark', onNlcaBenchmark as EventListener);
			}
			resizeObserver.disconnect();
			if (animationId !== null) {
				cancelAnimationFrame(animationId);
			}
			// Stop continuous drawing if active
			stopContinuousDrawing();
			// Remove touch event listeners
			canvas.removeEventListener('touchstart', handleTouchStart);
			canvas.removeEventListener('touchmove', handleTouchMove);
			canvas.removeEventListener('touchend', handleTouchEnd);
			canvas.removeEventListener('touchcancel', handleTouchEnd);
			setSimulationRef(null);
			simulation?.destroy();
		};
	});

	async function initializeWebGPU() {
		const result = await initWebGPU(canvas);

		if (!result.ok) {
			error = result.error;
			return;
		}

		ctx = result.value;
		
		let width: number;
		let height: number;

		if (nlcaMode) {
			const cfg = nlcaSettings.toJSON();
			width = cfg.gridWidth;
			height = cfg.gridHeight;
			simState.gridWidth = width;
			simState.gridHeight = height;
			// NLCA mode starts paused - user must manually step or play
			simState.pause();
			// Use plane boundary (no wrapping) for NLCA - edges see dead neighbors
			simState.boundaryMode = 'plane';
			simState.currentRule.neighborhood = cfg.neighborhood;
			console.log(`[NLCA] Initialized grid: ${width}x${height} (paused, plane boundary)`);
		} else {
			// Calculate initial grid size based on actual visible viewport
			// Uses visualViewport API on mobile for accurate dimensions
			const viewport = getVisibleViewportSize();
			const isHex = simState.currentRule.neighborhood === 'hexagonal' || simState.currentRule.neighborhood === 'extendedHexagonal';
			const dims = calculateGridDimensions(simState.gridScale, viewport.width, viewport.height, isHex);
			width = dims.width;
			height = dims.height;
			simState.gridWidth = width;
			simState.gridHeight = height;
		}
		
		simulation = new Simulation(ctx, {
			width,
			height,
			rule: simState.currentRule
		});
		setSimulationRef(simulation);
		await resetHistory(simulation);

		// Initialize NLCA components if in NLCA mode
		if (nlcaMode) {
			// Set plane boundary mode on the simulation (no edge wrapping)
			simulation.setView({ boundaryMode: 'plane' });
			await ensureNlcaReady(width, height);
		}

		// Initialize audio engine (won't start playing until user enables it)
		// Skip audio for NLCA mode (not applicable)
		if (!nlcaMode) {
			try {
				await initializeAudio(ctx.device, simulation);
			} catch (e) {
				console.warn('Audio initialization failed:', e);
			}
		}

		// Apply the selected initialization method
		applyLastInitialization();
		
		// Use viewport dimensions since canvas may not be sized yet
		const viewport = getVisibleViewportSize();
		const dpr = window.devicePixelRatio || 1;
		const initialCanvasWidth = nlcaMode ? width * 10 * dpr : viewport.width * dpr;
		const initialCanvasHeight = nlcaMode ? height * 10 * dpr : viewport.height * dpr;
		
		// Set view to fit the grid (no zoom animation)
		simulation.resetView(initialCanvasWidth, initialCanvasHeight, false);
		
		// For NLCA mode, zoom out to show padding around the grid
		// This makes the grid boundaries clearly visible against the background
		if (nlcaMode) {
			const viewState = simulation.getViewState();
			// Zoom out to show 2x the grid size (50% padding on each side)
			const paddedZoom = viewState.zoom * 2;
			// Center the view so grid is in the middle
			const cellsVisibleX = paddedZoom;
			const cellsVisibleY = paddedZoom / (canvasWidth / canvasHeight || 1.5);
			const offsetX = (width - cellsVisibleX) / 2;
			const offsetY = (height - cellsVisibleY) / 2;
			simulation.setView({ 
				zoom: paddedZoom,
				offsetX,
				offsetY
			});
			constrainViewToGrid();
		}
		
		// Start animation loop
		animationLoop(performance.now());
		
		// Start axis grow animation after a brief delay (only if axes are enabled)
		setTimeout(() => {
			if (simulation && simState.showAxes) {
				simulation.startAxisAnimation(true, 600); // Grow axes from center
			}
		}, 100);
	}

	function handleResize(entries: ResizeObserverEntry[]) {
		const entry = entries[0];
		if (!entry) return;

		const { width, height } = entry.contentRect;
		const dpr = window.devicePixelRatio || 1;

		canvasWidth = Math.floor(width * dpr);
		canvasHeight = Math.floor(height * dpr);

		canvas.width = canvasWidth;
		canvas.height = canvasHeight;

		if (ctx) {
			ctx.context.configure({
				device: ctx.device,
				format: ctx.format,
				alphaMode: 'premultiplied'
			});
		}
	}

	function animationLoop(timestamp: number) {
		animationId = requestAnimationFrame(animationLoop);

		if (!simulation || canvasWidth === 0 || canvasHeight === 0) return;

		// Update view animation (smooth transitions for fit-to-screen, etc.)
		simulation.updateViewAnimation();
		
		// Check if axes visibility changed and trigger axis animation
		if (lastShowAxesState !== null && lastShowAxesState !== simState.showAxes) {
			simulation.startAxisAnimation(simState.showAxes, 400);
		}
		lastShowAxesState = simState.showAxes;
		
		// Update axis animation (grow/shrink from center)
		simulation.updateAxisAnimation();

		// Run simulation steps if playing
		if (simState.isPlaying) {
			const stepMs = 1000 / Math.max(1, simState.speed);

			// Accumulate time since last frame (clamped to avoid massive catch-up).
			if (lastFrameTime === 0) lastFrameTime = timestamp;
			let frameDt = timestamp - lastFrameTime;
			lastFrameTime = timestamp;
			frameDt = Math.min(frameDt, 50);
			simAccMs += frameDt;

			if (nlcaMode) {
				// NLCA mode: buffered playback (batch runs) or direct stepping.
				// Enforce a 3-second minimum between frames so each result is
				// visible long enough to evaluate.
				const nlcaStepMs = Math.max(stepMs, 3000);
				const bufferActive =
					!!nlcaFrameBuffer &&
					(nlcaFrameBuffer.getBufferedCount() > 0 || nlcaBufferStatus?.isComputing || nlcaBatchRunTarget > 0);

				if (bufferActive) {
					if (simAccMs >= nlcaStepMs) {
						simAccMs = Math.min(simAccMs, nlcaStepMs);
						simAccMs -= nlcaStepMs;

						const bufferedCount = nlcaFrameBuffer?.getBufferedCount() ?? 0;
						// Wait for min buffer (or any frames at all, if none exist yet).
						if (bufferedCount === 0) {
							nlcaIsBuffering = true;
						} else if (!nlcaFrameBuffer!.hasMinBuffer() && !nlcaIsBuffering) {
							nlcaIsBuffering = true;
						} else if (nlcaFrameBuffer!.hasMinBuffer()) {
							nlcaIsBuffering = false;
							consumeBufferedFrame();
						}
					}
				} else if (!nlcaStepInFlight && simAccMs >= nlcaStepMs) {
					// Legacy single-step mode (no buffer)
					simAccMs = Math.min(simAccMs, nlcaStepMs);
					simAccMs -= nlcaStepMs;
					startNlcaStep();
				}
			} else {
				// Normal mode: GPU compute stepping
				// Keep the UI smooth by giving stepping a time budget each frame.
				const frameStart = performance.now();
				const stepBudgetMs = 6;
				const hardMaxStepsPerFrame = 64;

				let stepsRan = 0;
				while (simAccMs >= stepMs && stepsRan < hardMaxStepsPerFrame) {
					if (simState.seedingEnabled && simState.seedingRate > 0) {
						simulation.continuousSeed(simState.seedingRate, simState.seedPattern, simState.seedAlive);
					}
					simulation.step();
					simAccMs -= stepMs;
					stepsRan++;

					if (performance.now() - frameStart > stepBudgetMs) break;
				}

				if (stepsRan > 0) simState.incrementGenerationBy(stepsRan);
			}
		} else {
			// Prevent a giant catch-up when resuming play.
			lastFrameTime = 0;
			simAccMs = 0;
		}

		// Trigger pause side-effects exactly once on transition to paused
		if (wasPlaying && !simState.isPlaying) {
			// Just paused - get accurate count from GPU
			simulation.countAliveCellsAsync().then(count => {
				simState.aliveCells = count;
			});
			// Silence audio when paused to avoid repeating the same sound
			if (audioState.isEnabled) silenceAudio();
		}
		wasPlaying = simState.isPlaying;

		// Sync view state including brush preview
		// Hide brush during recording for clean video capture
		// Also hide brush in NLCA mode (no drawing interaction)
		const brushEditorOpen = isModalOpen('brushEditor');
		const showBrush = !nlcaMode && !isRecording && ((mouseInCanvas && effectiveToolMode === 'brush' && !isPanning) || uiState.showBrushPopup || brushEditorOpen);
		// When brush popup/modal is open and mouse not in canvas, show brush at center of grid
		const brushPopupOrModalOpen = uiState.showBrushPopup || brushEditorOpen;
		const brushX = brushPopupOrModalOpen && !mouseInCanvas 
			? Math.floor(simState.gridWidth / 2) 
			: gridMouseX;
		const brushY = brushPopupOrModalOpen && !mouseInCanvas 
			? Math.floor(simState.gridHeight / 2) 
			: gridMouseY;
		
		// Update text bitmap when text brush is active
		if (simState.brushShape === 'text' && showBrush) {
			simulation.updateTextBitmap(
				simState.brushText,
				simState.brushTextFont,
				simState.brushTextBold,
				simState.brushTextItalic,
				simState.brushSize
			);
		}
		
		simulation.setView({
			showGrid: simState.showGrid,
			isLightTheme: simState.isLightTheme,
			aliveColor: simState.aliveColor,
			brushX: showBrush ? brushX : -1000,
			brushY: showBrush ? brushY : -1000,
			brushRadius: showBrush ? simState.brushSize : -1,
			brushShape: getBrushShapeIndex(simState.brushShape),
			brushRotation: (simState.brushRotation * Math.PI) / 180, // Convert degrees to radians
			brushAspectRatio: simState.brushAspectRatio,
			boundaryMode: simState.boundaryMode,
			spectrumMode: getSpectrumModeIndex(simState.spectrumMode),
			spectrumFrequency: simState.spectrumFrequency,
			neighborShading: getNeighborShadingIndex(simState.neighborShading),
			// Vitality influence settings
			vitalityMode: simState.vitalityMode,
			vitalityThreshold: simState.vitalityThreshold,
			vitalityGhostFactor: simState.vitalityGhostFactor,
			vitalitySigmoidSharpness: simState.vitalitySigmoidSharpness,
			vitalityDecayPower: simState.vitalityDecayPower,
			vitalityCurveSamples: simState.vitalityCurveSamples
		});

		// Always render
		simulation.render(canvasWidth, canvasHeight);

		// Also render to recording canvas if recording
		if (isRecording && recordingCanvas) {
			simulation.renderToRecordingCanvas();
		}

		// Update audio (throttled internally to ~30 Hz)
		// Only update when simulation is playing to avoid repeating the same sound
		if (audioState.isEnabled && simState.isPlaying) {
			updateAudio(canvasWidth, canvasHeight);
		}

		// Update alive cells count (sync version for display)
		simState.aliveCells = simulation.countAliveCells();
	}

	// Track axes visibility changes to trigger axis animation
	let lastShowAxesState: boolean | null = null;

	// Track previous playing state to trigger count update when paused
	let wasPlaying = false;

	// Keyboard handlers for shift key
	function handleKeyDown(e: KeyboardEvent) {
		// Ignore if typing in an input field
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
			return;
		}
		if (e.key === ' ') {
			// Space key temporarily activates pan mode
			e.preventDefault();
			simState.isSpaceHeld = true;
		}
	}

	function handleKeyUp(e: KeyboardEvent) {
		// Ignore if typing in an input field
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
			return;
		}
		if (e.key === ' ') {
			e.preventDefault();
			simState.isSpaceHeld = false;
		}
	}

	// Start continuous drawing interval
	function startContinuousDrawing() {
		if (continuousDrawInterval) return;
		
		continuousDrawInterval = setInterval(() => {
			if (!simulation || !isDrawing) return;
			simulation.paintBrush(gridMouseX, gridMouseY, simState.brushSize, drawingState, simState.brushType, getBrushConfig());
		}, 50); // Draw every 50ms (20 times per second)
	}

	// Stop continuous drawing interval
	function stopContinuousDrawing() {
		if (continuousDrawInterval) {
			clearInterval(continuousDrawInterval);
			continuousDrawInterval = null;
		}
	}

	// Mouse event handlers
	function handleMouseDown(e: MouseEvent) {
		if (!simulation) return;
		
		// Disable drawing during tour
		if (isTourActive()) return;
		const brushEditorOpen = isModalOpen('brushEditor');
		
		// Mark that user has interacted (dismiss click hint)
		simState.hasInteracted = true;

		const rect = canvas.getBoundingClientRect();
		const x = (e.clientX - rect.left) * (canvasWidth / rect.width);
		const y = (e.clientY - rect.top) * (canvasHeight / rect.height);

		lastMouseX = e.clientX;
		lastMouseY = e.clientY;

		// Middle mouse button = always pan
		if (e.button === 1) {
			isPanning = true;
			e.preventDefault();
			return;
		}

		// NLCA mode: left click = pan, no drawing
		if (nlcaMode) {
			if (e.button === 0) {
				isPanning = true;
				e.preventDefault();
			}
			return;
		}

		// Left click behavior depends on tool mode
		if (e.button === 0) {
			if (effectiveToolMode === 'pan') {
				isPanning = true;
				e.preventDefault();
				return;
			}
			// Brush mode - draw
			(async () => {
				if (brushEditorOpen) {
					ensureBrushEditorSnapshot();
					markBrushEditorEdited();
				} else {
					// Capture pre-stroke snapshot for precise undo (async, fire-and-forget)
					capturePreStroke();
					strokeTracked = true;
				}
			})();
			isDrawing = true;
			drawingState = simState.brushState;
			const gridPos = simulation.screenToGrid(x, y, canvasWidth, canvasHeight);
			gridMouseX = gridPos.x;
			gridMouseY = gridPos.y;
			simulation.paintBrush(gridPos.x, gridPos.y, simState.brushSize, drawingState, simState.brushType, getBrushConfig());
			
			// Start continuous drawing for hold-to-draw
			startContinuousDrawing();
			return;
		}
		
		// Right click = erase (always, regardless of mode)
		if (e.button === 2) {
			(async () => {
				if (brushEditorOpen) {
					ensureBrushEditorSnapshot();
					markBrushEditorEdited();
				} else {
					capturePreStroke();
					strokeTracked = true;
				}
			})();
			isDrawing = true;
			drawingState = 0;
			const gridPos = simulation.screenToGrid(x, y, canvasWidth, canvasHeight);
			gridMouseX = gridPos.x;
			gridMouseY = gridPos.y;
			simulation.paintBrush(gridPos.x, gridPos.y, simState.brushSize, drawingState, simState.brushType, getBrushConfig());
			
			// Start continuous drawing for hold-to-draw
			startContinuousDrawing();
		}
	}

	function handleMouseMove(e: MouseEvent) {
		if (!simulation) return;

		const rect = canvas.getBoundingClientRect();
		const x = (e.clientX - rect.left) * (canvasWidth / rect.width);
		const y = (e.clientY - rect.top) * (canvasHeight / rect.height);

		// Update grid mouse position for brush preview
		const gridPos = simulation.screenToGrid(x, y, canvasWidth, canvasHeight);
		gridMouseX = gridPos.x;
		gridMouseY = gridPos.y;

		if (isPanning) {
			const deltaX = e.clientX - lastMouseX;
			const deltaY = e.clientY - lastMouseY;
			simulation.pan(deltaX, deltaY, rect.width, rect.height);
			// Constrain view to grid bounds in NLCA mode
			constrainViewToGrid();
			lastMouseX = e.clientX;
			lastMouseY = e.clientY;
			return;
		}

		if (isDrawing) {
			// Paint immediately on move (in addition to continuous interval)
			simulation.paintBrush(gridPos.x, gridPos.y, simState.brushSize, drawingState, simState.brushType, getBrushConfig());
		}
	}

	async function handleMouseUp() {
		stopContinuousDrawing();
		const brushEditorOpen = isModalOpen('brushEditor');
		const wasDrawing = isDrawing;
		const wasStrokeTracked = strokeTracked;
		
		// Set these immediately to stop any further painting during async operations
		isDrawing = false;
		isPanning = false;
		strokeTracked = false;
		
		if (wasDrawing && simulation && !simState.isPlaying) {
			// After painting while paused, update the count
			simulation.countAliveCellsAsync().then(count => {
				simState.aliveCells = count;
			});
		}
		if (wasStrokeTracked && simulation && !brushEditorOpen) {
			// Await to ensure before snapshot resolves; then clear
			const before = pendingStrokeBefore ? await pendingStrokeBefore : null;
			await addSnapshotWithBefore(simulation, before, 'Stroke');
			pendingStrokeBefore = null;
		}
	}

	function handleMouseEnter() {
		mouseInCanvas = true;
	}

	function handleMouseLeave() {
		mouseInCanvas = false;
		stopContinuousDrawing();
		isDrawing = false;
		isPanning = false;
	}

	function handleWheel(e: WheelEvent) {
		if (!simulation) return;
		e.preventDefault();

		const rect = canvas.getBoundingClientRect();
		const x = (e.clientX - rect.left) * (canvasWidth / rect.width);
		const y = (e.clientY - rect.top) * (canvasHeight / rect.height);

		// Smooth zoom factor - proportional to scroll amount but clamped
		// Trackpads send many small deltas, mice send fewer larger ones
		// Normalize to a comfortable range and use exponential for smooth feel
		const normalizedDelta = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100);
		const zoomSpeed = 0.002; // Lower = smoother/slower
		let factor = Math.exp(normalizedDelta * zoomSpeed);
		
		// Constrain zoom level in NLCA mode
		factor = constrainNlcaZoom(factor);
		
		simulation.zoomAt(x, y, canvasWidth, canvasHeight, factor);
		
		// Constrain view to grid bounds in NLCA mode
		constrainViewToGrid();
	}

	function handleContextMenu(e: MouseEvent) {
		e.preventDefault();
	}

	// Touch event handlers
	function getTouchDistance(touches: TouchList): number {
		if (touches.length < 2) return 0;
		const dx = touches[0].clientX - touches[1].clientX;
		const dy = touches[0].clientY - touches[1].clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	function getTouchCenter(touches: TouchList): { x: number; y: number } {
		if (touches.length < 2) {
			return { x: touches[0].clientX, y: touches[0].clientY };
		}
		return {
			x: (touches[0].clientX + touches[1].clientX) / 2,
			y: (touches[0].clientY + touches[1].clientY) / 2
		};
	}

	function handleTouchStart(e: TouchEvent) {
		if (!simulation) return;
		
		// Disable drawing during tour
		if (isTourActive()) {
			e.preventDefault();
			return;
		}
		
		e.preventDefault();
		const brushEditorOpen = isModalOpen('brushEditor');
		
		// Mark that user has interacted (dismiss click hint)
		simState.hasInteracted = true;

		const touches = e.touches;

		if (touches.length === 1) {
			const touch = touches[0];
			const rect = canvas.getBoundingClientRect();
			const x = (touch.clientX - rect.left) * (canvasWidth / rect.width);
			const y = (touch.clientY - rect.top) * (canvasHeight / rect.height);
			
			lastTouchX = touch.clientX;
			lastTouchY = touch.clientY;

			// NLCA mode: single touch = pan, no drawing
			if (nlcaMode) {
				touchMode = 'pan';
				return;
			}

			// Single touch behavior depends on tool mode
			if (effectiveToolMode === 'pan') {
				// Pan mode - single touch pans
				touchMode = 'pan';
			} else {
				// Brush mode - single touch draws
				if (brushEditorOpen) {
					ensureBrushEditorSnapshot();
					markBrushEditorEdited();
				} else {
					capturePreStroke();
					strokeTracked = true;
				}
				touchMode = 'draw';
				const gridPos = simulation.screenToGrid(x, y, canvasWidth, canvasHeight);
				gridMouseX = gridPos.x;
				gridMouseY = gridPos.y;
				drawingState = simState.brushState; // Use current brush state for touch
				simulation.paintBrush(gridPos.x, gridPos.y, simState.brushSize, drawingState, simState.brushType, getBrushConfig());
				
				// Start continuous drawing for hold-to-draw on touch
				startContinuousDrawing();
			}
		} else if (touches.length === 2) {
			// Two fingers - start pinch/pan, stop drawing
			stopContinuousDrawing();
			touchMode = 'pinch';
			lastPinchDistance = getTouchDistance(touches);
			const center = getTouchCenter(touches);
			lastTouchX = center.x;
			lastTouchY = center.y;
		}
	}

	function handleTouchMove(e: TouchEvent) {
		if (!simulation) return;
		e.preventDefault();

		const touches = e.touches;
		const rect = canvas.getBoundingClientRect();

		if (touches.length === 1 && touchMode === 'draw') {
			// Single finger drawing (only in brush mode)
			const touch = touches[0];
			const x = (touch.clientX - rect.left) * (canvasWidth / rect.width);
			const y = (touch.clientY - rect.top) * (canvasHeight / rect.height);

			const gridPos = simulation.screenToGrid(x, y, canvasWidth, canvasHeight);
			gridMouseX = gridPos.x;
			gridMouseY = gridPos.y;
			simulation.paintBrush(gridPos.x, gridPos.y, simState.brushSize, simState.brushState, simState.brushType, getBrushConfig());
			
			lastTouchX = touch.clientX;
			lastTouchY = touch.clientY;
		} else if (touches.length === 1 && touchMode === 'pan') {
			// Single finger panning (in pan mode or after pinch)
			const touch = touches[0];
			const deltaX = touch.clientX - lastTouchX;
			const deltaY = touch.clientY - lastTouchY;
			simulation.pan(deltaX, deltaY, rect.width, rect.height);
			// Constrain view to grid bounds in NLCA mode
			constrainViewToGrid();
			lastTouchX = touch.clientX;
			lastTouchY = touch.clientY;
		} else if (touches.length === 2 && touchMode === 'pinch') {
			// Two finger pinch zoom and pan
			const currentDistance = getTouchDistance(touches);
			const center = getTouchCenter(touches);

			// Zoom
			if (lastPinchDistance > 0) {
				let zoomFactor = lastPinchDistance / currentDistance;
				// Constrain zoom level in NLCA mode
				zoomFactor = constrainNlcaZoom(zoomFactor);
				const screenX = (center.x - rect.left) * (canvasWidth / rect.width);
				const screenY = (center.y - rect.top) * (canvasHeight / rect.height);
				simulation.zoomAt(screenX, screenY, canvasWidth, canvasHeight, zoomFactor);
			}

			// Pan
			const deltaX = center.x - lastTouchX;
			const deltaY = center.y - lastTouchY;
			simulation.pan(deltaX, deltaY, rect.width, rect.height);
			// Constrain view to grid bounds in NLCA mode
			constrainViewToGrid();

			lastPinchDistance = currentDistance;
			lastTouchX = center.x;
			lastTouchY = center.y;
		} else if (touches.length === 1 && touchMode === 'pinch') {
			// Went from 2 fingers to 1 - switch to pan mode
			touchMode = 'pan';
			const touch = touches[0];
			lastTouchX = touch.clientX;
			lastTouchY = touch.clientY;
		}
	}

	async function handleTouchEnd(e: TouchEvent) {
		if (!simulation) return;
		e.preventDefault();
		const brushEditorOpen = isModalOpen('brushEditor');

		const touches = e.touches;

		if (touches.length === 0) {
			// All fingers lifted
			stopContinuousDrawing();
			if (touchMode === 'draw' && !simState.isPlaying) {
				// After drawing while paused, update the count
				simulation.countAliveCellsAsync().then(count => {
					simState.aliveCells = count;
				});
			}
			if (strokeTracked && simulation && !brushEditorOpen) {
				const before = pendingStrokeBefore ? await pendingStrokeBefore : null;
				await addSnapshotWithBefore(simulation, before, 'Stroke');
				pendingStrokeBefore = null;
			}
			touchMode = 'none';
			lastPinchDistance = 0;
			strokeTracked = false;
		} else if (touches.length === 1 && (touchMode === 'pinch' || touchMode === 'draw')) {
			// Went from 2 to 1 finger - continue as pan (never accidentally draw after pinch)
			stopContinuousDrawing();
			touchMode = 'pan';
			const touch = touches[0];
			lastTouchX = touch.clientX;
			lastTouchY = touch.clientY;
		}
	}

	// Expose simulation methods
	export function clear() {
		if (!simulation) return;
		simulation.clear();
		simState.resetGeneration();
		simState.aliveCells = 0;
	}

	export function randomize(density: number = 0.15) {
		if (!simulation) return;
		simulation.randomize(density);
		simState.resetGeneration();
		// Randomize already sets _aliveCells, but do async count for accuracy
		simulation.countAliveCellsAsync().then(count => {
			simState.aliveCells = count;
		});
	}

	// Re-initialize the grid using the last selected initialization settings
	export function reinitialize() {
		applyLastInitialization();
	}

	// Apply the last selected initialization method
	async function applyLastInitialization() {
		if (!simulation) return;
		await resetHistory(simulation);
		
		const pattern = simState.lastInitPattern;
		
		// Handle blank - just clear
		if (pattern === 'blank') {
			simulation.clear();
			simState.resetGeneration();
			simState.aliveCells = 0;
			return;
		}
		
		// Handle random types - use appropriate density
		if (pattern.startsWith('random')) {
			let density = 0.15;
			if (pattern === 'random-sparse') density = 0.15;
			else if (pattern === 'random-medium') density = 0.3;
			else if (pattern === 'random-dense') density = 0.5;
			simulation.randomize(density);
			simState.resetGeneration();
			simulation.countAliveCellsAsync().then(count => {
				simState.aliveCells = count;
			});
			return;
		}
		
		// For structured patterns, use the initialize function with tiling settings
		initialize(pattern, {
			tiled: simState.lastInitTiling,
			spacing: simState.lastInitSpacing
		});
	}

	export function initialize(type: string, options?: { density?: number; tiled?: boolean; spacing?: number }) {
		if (!simulation) return;
		
		// Clear first
		simulation.clear();
		simState.resetGeneration();
		
		// Handle blank - just clear, no randomization
		if (type === 'blank') {
			return;
		}
		
		// Handle random types
		if (type.startsWith('random')) {
			const d = options?.density ?? 0.15;
			simulation.randomize(d);
			return;
		}

		// Define patterns (relative to center)
		const patterns: Record<string, [number, number][]> = {
			// Conway's Life patterns
			'glider': [[0, -1], [1, 0], [-1, 1], [0, 1], [1, 1]],
			'lwss': [[-2, -1], [-2, 1], [-1, -2], [0, -2], [1, -2], [2, -2], [2, -1], [2, 0], [1, 1]],
			'r-pentomino': [[0, -1], [1, -1], [-1, 0], [0, 0], [0, 1]],
			'acorn': [[-3, 0], [-2, 0], [-2, -2], [0, -1], [1, 0], [2, 0], [3, 0]],
			'diehard': [[-3, 0], [-2, 0], [-2, 1], [2, 1], [3, -1], [3, 1], [4, 1]],
			'blinker': [[-1, 0], [0, 0], [1, 0]],
			'toad': [[-1, 0], [0, 0], [1, 0], [0, 1], [1, 1], [2, 1]],
			'beacon': [[-1, -1], [0, -1], [-1, 0], [1, 1], [2, 0], [2, 1]],
			'block': [[0, 0], [1, 0], [0, 1], [1, 1]],
			'beehive': [[-1, 0], [0, -1], [1, -1], [2, 0], [1, 1], [0, 1]],
			'loaf': [[0, -1], [1, -1], [-1, 0], [2, 0], [0, 1], [2, 1], [1, 2]],
			'boat': [[0, 0], [1, 0], [0, 1], [2, 1], [1, 2]],
			'pulsar': [
				[-6, -4], [-6, -3], [-6, -2], [-4, -6], [-3, -6], [-2, -6],
				[-6, 2], [-6, 3], [-6, 4], [-4, 6], [-3, 6], [-2, 6],
				[6, -4], [6, -3], [6, -2], [4, -6], [3, -6], [2, -6],
				[6, 2], [6, 3], [6, 4], [4, 6], [3, 6], [2, 6],
				[-1, -4], [-1, -3], [-1, -2], [1, -4], [1, -3], [1, -2],
				[-1, 2], [-1, 3], [-1, 4], [1, 2], [1, 3], [1, 4],
				[-4, -1], [-3, -1], [-2, -1], [-4, 1], [-3, 1], [-2, 1],
				[4, -1], [3, -1], [2, -1], [4, 1], [3, 1], [2, 1]
			],
			'pentadecathlon': [
				[-4, 0], [-3, -1], [-3, 1], [-2, 0], [-1, 0], [0, 0], [1, 0],
				[2, 0], [3, -1], [3, 1], [4, 0]
			],
			'glider-gun': [
				[-18, 0], [-18, 1], [-17, 0], [-17, 1],
				[-8, 0], [-8, 1], [-8, 2], [-7, -1], [-7, 3], [-6, -2], [-6, 4],
				[-5, -2], [-5, 4], [-4, 1], [-3, -1], [-3, 3], [-2, 0], [-2, 1], [-2, 2],
				[-1, 1],
				[2, -2], [2, -1], [2, 0], [3, -2], [3, -1], [3, 0], [4, -3], [4, 1],
				[6, -4], [6, -3], [6, 1], [6, 2],
				[16, -2], [16, -1], [17, -2], [17, -1]
			],
			// HighLife patterns
			'replicator': [[0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1]],
			// Day & Night patterns
			'dn-glider': [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [1, 2]],
			'dn-blinker': [[-1, 0], [0, 0], [1, 0]],
			'dn-ship': [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]],
			// Brian's Brain patterns
			'bb-glider': [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2]]
		};

		const pattern = patterns[type];
		if (!pattern) return;

		const gridW = simState.gridWidth;
		const gridH = simState.gridHeight;
		let aliveCells = 0;

		if (options?.tiled && options.spacing) {
			// Tile the pattern across the grid
			// spacing is the actual cell distance on the grid
			const spacing = options.spacing;
			
			for (let ty = Math.floor(spacing / 2); ty < gridH; ty += spacing) {
				for (let tx = Math.floor(spacing / 2); tx < gridW; tx += spacing) {
					for (const [dx, dy] of pattern) {
						const x = tx + dx;
						const y = ty + dy;
						if (x >= 0 && x < gridW && y >= 0 && y < gridH) {
							simulation.setCell(x, y, 1);
							aliveCells++;
						}
					}
				}
			}
		} else {
			// Single pattern in center
			const cx = Math.floor(gridW / 2);
			const cy = Math.floor(gridH / 2);
			for (const [dx, dy] of pattern) {
				const x = cx + dx;
				const y = cy + dy;
				if (x >= 0 && x < gridW && y >= 0 && y < gridH) {
					simulation.setCell(x, y, 1);
					aliveCells++;
				}
			}
		}

		// Update the alive cells count
		simulation.updateAliveCellsCount(aliveCells);
		
		// Also do an async count to ensure accuracy after GPU operations settle
		simulation.countAliveCellsAsync().then(count => {
			simState.aliveCells = count;
		});
	}

	export function stepOnce() {
		if (!simulation) return;
		if (nlcaMode) {
			// NLCA mode: async LLM stepping
			startNlcaStep();
		} else {
			// Normal mode: GPU compute stepping
			simulation.step();
			simState.incrementGeneration();
			// Update alive cells count after step
			simulation.countAliveCellsAsync().then(count => {
				simState.aliveCells = count;
			});
		}
	}

	export function resetView() {
		simulation?.resetView(canvasWidth, canvasHeight);
	}


	export function updateRule() {
		if (!simulation || !ctx) return;
		
		// NLCA mode only supports square neighborhoods
		if (nlcaMode) {
			const nbh = simState.currentRule.neighborhood;
			if (nbh === 'hexagonal' || nbh === 'extendedHexagonal') {
				simState.currentRule.neighborhood = 'moore';
			}
			simulation.setRule(simState.currentRule);

			// Keep NLCA stepper aligned with boundary + neighborhood
			const nextNbh = simState.currentRule.neighborhood as NlcaNeighborhood;
			if (nextNbh === 'moore' || nextNbh === 'vonNeumann' || nextNbh === 'extendedMoore') {
				nlcaNeighborhood = nextNbh;
				nlcaStepper?.updateNeighborhood(nextNbh);
			}
			nlcaStepper?.updateBoundary(simState.boundaryMode as BoundaryMode);
			return;
		}
		
		const currentNeighborhood = simulation.getRule().neighborhood;
		const newNeighborhood = simState.currentRule.neighborhood;
		const wasHex = currentNeighborhood === 'hexagonal' || currentNeighborhood === 'extendedHexagonal';
		const isHex = newNeighborhood === 'hexagonal' || newNeighborhood === 'extendedHexagonal';
		const isHexChanged = wasHex !== isHex;
		
		if (isHexChanged) {
			// Neighborhood type changed between hex and non-hex, need to recreate grid
			// because hex grids need more rows to fill the same visual space
			const viewport = getVisibleViewportSize();
			const { width, height } = calculateGridDimensions(simState.gridScale, viewport.width, viewport.height, isHex);
			
			simState.gridWidth = width;
			simState.gridHeight = height;
			
			simulation.destroy();
			simulation = new Simulation(ctx, {
				width,
				height,
				rule: simState.currentRule
			});
			setSimulationRef(simulation);
			updateAudioSimulation(simulation);
			applyLastInitialization();
			
			// Reset view to fit the new grid (no animation since grid was recreated)
			simulation.resetView(canvasWidth, canvasHeight, false);
		} else {
			// Same neighborhood type, just update the rule
			simulation.setRule(simState.currentRule);
		}
	}

	export function getSimulation(): Simulation | null {
		return simulation;
	}

	// --- Playback animation -----------------------------------------------------
	// Transition from one saved frame to the next with a per-cell random stagger
	// + brightness fade, so the user sees the grid "come to life" rather than
	// snap between states. Used by the ExperimentManager playback loop.
	let playbackAnimCancel: (() => void) | null = null;

	/** Cancel any in-flight playback animation. Safe to call repeatedly. */
	export function cancelPlaybackAnimation(): void {
		if (playbackAnimCancel) {
			const fn = playbackAnimCancel;
			playbackAnimCancel = null;
			fn();
		}
	}

	function hexToRgb(hex: string | null | undefined): { r: number; g: number; b: number } | null {
		if (!hex || typeof hex !== 'string') return null;
		const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
		if (!m) return null;
		const n = parseInt(m[1]!, 16);
		return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
	}

	function packRgb(r: number, g: number, b: number): number {
		// status=valid (1 in bits 24..25) so the shader applies the RGB
		return (((1 & 0x3) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;
	}

	/**
	 * Animate a transition from the current on-canvas state to the next saved
	 * frame. Only cells whose state or colour differ between the two frames get
	 * animated — each changed cell fires after a random delay inside the stagger
	 * window, then fades over ~35% of the total duration.
	 *
	 * Resolves when the animation reaches the target frame, or when
	 * cancelPlaybackAnimation() is called (whichever comes first).
	 */
	export function animateTransition(
		currentGrid: Uint32Array | null,
		nextGrid: Uint32Array,
		currentColorsHex: Array<string | null> | null,
		nextColorsHex: Array<string | null> | null,
		width: number,
		height: number,
		totalMs: number
	): Promise<void> {
		cancelPlaybackAnimation();
		if (!simulation || !ctx) return Promise.resolve();
		const sim = simulation;
		if (simState.gridWidth !== width || simState.gridHeight !== height) resize(width, height);

		const total = width * height;
		const cur = currentGrid && currentGrid.length === total ? currentGrid : new Uint32Array(total);
		if (nextGrid.length !== total) {
			sim.setCellData(nextGrid);
			return Promise.resolve();
		}

		const wantColors = nlcaUseCellColors && (nextColorsHex != null || currentColorsHex != null);

		// Diff pass. A cell animates if its state flipped or (in colour mode) its
		// colour string differs. We store the indices so we can iterate hot cells
		// instead of scanning the full grid each RAF tick.
		const changed: number[] = [];
		for (let i = 0; i < total; i++) {
			const curAlive = (cur[i] ?? 0) !== 0;
			const nextAlive = (nextGrid[i] ?? 0) !== 0;
			const colorDiff =
				wantColors && (currentColorsHex?.[i] ?? null) !== (nextColorsHex?.[i] ?? null);
			if (curAlive !== nextAlive || colorDiff) changed.push(i);
		}

		const finalColorPacked = (() => {
			if (!wantColors) return null;
			const buf = new Uint32Array(total);
			if (nextColorsHex) {
				for (let i = 0; i < total; i++) {
					if ((nextGrid[i] ?? 0) !== 0) {
						const rgb = hexToRgb(nextColorsHex[i]);
						if (rgb) buf[i] = packRgb(rgb.r, rgb.g, rgb.b);
					}
				}
			}
			return buf;
		})();

		if (changed.length === 0) {
			sim.setCellData(nextGrid);
			if (wantColors && finalColorPacked) sim.setCellColorsPacked(finalColorPacked);
			else if (!wantColors) sim.clearCellColors();
			return Promise.resolve();
		}

		const perCellFadeMs = Math.max(60, Math.min(220, totalMs * 0.35));
		const staggerWindow = Math.max(60, totalMs - perCellFadeMs);
		const activations = new Float32Array(changed.length);
		// Distribute activation times evenly across the stagger window with per-
		// bucket jitter, then shuffle cell → bucket so the reveal order stays
		// random. Using pure random per-cell sampling makes small diffs finish
		// much faster than totalMs because the sampled values cluster in a
		// fraction of the window — the user sees the animation accelerate for
		// frames where few cells change, which looks like a bug.
		const N = changed.length;
		for (let i = 0; i < N; i++) activations[i] = ((i + Math.random()) / N) * staggerWindow;
		for (let i = N - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			const tmp = activations[i]!;
			activations[i] = activations[j]!;
			activations[j] = tmp;
		}

		// Pre-compute current and next packed RGB for each changed cell so the
		// per-frame lerp is just arithmetic on Uint8 channels.
		const curRgb = new Int16Array(changed.length * 3); // signed so -1 = missing
		const nextRgb = new Int16Array(changed.length * 3);
		for (let i = 0; i < changed.length; i++) {
			const idx = changed[i]!;
			const c = wantColors ? hexToRgb(currentColorsHex?.[idx] ?? null) : null;
			const n = wantColors ? hexToRgb(nextColorsHex?.[idx] ?? null) : null;
			if (c) {
				curRgb[i * 3] = c.r; curRgb[i * 3 + 1] = c.g; curRgb[i * 3 + 2] = c.b;
			} else { curRgb[i * 3] = -1; }
			if (n) {
				nextRgb[i * 3] = n.r; nextRgb[i * 3 + 1] = n.g; nextRgb[i * 3 + 2] = n.b;
			} else { nextRgb[i * 3] = -1; }
		}

		// Working buffers that we push to the simulation on each RAF tick.
		const displayGrid = new Uint32Array(cur);
		const displayColors = wantColors ? new Uint32Array(total) : null;
		if (wantColors && displayColors && currentColorsHex) {
			for (let i = 0; i < total; i++) {
				if ((cur[i] ?? 0) !== 0) {
					const rgb = hexToRgb(currentColorsHex[i]);
					if (rgb) displayColors[i] = packRgb(rgb.r, rgb.g, rgb.b);
				}
			}
		}

		const startTime = performance.now();

		return new Promise<void>((resolve) => {
			let rafId = 0;
			let cancelled = false;

			const tick = () => {
				if (cancelled) { resolve(); return; }
				const now = performance.now();
				const elapsed = now - startTime;
				let allDone = true;

				for (let i = 0; i < changed.length; i++) {
					const idx = changed[i]!;
					const t = activations[i]!;
					if (elapsed < t) {
						allDone = false;
						continue; // not yet activated — keep current value
					}
					const progress = Math.min(1, (elapsed - t) / perCellFadeMs);
					if (progress < 1) allDone = false;

					const curAlive = (cur[idx] ?? 0) !== 0;
					const nextAlive = (nextGrid[idx] ?? 0) !== 0;
					const halfPast = progress >= 0.5;
					const showAlive = halfPast ? nextAlive : curAlive;
					displayGrid[idx] = showAlive ? 1 : 0;

					if (wantColors && displayColors) {
						// Fade brightness toward/away from center of the fade window. In the
						// first half we darken the old colour; in the second half we brighten
						// the new colour in. intensity = |p - 0.5| * 2, so 1→0→1.
						const intensity = Math.abs(progress - 0.5) * 2;
						const srcBase = halfPast ? i * 3 : i * 3;
						const rgb = halfPast ? nextRgb : curRgb;
						if (!showAlive || rgb[srcBase] < 0) {
							displayColors[idx] = 0;
						} else {
							const r = Math.round((rgb[srcBase]! as number) * intensity);
							const g = Math.round((rgb[srcBase + 1]! as number) * intensity);
							const b = Math.round((rgb[srcBase + 2]! as number) * intensity);
							displayColors[idx] = packRgb(r, g, b);
						}
					}
				}

				sim.setCellData(displayGrid);
				if (wantColors && displayColors) sim.setCellColorsPacked(displayColors);

				if (allDone) {
					// Final snap to guarantee consistency with the saved frame.
					sim.setCellData(nextGrid);
					if (wantColors && finalColorPacked) sim.setCellColorsPacked(finalColorPacked);
					else if (!wantColors) sim.clearCellColors();
					playbackAnimCancel = null;
					resolve();
				} else {
					rafId = requestAnimationFrame(tick);
				}
			};

			playbackAnimCancel = () => {
				cancelled = true;
				if (rafId) cancelAnimationFrame(rafId);
				resolve();
			};
			rafId = requestAnimationFrame(tick);
		});
	}

	function isMobileShareEnvironment() {
		if (typeof navigator === 'undefined') return false;
		const ua = navigator.userAgent || '';
		const isMobileUA = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
		const hasTouch = (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints
			? (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints > 1
			: false;
		return isMobileUA || hasTouch;
	}

	// Video recording state
	let isRecording = $state(false);
	let mediaRecorder: MediaRecorder | null = null;
	let recordedChunks: Blob[] = [];
	let recordingCanvas: HTMLCanvasElement | null = null;

	export function getIsRecording() {
		return isRecording;
	}

	export function toggleRecording() {
		if (isRecording) {
			stopRecording();
		} else {
			startRecording();
		}
	}

	function startRecording() {
		if (!canvas || isRecording || !simulation) return;

		try {
			// Create offscreen canvas for recording the full grid
			recordingCanvas = simulation.initRecordingCanvas();
			
			// Capture stream from recording canvas at 60fps
			const stream = recordingCanvas.captureStream(60);
			
			// Prefer MP4 for better compatibility, fall back to high-quality WebM
			const mimeTypes = [
				'video/mp4;codecs=avc1.42E01E', // H.264 baseline
				'video/mp4',
				'video/webm;codecs=vp9',
				'video/webm;codecs=vp8',
				'video/webm'
			];
			
			let selectedMimeType = '';
			for (const mimeType of mimeTypes) {
				if (MediaRecorder.isTypeSupported(mimeType)) {
					selectedMimeType = mimeType;
					break;
				}
			}
			
			if (!selectedMimeType) {
				console.error('No supported video MIME type found');
				simulation.destroyRecordingCanvas();
				recordingCanvas = null;
				return;
			}

			recordedChunks = [];
			mediaRecorder = new MediaRecorder(stream, {
				mimeType: selectedMimeType,
				videoBitsPerSecond: 25000000 // 25 Mbps for high quality
			});

			mediaRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) {
					recordedChunks.push(event.data);
				}
			};

			mediaRecorder.onstop = () => {
				const blob = new Blob(recordedChunks, { type: selectedMimeType });
				const extension = selectedMimeType.includes('mp4') ? 'mp4' : 'webm';
				const filename = `cellular-automaton-${simState.gridWidth}x${simState.gridHeight}-gen${simState.generation}.${extension}`;
				
				saveRecording(blob, filename);
				recordedChunks = [];
				
				// Clean up recording canvas
				if (simulation) {
					simulation.destroyRecordingCanvas();
				}
				recordingCanvas = null;
			};

			mediaRecorder.start(100); // Collect data every 100ms
			isRecording = true;
		} catch (err) {
			console.error('Failed to start recording:', err);
			if (simulation) {
				simulation.destroyRecordingCanvas();
			}
			recordingCanvas = null;
		}
	}

	function stopRecording() {
		if (mediaRecorder && isRecording) {
			mediaRecorder.stop();
			isRecording = false;
			mediaRecorder = null;
			
			// Restore axis progress after recording
			if (simulation && simState.showAxes) {
				simulation.startAxisAnimation(true, 400);
			}
		}
	}

	async function saveRecording(blob: Blob, filename: string) {
		// Try using the Web Share API for mobile (if available and supports files)
		if (isMobileShareEnvironment() && navigator.share && navigator.canShare) {
			const file = new File([blob], filename, { type: blob.type });
			const shareData = { files: [file] };
			
			if (navigator.canShare(shareData)) {
				try {
					await navigator.share(shareData);
					return;
				} catch (err) {
					// User cancelled or share failed, fall through to download
					if ((err as Error).name === 'AbortError') return;
				}
			}
		}
		
		// Fallback to download
		const url = URL.createObjectURL(blob);
		triggerDownload(url, filename);
		// Clean up the object URL after a delay
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	export function screenshot() {
		if (!canvas) return;
		
		const filename = `cellular-automaton-gen${simState.generation}.png`;
		const dataUrl = canvas.toDataURL('image/png');
		
		// Try using the Web Share API for mobile (if available and supports files)
		if (isMobileShareEnvironment() && navigator.share && navigator.canShare) {
			canvas.toBlob(async (blob) => {
				if (!blob) return;
				
				const file = new File([blob], filename, { type: 'image/png' });
				const shareData = { files: [file] };
				
				if (navigator.canShare(shareData)) {
					try {
						await navigator.share(shareData);
						return;
					} catch (err) {
						// User cancelled or share failed, fall through to download
						if ((err as Error).name === 'AbortError') return;
					}
				}
				
				// Fallback to download
				triggerDownload(dataUrl, filename);
			}, 'image/png');
		} else {
			// Desktop or no share API - direct download
			triggerDownload(dataUrl, filename);
		}
	}
	
	function triggerDownload(dataUrl: string, filename: string) {
		const link = document.createElement('a');
		link.download = filename;
		link.href = dataUrl;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	}

	export function resize(width: number, height: number) {
		if (!ctx || !simulation) return;
		
		console.log(`[Canvas] resize() called: ${width}x${height}`);
		
		// Update store
		simState.gridWidth = width;
		simState.gridHeight = height;
		
		// Recreate simulation with new size
		simulation.destroy();
		simulation = new Simulation(ctx, {
			width,
			height,
			rule: simState.currentRule
		});
		setSimulationRef(simulation);
		if (!nlcaMode) {
			updateAudioSimulation(simulation);
		}
		applyLastInitialization();

		// NLCA: new run for a new grid shape
		if (nlcaMode) {
			console.log(`[NLCA] New grid created: ${width}x${height}, resetting run`);
			nlcaRunId = '';
			void ensureNlcaReady(width, height);
		}
	}
	
	export function setScale(scale: GridScale) {
		if (!ctx || !simulation) return;
		
		// Calculate new dimensions based on visible viewport
		const viewport = getVisibleViewportSize();
		const isHex = nlcaMode ? false : (simState.currentRule.neighborhood === 'hexagonal' || simState.currentRule.neighborhood === 'extendedHexagonal');
		const { width, height } = calculateGridDimensions(scale, viewport.width, viewport.height, isHex);
		
		// Update store
		simState.gridScale = scale;
		simState.gridWidth = width;
		simState.gridHeight = height;
		
		// Recreate simulation with new size
		simulation.destroy();
		simulation = new Simulation(ctx, {
			width,
			height,
			rule: simState.currentRule
		});
		setSimulationRef(simulation);
		if (!nlcaMode) {
			updateAudioSimulation(simulation);
		}
		applyLastInitialization();
		
		// Reset view to fit the new grid (no animation since grid was recreated)
		simulation.resetView(canvasWidth, canvasHeight, false);

		// NLCA: new run for a new grid shape
		if (nlcaMode) {
			nlcaRunId = '';
			void ensureNlcaReady(width, height);
		}
	}
</script>

<svelte:window onkeydown={handleKeyDown} onkeyup={handleKeyUp} />

<div class="canvas-container" {@attach attachContainer}>
	{#if error}
		<div class="error">
			<div class="error-icon">⚠️</div>
			<h2>WebGPU Not Available</h2>
			<p>{error.message}</p>
			<p class="hint">
				Try using a recent version of Chrome, Edge, Safari, or Firefox.
			</p>
		</div>
	{/if}
	<canvas
		{@attach attachCanvas}
		onmousedown={handleMouseDown}
		onmousemove={handleMouseMove}
		onmouseup={handleMouseUp}
		onmouseenter={handleMouseEnter}
		onmouseleave={handleMouseLeave}
		onwheel={handleWheel}
		oncontextmenu={handleContextMenu}
		class:hidden={!!error}
		class:panning={isPanning}
		class:pan-ready={effectiveToolMode === 'pan' && !isPanning}
	></canvas>

	{#if nlcaMode && nlcaStore.active && nlcaStore.hydration[nlcaStore.active.id] === 'loading'}
		<div class="canvas-skeleton" transition:fade={{ duration: 150 }}></div>
	{/if}

	{#if nlcaMode && !error}
		{#if nlcaBenchmarkSummary}
			<div class="nlca-benchmark-result">{nlcaBenchmarkSummary}</div>
		{/if}

		<!-- Timeline for frame visualization -->
		{#if nlcaBatchRunTarget > 0 || nlcaBufferedFrames.length > 0}
			<div class="nlca-timeline-wrapper">
				<NlcaTimeline
					currentGeneration={simState.generation}
					bufferedFrames={nlcaBufferedFrames}
					bufferStatus={nlcaBufferStatus}
					batchRunActive={nlcaBatchRunTarget > 0}
					batchRunTarget={nlcaBatchRunTarget}
					batchRunCompleted={nlcaBatchRunCompleted}
				/>
			</div>
		{/if}

		{#if nlcaShowDebug}
			<div class="nlca-debug">
				<div class="debug-header">
					<span>LLM Debug Log</span>
					<button class="close-btn" onclick={() => nlcaShowDebug = false}>×</button>
				</div>
				<div class="debug-stats">
					<span>Tokens: {nlcaTotalInputTokens.toLocaleString()} in / {nlcaTotalOutputTokens.toLocaleString()} out</span>
				</div>
				<div class="debug-entries">
					{#each nlcaDebugEntries.slice(-50).reverse() as entry (entry.timestamp + '-' + entry.cellId)}
						<div class="debug-entry" class:success={entry.success} class:fail={!entry.success}>
							<div class="entry-header">
								<span class="cell-id">Cell ({entry.x},{entry.y})</span>
								<span class="gen">Gen {entry.generation}</span>
								<span class="latency">{entry.latencyMs.toFixed(0)}ms</span>
								{#if entry.cost}<span class="entry-cost">${entry.cost.toFixed(6)}</span>{/if}
							</div>
							<div class="entry-io">
								<div class="io-label">FULL PROMPT:</div>
								<pre class="io-content">{entry.fullPrompt || entry.input}</pre>
							</div>
							<div class="entry-io">
								<div class="io-label">OUT:</div>
								<pre class="io-content">{entry.output}</pre>
							</div>
						</div>
					{:else}
						<div class="no-entries">No debug entries yet. Run a step to see LLM I/O.</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}

	<!-- History / Branch toolbar -->
</div>

<style>
	.canvas-container {
		position: fixed;
		inset: 0;
		overflow: hidden;
		background: #0d0d12;
	}

	canvas {
		width: 100%;
		height: 100%;
		display: block;
		cursor: crosshair;
		touch-action: none; /* Prevent default touch behaviors */
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
		animation: canvas-fade-in 0.8s ease-out forwards;
	}

	@keyframes canvas-fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	canvas.pan-ready {
		cursor: grab;
	}

	canvas.panning {
		cursor: grabbing;
	}

	canvas.hidden {
		display: none;
	}

	.error {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		color: #e0e0e0;
		text-align: center;
		padding: 2rem;
	}

	.error-icon {
		font-size: 4rem;
		margin-bottom: 1rem;
	}

	.error h2 {
		font-size: 1.5rem;
		font-weight: 600;
		margin: 0 0 1rem;
		color: #ff6b6b;
	}

	.error p {
		margin: 0.5rem 0;
		max-width: 500px;
		line-height: 1.6;
	}

	.error .hint {
		color: #888;
		font-size: 0.9rem;
	}

	.nlca-benchmark-result {
		position: absolute;
		left: 12px;
		top: 12px;
		max-width: min(360px, calc(100vw - 24px));
		background: rgba(0, 0, 0, 0.55);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 14px;
		padding: 10px 12px;
		backdrop-filter: blur(14px);
		color: #eaeaf2;
		font-size: 0.82rem;
		white-space: pre-wrap;
		z-index: 100;
	}

	/* NLCA Timeline wrapper */
	.nlca-timeline-wrapper {
		position: absolute;
		left: 12px;
		top: 230px;
		pointer-events: auto;
		z-index: 100;
	}

	/* NLCA Debug Panel */
	.nlca-debug {
		position: absolute;
		right: 12px;
		top: 12px;
		width: min(480px, calc(100vw - 400px));
		max-height: calc(100vh - 100px);
		background: rgba(0, 0, 0, 0.85);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 14px;
		backdrop-filter: blur(18px);
		color: #eaeaf2;
		pointer-events: auto;
		z-index: 101;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.nlca-debug .debug-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 14px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
		font-weight: 600;
		font-size: 0.85rem;
	}
	.nlca-debug .close-btn {
		background: transparent;
		border: none;
		color: #888;
		font-size: 1.2rem;
		cursor: pointer;
		padding: 2px 6px;
		line-height: 1;
	}
	.nlca-debug .close-btn:hover {
		color: #fff;
	}
	.nlca-debug .debug-stats {
		padding: 8px 14px;
		font-size: 0.75rem;
		color: rgba(255, 255, 255, 0.7);
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}
	.nlca-debug .debug-entries {
		flex: 1;
		overflow-y: auto;
		padding: 8px;
	}
	.nlca-debug .debug-entry {
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(255, 255, 255, 0.06);
		border-radius: 8px;
		padding: 8px 10px;
		margin-bottom: 6px;
		font-size: 0.72rem;
	}
	.nlca-debug .debug-entry.success {
		border-left: 3px solid #4ade80;
	}
	.nlca-debug .debug-entry.fail {
		border-left: 3px solid #f87171;
	}
	.nlca-debug .entry-header {
		display: flex;
		gap: 10px;
		margin-bottom: 6px;
		color: rgba(255, 255, 255, 0.8);
	}
	.nlca-debug .cell-id {
		font-weight: 600;
		color: #2dd4bf;
	}
	.nlca-debug .gen {
		color: rgba(255, 255, 255, 0.6);
	}
	.nlca-debug .latency {
		color: #fbbf24;
	}
	.nlca-debug .entry-cost {
		color: #4ade80;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}
	.nlca-debug .entry-io {
		display: flex;
		gap: 6px;
		margin-bottom: 4px;
	}
	.nlca-debug .io-label {
		color: rgba(255, 255, 255, 0.5);
		min-width: 28px;
		font-weight: 500;
	}
	.nlca-debug .io-content {
		flex: 1;
		margin: 0;
		padding: 4px 6px;
		background: rgba(0, 0, 0, 0.3);
		border-radius: 4px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.68rem;
		white-space: pre-wrap;
		word-break: break-all;
		max-height: 60px;
		overflow-y: auto;
		color: rgba(255, 255, 255, 0.9);
	}
	.nlca-debug .no-entries {
		color: rgba(255, 255, 255, 0.5);
		text-align: center;
		padding: 20px;
		font-size: 0.8rem;
	}

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

</style>
