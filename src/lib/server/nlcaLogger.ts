/**
 * Server-side disk logger for NLCA experiment runs.
 *
 * Each API call (per-cell or frame-batched) produces one JSON file under:
 *   logs/nlca/<runId>/gen-<NNNN>-<timestamp>.json
 *
 * The file contains the full system prompt, the exact user payload sent to the
 * model, and a per-cell breakdown that includes x/y coordinates, neighborhood,
 * history, and the decision returned — everything you need to audit whether
 * cell positioning is correctly represented in the prompts.
 *
 * All writes are fire-and-forget; logging errors never propagate to the caller.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/** One cell entry in the breakdown array */
export interface CellLogEntry {
	cellId: number;
	x: number;
	y: number;
	/** 0 = dead / off, 1 = alive / on */
	currentState: 0 | 1;
	aliveNeighborCount: number;
	/** Full neighborhood: each entry is [dx, dy, neighborState] */
	neighborhood: Array<[number, number, 0 | 1]>;
	/** Optional windowed history of past states (most-recent last) */
	history?: Array<0 | 1>;
	/** Decision returned by the model (null if not yet resolved in per-cell mode) */
	decision: 0 | 1 | null;
	/** Hex color if color mode is enabled */
	color?: string;
}

/** Payload written to a log file */
export interface NlcaLogEntry {
	runId: string;
	generation: number;
	/** ISO-8601 timestamp of when the batch was sent */
	timestamp: string;
	timestampMs: number;
	model: string;
	provider: 'openrouter' | 'sambanova';
	/** Which call path generated this log */
	mode: 'frame-batched' | 'frame-batched-stream' | 'per-cell';
	grid: { width: number; height: number };
	/** Exact system prompt string sent to the model */
	systemPrompt: string;
	/**
	 * Exact user payload sent to the model (as the model receives it).
	 * This is the compressed/minified JSON object, not the raw cell array.
	 */
	userPayloadSent: unknown;
	/**
	 * Expanded per-cell breakdown — always verbose regardless of whether the
	 * wire payload was compressed.  This makes it easy to look up any cell by
	 * (x, y) and see exactly what context it received.
	 */
	cellBreakdown: CellLogEntry[];
	response: {
		/** Raw string returned by the model (empty for streaming) */
		rawContent: string;
		/** Parsed decisions — always present after a successful call */
		decisions: Array<{ cellId: number; state: 0 | 1; color?: string }>;
		usage: { promptTokens: number; completionTokens: number } | null;
	};
	latencyMs: number;
	/** Any error message if the call failed */
	error?: string;
}

function resolveLogsDir(runId: string): string {
	// Always resolve relative to process.cwd() so it lands in the repo root.
	return join(process.cwd(), 'logs', 'nlca', runId);
}

function genPaddedStr(generation: number): string {
	return String(generation).padStart(4, '0');
}

/**
 * Write a log entry to disk.  Non-blocking (uses sync writes on a best-effort
 * basis; errors are swallowed so they never interrupt experiment execution).
 */
export function writeNlcaLog(entry: NlcaLogEntry): void {
	try {
		const dir = resolveLogsDir(entry.runId);
		mkdirSync(dir, { recursive: true });
		const filename = `gen-${genPaddedStr(entry.generation)}-${entry.timestampMs}.json`;
		const filePath = join(dir, filename);
		writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf8');
		console.log(`[NLCA LOG] Written: logs/nlca/${entry.runId}/${filename} (${entry.cellBreakdown.length} cells)`);
	} catch (err) {
		console.warn('[NLCA LOG] Failed to write log entry:', err instanceof Error ? err.message : String(err));
	}
}

/**
 * Build the verbose cell breakdown from a raw cells array.
 * Works for both the compressed and verbose API payload shapes.
 */
export function buildCellBreakdown(
	cells: Array<{
		cellId: number;
		x: number;
		y: number;
		self: 0 | 1;
		neighborhood: Array<[number, number, 0 | 1]>;
		history?: Array<0 | 1>;
	}>,
	decisions: Array<{ cellId: number; state: 0 | 1; color?: string }>
): CellLogEntry[] {
	const decisionMap = new Map(decisions.map((d) => [d.cellId, d]));
	return cells.map((c) => {
		const aliveNeighborCount = c.neighborhood.filter((n) => n[2] === 1).length;
		const decision = decisionMap.get(c.cellId);
		return {
			cellId: c.cellId,
			x: c.x,
			y: c.y,
			currentState: c.self,
			aliveNeighborCount,
			neighborhood: c.neighborhood,
			history: c.history,
			decision: decision ? decision.state : null,
			color: decision?.color
		};
	});
}
