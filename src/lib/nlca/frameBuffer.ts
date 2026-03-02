/**
 * NLCA Frame Buffer Manager
 * 
 * Manages a queue of pre-computed frames for smooth playback.
 * The buffer computes frames ahead while playback consumes them.
 */

import type { NlcaCellMetricsFrame } from './types.js';
import type { PromptConfig } from './prompt.js';
import type { NlcaStepper, NlcaProgressCallback } from './stepper.js';

export interface BufferedFrame {
	/** The generation number this frame represents */
	generation: number;
	/** The grid state after this generation's computation */
	grid: Uint32Array;
	/** Cell metrics (latency, changed state) */
	metrics: NlcaCellMetricsFrame;
	/** Optional per-cell color hex outputs (length = width*height) */
	colorsHex?: Array<string | null>;
	/** Optional per-cell color status (0=missing,1=valid,2=invalid) */
	colorStatus8?: Uint8Array;
	/** Timestamp when computation completed */
	computedAt: number;
	/** Time taken to compute this frame in ms */
	computeTimeMs: number;
}

export interface BufferStatus {
	/** Number of frames currently in buffer */
	bufferedCount: number;
	/** Whether buffer has minimum required frames */
	hasMinBuffer: boolean;
	/** Whether buffer is currently computing a frame */
	isComputing: boolean;
	/** Current frame being computed (if any) */
	computingGeneration: number | null;
	/** Progress of current computation (0-1) */
	computingProgress: number;
	/** Average time per frame in ms (for estimation) */
	avgFrameTimeMs: number;
	/** Target buffer size */
	targetBufferSize: number;
	/** Minimum buffer size for playback */
	minBufferSize: number;
}

export interface BufferComputeConfig {
	/** The stepper instance to use for computation */
	stepper: NlcaStepper;
	/** Grid dimensions */
	width: number;
	height: number;
	/** Prompt configuration */
	promptConfig?: PromptConfig;
	/** Callback for progress updates */
	onProgress?: NlcaProgressCallback;
	/** Callback when frame completes */
	onFrameComplete?: (frame: BufferedFrame) => void | Promise<void>;
	/** Callback when buffer status changes */
	onStatusChange?: (status: BufferStatus) => void;
}

/**
 * Frame buffer for managing NLCA playback
 */
export class NlcaFrameBuffer {
	/** Minimum frames required before playback can start */
	private minBufferSize: number;
	/** Target buffer size to maintain */
	private targetBufferSize: number;
	/** The buffered frames queue */
	private buffer: BufferedFrame[] = [];
	/** Whether we're currently computing */
	private isComputing = false;
	/** Generation currently being computed */
	private computingGeneration: number | null = null;
	/** Progress of current computation (0-1) */
	private computingProgress = 0;
	/** Should stop computing */
	private shouldStop = false;
	/** Compute config */
	private config: BufferComputeConfig | null = null;
	/** Frame time history for estimation */
	private frameTimeHistory: number[] = [];
	private maxFrameTimeHistory = 10;
	/** Last grid state (for computing next frame) */
	private lastGrid: Uint32Array | null = null;
	/** Current generation counter */
	private currentGeneration = 0;
	/** Optional stop condition for background runs */
	private stopAtGeneration: number | null = null;

	constructor(minBufferSize = 5, targetBufferSize = 10) {
		this.minBufferSize = minBufferSize;
		this.targetBufferSize = targetBufferSize;
	}

	/**
	 * Initialize the buffer with starting state
	 */
	initialize(startGrid: Uint32Array, startGeneration: number): void {
		this.lastGrid = new Uint32Array(startGrid);
		this.currentGeneration = startGeneration;
		this.buffer = [];
		this.frameTimeHistory = [];
		this.shouldStop = false;
	}

	/**
	 * Set the compute configuration
	 */
	setConfig(config: BufferComputeConfig): void {
		this.config = config;
	}

	/**
	 * Get current buffer status
	 */
	getStatus(): BufferStatus {
		return {
			bufferedCount: this.buffer.length,
			hasMinBuffer: this.buffer.length >= this.minBufferSize,
			isComputing: this.isComputing,
			computingGeneration: this.computingGeneration,
			computingProgress: this.computingProgress,
			avgFrameTimeMs: this.getAvgFrameTime(),
			targetBufferSize: this.targetBufferSize,
			minBufferSize: this.minBufferSize,
		};
	}

	/**
	 * Get average frame computation time in ms
	 */
	getAvgFrameTime(): number {
		if (this.frameTimeHistory.length === 0) return 0;
		const sum = this.frameTimeHistory.reduce((a, b) => a + b, 0);
		return sum / this.frameTimeHistory.length;
	}

	/**
	 * Estimate time to compute N generations
	 */
	estimateTime(generations: number): number {
		const avgTime = this.getAvgFrameTime() || 5000; // Default 5s per frame if no history
		return avgTime * generations;
	}

	/**
	 * Check if buffer has minimum frames for playback
	 */
	hasMinBuffer(): boolean {
		return this.buffer.length >= this.minBufferSize;
	}

	/**
	 * Check if buffer is full
	 */
	isBufferFull(): boolean {
		return this.buffer.length >= this.targetBufferSize;
	}

	/**
	 * Get number of buffered frames
	 */
	getBufferedCount(): number {
		return this.buffer.length;
	}

	/**
	 * Pop the next frame from buffer (for playback)
	 */
	popNextFrame(): BufferedFrame | null {
		return this.buffer.shift() ?? null;
	}

	/**
	 * Peek at the next frame without removing it
	 */
	peekNextFrame(): BufferedFrame | null {
		return this.buffer[0] ?? null;
	}

