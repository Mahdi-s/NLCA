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
	currentGeneration: number;
	bufferStatus: BufferStatus | null;
}

function generateDbFilename(config: ExperimentConfig): string {
	const ts = Date.now();
	const modelSlug = config.model.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 30);
	return `/nlca-${ts}-${modelSlug}-${config.gridWidth}x${config.gridHeight}.sqlite3`;
}

function generateLabel(config: ExperimentConfig, index: number): string {
	const modelShort = config.model.split('/').pop() ?? config.model;
	return `Exp ${index} · ${modelShort} · ${config.gridWidth}×${config.gridHeight}`;
}

function buildOrchestratorConfig(config: ExperimentConfig): NlcaOrchestratorConfig {
	return {
		apiKey: config.apiKey,
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
	private experimentCounter = 0;
	private index: ExperimentIndex;
	private computeAbortControllers = new Map<string, AbortController>();

	constructor() {
		this.index = new ExperimentIndex();
	}

	get active(): Experiment | null {
		if (!this.activeId) return null;
		return this.experiments[this.activeId] ?? null;
	}

	get experimentList(): Experiment[] {
		return Object.values(this.experiments);
	}

	async loadFromIndex(): Promise<void> {
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
				currentGeneration: 0,
				bufferStatus: null
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
			currentGeneration: 0,
			bufferStatus: null
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

		if (!exp.currentGrid) {
			const totalCells = exp.config.gridWidth * exp.config.gridHeight;
			exp.currentGrid = new Uint32Array(totalCells);
			for (let i = 0; i < totalCells; i++) {
				exp.currentGrid[i] = Math.random() < 0.5 ? 1 : 0;
			}
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
					exp.currentGeneration = generation;
					exp.progress = { current: generation, target: exp.progress.target };

					await exp.tape.appendFrame({
						runId: id,
						generation,
						createdAt: Date.now(),
						stateBits: pack01ToBitset(result.next),
						metrics: result.metrics ? encodeMetrics(result.metrics) : undefined
					});

					if (generation % 5 === 0) {
						await this.index.updateStatus(id, 'running', generation);
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
					console.error(`[ExperimentManager] Experiment ${id} error:`, err);
					return;
				}
			}

			if (!controller.signal.aborted && exp.progress.current >= exp.progress.target) {
				exp.status = 'completed';
				await this.index.updateStatus(id, 'completed', exp.progress.current);
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

		if (this.activeId === id) {
			const remaining = Object.keys(this.experiments);
			this.activeId = remaining.length > 0 ? remaining[0] : null;
		}
	}

	setActive(id: string): void {
		if (id in this.experiments) {
			this.activeId = id;
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
