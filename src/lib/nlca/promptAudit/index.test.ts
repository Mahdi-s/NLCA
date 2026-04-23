import { describe, expect, test } from 'vitest';
import { auditFrame, auditRun } from './index.js';
import { ctx, makeCell, makeEntry } from './checks/_testFixtures.js';

describe('auditFrame', () => {
	test('returns a clean report when no checks fire', () => {
		const allMoore: Array<[number, number, 0 | 1]> = [];
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++)
				if (!(dx === 0 && dy === 0)) allMoore.push([dx, dy, 0]);
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [makeCell({ cellId: 12, x: 2, y: 2, neighborhood: allMoore })],
			response: {
				rawContent: '',
				usage: null,
				decisions: [{ cellId: 12, state: 0 }]
			}
		});
		const report = auditFrame(entry, ctx({ width: 5, height: 5 }));
		expect(report.generation).toBe(1);
		expect(report.total).toBe(0);
		expect(report.errorCount).toBe(0);
		expect(report.warningCount).toBe(0);
		expect(report.byCode).toEqual({});
		expect(report.issues).toEqual([]);
	});

	test('groups counts by code and severity', () => {
		const entry = makeEntry({
			grid: { width: 4, height: 4 },
			cellBreakdown: [
				// Wrong cellId for (1,1) on width=4 -> POSITION_INDEX_MISMATCH (error)
				makeCell({ cellId: 99, x: 1, y: 1 })
			],
			response: { rawContent: '', usage: null, decisions: [] }
		});
		const report = auditFrame(entry, ctx({ width: 4, height: 4 }));
		expect(report.errorCount).toBeGreaterThanOrEqual(2); // position + missing decision
		expect(report.byCode['POSITION_INDEX_MISMATCH']).toBe(1);
		expect(report.byCode['MISSING_DECISION']).toBe(1);
	});
});

describe('auditRun', () => {
	test('aggregates per-frame summaries and global counts', () => {
		const f1 = makeEntry({
			runId: 'r1',
			generation: 1,
			grid: { width: 4, height: 4 },
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0 })],
			response: {
				rawContent: '',
				usage: null,
				decisions: [{ cellId: 0, state: 1 }]
			}
		});
		const f2 = makeEntry({
			runId: 'r1',
			generation: 2,
			grid: { width: 4, height: 4 },
			// currentState=0, but f1 decided 1 -> STATE_PROPAGATION
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0, currentState: 0 })],
			response: {
				rawContent: '',
				usage: null,
				decisions: [{ cellId: 0, state: 0 }]
			}
		});
		const report = auditRun([f1, f2], { width: 4, height: 4, neighborhood: 'moore', colorMode: false });

		expect(report.runId).toBe('r1');
		expect(report.frames).toBe(2);
		expect(report.perFrame).toHaveLength(2);
		expect(report.perFrame[0].generation).toBe(1);
		expect(report.perFrame[1].generation).toBe(2);
		expect(report.byCode['STATE_PROPAGATION']).toBe(1);
		expect(report.errorCount).toBeGreaterThanOrEqual(1);
	});

	test('handles empty input', () => {
		const report = auditRun([], { width: 4, height: 4, neighborhood: 'moore', colorMode: false });
		expect(report.runId).toBe('');
		expect(report.frames).toBe(0);
		expect(report.totalIssues).toBe(0);
		expect(report.perFrame).toEqual([]);
	});

	test('per-frame summary excludes the full issues array', () => {
		const entry = makeEntry({
			runId: 'r2',
			grid: { width: 4, height: 4 },
			cellBreakdown: [makeCell({ cellId: 99, x: 1, y: 1 })],
			response: { rawContent: '', usage: null, decisions: [] }
		});
		const report = auditRun([entry], { width: 4, height: 4, neighborhood: 'moore', colorMode: false });
		// @ts-expect-error -- the summary type strips `issues`; this asserts it at runtime too.
		expect(report.perFrame[0].issues).toBeUndefined();
	});
});
