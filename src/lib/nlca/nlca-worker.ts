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
 */

import { extractCellContext } from './neighborhood.js';
import type { CellContext, NlcaNeighborhood } from './types.js';
import type { BoundaryMode } from '$lib/stores/simulation.svelte.js';

export type WorkerBuildContextsMsg = {
	type: 'buildContexts';
	/** Correlation id — echoed back in the response so the caller can resolve the right promise. */
	id: number;
	/**
	 * The raw grid data. We let the structured clone algorithm copy it (one copy per
	 * worker message), which is fast even for large grids: a 512×512 grid is 1MB and
	 * copies in <1ms. We intentionally avoid `transfer` here so the same buffer can be
	 * sent to multiple shard workers simultaneously.
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
};

export type WorkerContextsResultMsg = {
	type: 'contextsResult';
	id: number;
	cells: CellContext[];
};

self.onmessage = (e: MessageEvent<WorkerBuildContextsMsg>) => {
	const { type, id, prev, width, height, neighborhood, boundary, yStart, yEnd } = e.data;
	if (type !== 'buildContexts') return;

	const cells: CellContext[] = [];
	for (let y = yStart; y < yEnd; y++) {
		for (let x = 0; x < width; x++) {
			cells.push(extractCellContext(prev, width, height, x, y, neighborhood, boundary));
		}
	}

	const result: WorkerContextsResultMsg = { type: 'contextsResult', id, cells };
	(self as unknown as Worker).postMessage(result);
};
