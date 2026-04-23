import type { NlcaLogEntry, CellLogEntry } from '$lib/server/nlcaLogger.js';
import type { CheckContext } from '../types.js';

export function ctx(overrides: Partial<CheckContext> = {}): CheckContext {
	return {
		width: 4,
		height: 4,
		neighborhood: 'moore',
		colorMode: false,
		...overrides
	};
}

export function makeCell(overrides: Partial<CellLogEntry> & { cellId: number; x: number; y: number }): CellLogEntry {
	return {
		currentState: 0,
		aliveNeighborCount: 0,
		neighborhood: [],
		decision: 0,
		...overrides
	};
}

export function makeEntry(overrides: Partial<NlcaLogEntry> = {}): NlcaLogEntry {
	const width = overrides.grid?.width ?? 4;
	const height = overrides.grid?.height ?? 4;
	return {
		runId: 'r',
		generation: 1,
		timestamp: '',
		timestampMs: 0,
		model: '',
		provider: 'openrouter',
		mode: 'frame-batched',
		grid: { width, height },
		systemPrompt: '',
		userPayloadSent: { cells: [] },
		cellBreakdown: [],
		response: { rawContent: '', decisions: [], usage: null },
		latencyMs: 0,
		...overrides
	};
}
