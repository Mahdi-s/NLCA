import { describe, expect, test } from 'vitest';
import type { NlcaLogEntry } from '$lib/server/nlcaLogger.js';
import type { CheckContext } from '../types.js';
import { checkPosition } from './position.js';

function ctx(overrides: Partial<CheckContext> = {}): CheckContext {
	return {
		width: 10,
		height: 10,
		neighborhood: 'moore',
		colorMode: false,
		...overrides
	};
}

function makeEntry(opts: {
	cellBreakdown?: NlcaLogEntry['cellBreakdown'];
	width?: number;
	height?: number;
}): NlcaLogEntry {
	return {
		runId: 'r',
		generation: 1,
		timestamp: '',
		timestampMs: 0,
		model: '',
		provider: 'openrouter',
		mode: 'frame-batched',
		grid: { width: opts.width ?? 10, height: opts.height ?? 10 },
		systemPrompt: '',
		userPayloadSent: { cells: [] },
		cellBreakdown: opts.cellBreakdown ?? [],
		response: { rawContent: '', decisions: [], usage: null },
		latencyMs: 0
	};
}

describe('checkPosition', () => {
	test('returns no issues when every cellId equals x + y*width', () => {
		const entry = makeEntry({
			width: 4,
			height: 4,
			cellBreakdown: [
				{
					cellId: 0,
					x: 0,
					y: 0,
					currentState: 0,
					aliveNeighborCount: 0,
					neighborhood: [],
					decision: 0
				},
				{
					cellId: 5,
					x: 1,
					y: 1,
					currentState: 1,
					aliveNeighborCount: 0,
					neighborhood: [],
					decision: 0
				}
			]
		});
		const issues = checkPosition(entry, ctx({ width: 4, height: 4 }));
		expect(issues).toEqual([]);
	});

	test('flags POSITION_INDEX_MISMATCH when cellId does not equal x + y*width', () => {
		const entry = makeEntry({
			width: 4,
			height: 4,
			cellBreakdown: [
				{
					cellId: 7, // wrong; should be 5 for (1,1) on width=4
					x: 1,
					y: 1,
					currentState: 0,
					aliveNeighborCount: 0,
					neighborhood: [],
					decision: 0
				}
			]
		});
		const issues = checkPosition(entry, ctx({ width: 4, height: 4 }));
		expect(issues).toHaveLength(1);
		expect(issues[0].code).toBe('POSITION_INDEX_MISMATCH');
		expect(issues[0].level).toBe('error');
		expect(issues[0].cellId).toBe(7);
	});

	test('flags POSITION_OUT_OF_BOUNDS for x or y outside the grid', () => {
		const entry = makeEntry({
			width: 4,
			height: 4,
			cellBreakdown: [
				{
					cellId: 99,
					x: 10,
					y: 0,
					currentState: 0,
					aliveNeighborCount: 0,
					neighborhood: [],
					decision: 0
				},
				{
					cellId: -1,
					x: -1,
					y: 2,
					currentState: 0,
					aliveNeighborCount: 0,
					neighborhood: [],
					decision: 0
				}
			]
		});
		const issues = checkPosition(entry, ctx({ width: 4, height: 4 }));
		const codes = issues.map((i) => i.code).sort();
		expect(codes).toContain('POSITION_OUT_OF_BOUNDS');
		expect(codes.filter((c) => c === 'POSITION_OUT_OF_BOUNDS').length).toBe(2);
	});

	test('handles empty cellBreakdown without errors', () => {
		const entry = makeEntry({ cellBreakdown: [] });
		expect(checkPosition(entry, ctx())).toEqual([]);
	});
});
