/**
 * ExperimentManager — owns N independent NLCA experiments.
 * Each experiment has its own NlcaStepper, NlcaTape, NlcaFrameBuffer, and CellAgentManager.
 * Svelte 5 reactive state via $state runes.
 */

import { NlcaTape, ExperimentIndex, pack01ToBitset, encodeMetrics, unpackBitsetTo01 } from './tape.js';
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
	totalCalls: number;
	lastLatencyMs: number | null;
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

export class ExperimentManager {
	experiments = $state<Record<string, Experiment>>({});
	activeId = $state<string | null>(null);
	experimentList = $derived(Object.values(this.experiments));
	private experimentCounter = 0;
	private index: ExperimentIndex;
	private computeAbortControllers = new Map<string, AbortController>();

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
					totalCalls: 0,
					lastLatencyMs: null
				};
				this.experiments[row.id] = exp;
				this.experimentCounter++;
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
			totalCalls: 0,
			lastLatencyMs: null
		};

		this.experiments[id] = exp;
		this.activeId = id;

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

					await exp.tape.appendFrame({
						runId: id,
						generation,
						createdAt: Date.now(),
						stateBits: pack01ToBitset(result.next),
						metrics: result.metrics ? encodeMetrics(result.metrics) : undefined
					});

					if (generation % 5 === 0) {
						await this.index.updateStatus(id, 'running', generation);
						void this.syncCsvRow(exp);
					}
				} catch (err) {
					if (controller.signal.aborted) break;
					exp.status = 'error';
					let msg = err instanceof Error ? err.message : String(err);
					// Try to extract JSON error from HTML responses
					const jsonMatch = msg.match(/"message":"([^"]+)"/);
					if (jsonMatch) msg = jsonMatch[1];
					exp.errorMessage = msg.slice(0, 200);
					await this.index.updateStatus(id, 'error', exp.progress.current, exp.errorMessage);
					void this.syncCsvRow(exp);
					console.error(`[ExperimentManager] Experiment ${id} error:`, err);
					return;
				}
			}

			if (!controller.signal.aborted && exp.progress.current >= exp.progress.target) {
				exp.status = 'completed';
				await this.index.updateStatus(id, 'completed', exp.progress.current);
				void this.syncCsvRow(exp);
			}
		};

		loop();
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
	}

	async resumeExperiment(id: string): Promise<void> {
		const exp = this.experiments[id];
		if (!exp || exp.status !== 'paused') return;

		if (!exp.stepper) {
			await this.startExperiment(id);
		} else {
			exp.status = 'running';
			await this.index.updateStatus(id, 'running', exp.progress.current);
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

		if (this.activeId === id) {
			const remaining = Object.keys(this.experiments);
			this.activeId = remaining.length > 0 ? remaining[0] : null;
		}
	}

	setActive(id: string): void {
		if (!(id in this.experiments)) return;
		this.activeId = id;
		// Experiments loaded from the index on app start don't have their grid
		// rehydrated from the tape yet — seek to the latest frame so the canvas
		// shows the saved state instead of an empty grid.
		const exp = this.experiments[id];
		if (exp && !exp.currentGrid && exp.progress.current > 0) {
			void this.seekToGeneration(id, exp.progress.current).catch((err) => {
				console.warn(`[ExperimentManager] Failed to rehydrate grid for ${id}:`, err);
			});
		}
	}

	async seekToGeneration(id: string, generation: number): Promise<void> {
		const exp = this.experiments[id];
		if (!exp) return;

		const frame = await exp.tape.getFrame(id, generation);
		if (!frame) return;

		const totalCells = exp.config.gridWidth * exp.config.gridHeight;
		exp.currentGrid = unpackBitsetTo01(frame.stateBits, totalCells);
		exp.currentGeneration = generation;
	}
}