	/**
	 * Get all buffered frames (for timeline display)
	 */
	getAllFrames(): readonly BufferedFrame[] {
		return this.buffer;
	}

	/**
	 * Get the last computed grid state
	 */
	getLastGrid(): Uint32Array | null {
		return this.lastGrid;
	}

	/**
	 * Get current generation
	 */
	getCurrentGeneration(): number {
		return this.currentGeneration;
	}

	/**
	 * Start computing frames to fill the buffer
	 * Continues until stopped, buffer is full, or an optional stop generation is reached
	 */
	async startComputing(options?: { stopAtGeneration?: number }): Promise<void> {
		if (this.isComputing) return;
		if (!this.config) throw new Error('Buffer config not set');
		if (!this.lastGrid) throw new Error('Buffer not initialized');

		const stopAt =
			typeof options?.stopAtGeneration === 'number' && Number.isFinite(options.stopAtGeneration)
				? Math.max(0, Math.floor(options.stopAtGeneration))
				: null;

		this.shouldStop = false;
		this.isComputing = true;
		this.stopAtGeneration = stopAt;
		this.notifyStatusChange();

		try {
			while (!this.shouldStop) {
				if (this.stopAtGeneration !== null && this.currentGeneration >= this.stopAtGeneration) break;
				// In normal mode, stop when the buffer is full. In stopAt mode, we keep computing
				// and drop older frames to keep memory bounded.
				if (this.stopAtGeneration === null && this.isBufferFull()) break;
				await this.computeNextFrame();
			}
		} finally {
			this.isComputing = false;
			this.computingGeneration = null;
			this.computingProgress = 0;
			this.stopAtGeneration = null;
			this.notifyStatusChange();
		}
	}

	/**
	 * Compute a single frame and add to buffer
	 */
	private async computeNextFrame(): Promise<void> {
		if (!this.config) return;
		if (!this.lastGrid) return;

		const { stepper, width, height, promptConfig, onProgress, onFrameComplete } = this.config;
		const generation = this.currentGeneration;

		this.computingGeneration = generation;
		this.computingProgress = 0;
		this.notifyStatusChange();

		const startTime = performance.now();

		try {
			const callbacks: NlcaProgressCallback = {
				...onProgress,
				onBatchProgress: (completed, total, partialGrid) => {
					this.computingProgress = completed / total;
					this.notifyStatusChange();
					onProgress?.onBatchProgress?.(completed, total, partialGrid);
				}
			};

			// Consume any speculative contexts pre-built during the previous generation's
			// streaming pass. If the grid matches closely enough, context building is skipped.
			const speculativePromise = stepper.consumeSpeculative(generation);
			const prebuilt = speculativePromise ? await speculativePromise : undefined;

			const { next, metrics, colorsHex, colorStatus8 } = await stepper.step(
				this.lastGrid,
				width,
				height,
				generation,
				callbacks,
				promptConfig,
				prebuilt
			);

			const computeTimeMs = performance.now() - startTime;

			// Create frame
			const frame: BufferedFrame = {
				generation: generation + 1,
				grid: next,
				metrics: metrics ?? {
					latency8: new Uint8Array(width * height),
					changed01: new Uint8Array(width * height)
				},
				colorsHex: colorsHex ? [...colorsHex] : undefined,
				colorStatus8: colorStatus8 ? new Uint8Array(colorStatus8) : undefined,
				computedAt: Date.now(),
				computeTimeMs
			};

			// Update state
			// If we're running until a stop generation, keep the buffer bounded by dropping old frames.
			// (Frames are assumed to be persisted externally via onFrameComplete, e.g. to NLCA tape.)
			if (this.stopAtGeneration !== null && this.targetBufferSize > 0) {
				while (this.buffer.length >= this.targetBufferSize) this.buffer.shift();
			}
			this.buffer.push(frame);
			this.lastGrid = new Uint32Array(next);
			this.currentGeneration = generation + 1;

			// Track frame time
			this.frameTimeHistory.push(computeTimeMs);
			if (this.frameTimeHistory.length > this.maxFrameTimeHistory) {
				this.frameTimeHistory.shift();
			}

			// Notify
			await onFrameComplete?.(frame);
			this.notifyStatusChange();

		} catch (err) {
			console.error('[NLCA Buffer] Frame computation failed:', err);
			throw err;
		}
	}

	/**
	 * Stop computing (gracefully finish current frame)
	 */
	stopComputing(): void {
		this.shouldStop = true;
	}

	/**
	 * Clear the buffer and reset state
	 */
	clear(): void {
		this.stopComputing();
		this.buffer = [];
		this.lastGrid = null;
		this.currentGeneration = 0;
		this.frameTimeHistory = [];
		this.notifyStatusChange();
	}

	/**
	 * Seek to a specific generation (clears buffer after that point)
	 */
	seekTo(generation: number, grid: Uint32Array): void {
		// Remove frames after the target generation
		this.buffer = this.buffer.filter(f => f.generation <= generation);
		this.lastGrid = new Uint32Array(grid);
		this.currentGeneration = generation;
		this.notifyStatusChange();
	}

	/**
	 * Update buffer sizes
	 */
	setBufferSizes(min: number, target: number): void {
		this.minBufferSize = min;
		this.targetBufferSize = target;
	}

	private notifyStatusChange(): void {
		this.config?.onStatusChange?.(this.getStatus());
	}
}

// Singleton instance for global access
let globalBuffer: NlcaFrameBuffer | null = null;

export function getFrameBuffer(): NlcaFrameBuffer {
	if (!globalBuffer) {
		globalBuffer = new NlcaFrameBuffer();
	}
	return globalBuffer;
}

export function resetFrameBuffer(): void {
	globalBuffer?.clear();
	globalBuffer = null;
}
