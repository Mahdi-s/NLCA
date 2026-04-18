import type { NeighborhoodId } from '@games-of-life/core';

export type NlcaNeighborhood = Extract<NeighborhoodId, 'moore' | 'vonNeumann' | 'extendedMoore'>;

export type CellState01 = 0 | 1;

export type CellColorStatus = 'valid' | 'invalid' | 'missing';

export interface NeighborSample {
	/** Relative X offset (dx) */
	dx: number;
	/** Relative Y offset (dy) */
	dy: number;
	/** Neighbor state from previous frame (0/1) */
	state: CellState01;
}

export interface CellContext {
	/** Stable index into the grid buffer: idx = x + y*width */
	id: number;
	x: number;
	y: number;
	self: CellState01;
	neighbors: NeighborSample[];
}

/** Single-cell request for individual agent calls */
export interface NlcaCellRequest {
	cellId: number;
	x: number;
	y: number;
	self: CellState01;
	neighbors: NeighborSample[];
	generation: number;
	runId: string;
	width: number;
	height: number;
}

/** Single-cell response from an agent */
export interface NlcaCellResponse {
	state: CellState01;
	confidence?: number;
	/** Normalized hex color (\"#RRGGBB\") if provided and valid */
	colorHex?: string;
	/** Status for color parsing if color output is enabled */
	colorStatus?: CellColorStatus;
}

/** Conversation message for agent history */
export interface AgentMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface NlcaModelConfig {
	/** OpenRouter model id, e.g. `openai/gpt-4.1-mini` */
	model: string;
	/** 0 = deterministic */
	temperature: number;
	/** Hard cap to keep responses tiny */
	maxOutputTokens: number;
}

export type ApiProvider = 'openrouter' | 'sambanova';

export interface NlcaOrchestratorConfig {
	apiKey: string;
	/** SambaNova API key — used when apiProvider === 'sambanova'. */
	sambaNovaApiKey?: string;
	/** Which upstream inference provider to route to. Default 'openrouter'. */
	apiProvider?: ApiProvider;
	model: NlcaModelConfig;
	/** Max concurrent LLM calls (one per cell) */
	maxConcurrency: number;
	/** Cells per proxy request (higher amortizes overhead, but reduces UI streaming granularity). */
	batchSize: number;
	/** If true, decide the whole frame in one structured-output call. */
	frameBatched: boolean;
	/** If true, stream frame-batched decisions as SSE for progressive updates. */
	frameStreamed: boolean;
	/** Per-cell decision history length included in frame-batched prompts. */
	memoryWindow: number;
	/** Abort a cell call if it exceeds this */
	cellTimeoutMs: number;
	/** Number of parallel frame chunks to dispatch (default: 1 = sequential). Higher values improve throughput. */
	parallelChunks?: number;
	/** Cells per chunk when splitting frame-batched calls (default: 300). */
	chunkSize?: number;
	/** If true, use compressed payload format to reduce tokens (default: false). */
	compressPayload?: boolean;
	/** If true, deduplicate identical cell contexts within a generation (default: false). */
	deduplicateRequests?: boolean;
}

export interface NlcaRunConfig {
	runId: string;
	createdAt: number;
	width: number;
	height: number;
	neighborhood: NlcaNeighborhood;
	model: string;
	/** Max concurrent calls */
	maxConcurrency: number;
	seed?: string;
	notes?: string;
}

export interface NlcaCellMetricsFrame {
	/**
	 * 0..255 latency bucket for each cell, length = width*height.
	 * 0 means “unknown/not measured”.
	 */
	latency8: Uint8Array;
	/**
	 * 0/1 per cell: did this cell change vs previous frame.
	 */
	changed01: Uint8Array;
}

export interface NlcaStepResult {
	next: Uint32Array;
	metrics?: NlcaCellMetricsFrame;
	/** Optional per-cell color hex outputs (length = width*height) */
	colorsHex?: Array<string | null>;
	/**
	 * Optional per-cell color status (length = width*height).
	 * Encoding: 0=missing, 1=valid, 2=invalid
	 */
	colorStatus8?: Uint8Array;
}

/** Complete configuration snapshot for a single experiment */
export interface ExperimentConfig {
	// Model & Provider
	apiKey: string;
	/** SambaNova API key (kept alongside `apiKey` so either provider can be selected). */
	sambaNovaApiKey?: string;
	/** Which provider this experiment targeted. */
	apiProvider?: ApiProvider;
	model: string;
	temperature: number;
	maxOutputTokens: number;

	// Simulation Parameters
	gridWidth: number;
	gridHeight: number;
	neighborhood: NlcaNeighborhood;
	cellColorEnabled: boolean;

	// Prompt & Task
	taskDescription: string;
	promptPresetId?: string;
	useAdvancedMode: boolean;
	advancedTemplate?: string;

	// LLM / Technical Parameters
	memoryWindow: number;
	maxConcurrency: number;
	batchSize: number;
	frameBatched: boolean;
	frameStreamed: boolean;
	cellTimeoutMs: number;
	compressPayload: boolean;
	deduplicateRequests: boolean;

	// Run Configuration
	targetFrames: number;
}

export type ExperimentStatus = 'running' | 'paused' | 'completed' | 'error';

/** Lightweight metadata stored in the master index DB */
export interface ExperimentMeta {
	id: string;
	label: string;
	dbFilename: string;
	config: ExperimentConfig;
	status: ExperimentStatus;
	createdAt: number;
	updatedAt: number;
	frameCount: number;
	errorMessage?: string;
}
