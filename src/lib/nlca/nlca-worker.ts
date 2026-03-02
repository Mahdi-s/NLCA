/**
 * NLCA Web Worker — context building off the main thread.
 *
 * Accepts a `buildContexts` message, computes CellContext for every cell in
 * the requested row range, and posts the results back. Running this in a
 * dedicated worker keeps the browser UI at 60fps even for large grids where
 * the synchronous loop would otherwise block the main thread for hundreds of
 * milliseconds.
 *
 * Multiple instances of this worker can be spawned to shard the work across
 * CPU cores (see NlcaContextWorkerPool in stepper.ts).
 *
 * Supports two data-transfer modes:
 * 1. **SharedArrayBuffer**: Zero-copy — main thread writes grid into shared
 *    memory once via `initSharedGrid`, then workers read directly from it.
 * 2. **Structured clone** (fallback): Grid is copied via postMessage per shard.
 */

import { extractCellContext } from './neighborhood.js';
import { hashCellContext } from './orchestrator.js';
import type { CellContext, NlcaNeighborhood } from './types.js';
import type { BoundaryMode } from '$lib/stores/simulation.svelte.js';

/* ── Message types ─────────────────────────────────────────────────── */

/** One-time setup: receive the SharedArrayBuffer from the main thread. */
export type WorkerInitSharedGridMsg = {
	type: 'initSharedGrid';
	buffer: SharedArrayBuffer;
	width: number;
	height: number;
	/** Byte offset where grid data starts within the SAB. */
	dataOffset: number;
};

export type WorkerBuildContextsMsg = {
	type: 'buildContexts';
	/** Correlation id — echoed back in the response so the caller can resolve the right promise. */
	id: number;
	/**
	 * The raw grid data. When SharedArrayBuffer is active, this may be an empty
	 * placeholder (length 0) — the worker reads from the shared view instead.
	 * Falls back to structured clone when SAB is unavailable.
	 */
	prev: Uint32Array;
	width: number;
	height: number;
	neighborhood: NlcaNeighborhood;
	boundary: BoundaryMode;
	/** First row to process (inclusive). */
	yStart: number;
	/** Last row to process (exclusive). */
	yEnd: number;
	/** When true, compute deduplication hashes for each cell alongside contexts. */
	computeHashes?: boolean;
};

export type WorkerContextsResultMsg = {
	type: 'contextsResult';
	id: number;
	cells: CellContext[];
	/** Parallel array of context hashes — same length as `cells`. Only present when computeHashes was set. */
	hashes?: string[];
};

/* ── Shared grid state (populated by initSharedGrid) ───────────────── */

let sharedView: Uint32Array | null = null;
let sharedWidth = 0;
let sharedHeight = 0;

/* ── Message handler ───────────────────────────────────────────────── */

self.onmessage = (e: MessageEvent<WorkerInitSharedGridMsg | WorkerBuildContextsMsg>) => {
	const msg = e.data;

	if (msg.type === 'initSharedGrid') {
		const { buffer, width, height, dataOffset } = msg;
		sharedWidth = width;
		sharedHeight = height;
		sharedView = new Uint32Array(buffer, dataOffset, width * height);
		return;
	}

	if (msg.type === 'buildContexts') {
		const { id, width, height, neighborhood, boundary, yStart, yEnd, computeHashes } = msg;

		// Use shared grid if available and dimensions match; otherwise fall back
		// to the structured-clone `prev` sent in the message.
		const prev =
			sharedView && sharedWidth === width && sharedHeight === height
				? sharedView
				: msg.prev;

		const cells: CellContext[] = [];
		for (let y = yStart; y < yEnd; y++) {
			for (let x = 0; x < width; x++) {
				cells.push(extractCellContext(prev, width, height, x, y, neighborhood, boundary));
			}
		}

		let hashes: string[] | undefined;
		if (computeHashes) {
			hashes = cells.map((c) => {
				const neighbors = c.neighbors.map((n) => [n.dx, n.dy, n.state] as [number, number, 0 | 1]);
				return hashCellContext(c.self, neighbors);
			});
		}

		const result: WorkerContextsResultMsg = { type: 'contextsResult', id, cells, hashes };
		(self as unknown as Worker).postMessage(result);
	}
};
