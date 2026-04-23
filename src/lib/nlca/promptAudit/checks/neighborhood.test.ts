import { describe, expect, test } from 'vitest';
import { checkNeighborhood } from './neighborhood.js';
import { ctx, makeCell, makeEntry } from './_testFixtures.js';

describe('checkNeighborhood — NEIGHBORHOOD_INCOMPLETE', () => {
	test('passes for an interior cell with the full Moore set (8 entries)', () => {
		// Interior cell on a 3x3 grid is technically (1,1); use 5x5 instead.
		const allMoore: Array<[number, number, 0 | 1]> = [];
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) if (!(dx === 0 && dy === 0)) allMoore.push([dx, dy, 0]);
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [makeCell({ cellId: 12, x: 2, y: 2, neighborhood: allMoore })]
		});
		expect(
			checkNeighborhood(entry, ctx({ width: 5, height: 5, neighborhood: 'moore' })).filter(
				(i) => i.code === 'NEIGHBORHOOD_INCOMPLETE'
			)
		).toEqual([]);
	});

	test('flags NEIGHBORHOOD_INCOMPLETE when interior cell has fewer entries than expected', () => {
		const partial: Array<[number, number, 0 | 1]> = [
			[-1, -1, 0],
			[0, -1, 0]
			// missing 6 more
		];
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [makeCell({ cellId: 12, x: 2, y: 2, neighborhood: partial })]
		});
		const issues = checkNeighborhood(entry, ctx({ width: 5, height: 5, neighborhood: 'moore' }));
		expect(issues.some((i) => i.code === 'NEIGHBORHOOD_INCOMPLETE')).toBe(true);
	});

	test('does NOT flag NEIGHBORHOOD_INCOMPLETE for an edge cell with fewer entries (boundary clipping)', () => {
		// Corner (0,0) on a 5x5 — only 3 of 8 Moore neighbors are in-bounds
		const corner: Array<[number, number, 0 | 1]> = [
			[1, 0, 0],
			[0, 1, 0],
			[1, 1, 0]
		];
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0, neighborhood: corner })]
		});
		const issues = checkNeighborhood(entry, ctx({ width: 5, height: 5, neighborhood: 'moore' }));
		expect(issues.filter((i) => i.code === 'NEIGHBORHOOD_INCOMPLETE')).toEqual([]);
	});
});

describe('checkNeighborhood — NEIGHBORHOOD_OFFSET_INVALID', () => {
	test('flags an offset outside the declared neighborhood range', () => {
		const bad: Array<[number, number, 0 | 1]> = [[3, 0, 0]]; // outside Moore
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [makeCell({ cellId: 12, x: 2, y: 2, neighborhood: bad })]
		});
		const issues = checkNeighborhood(entry, ctx({ width: 5, height: 5, neighborhood: 'moore' }));
		expect(issues.some((i) => i.code === 'NEIGHBORHOOD_OFFSET_INVALID')).toBe(true);
	});

	test('flags (0,0) as invalid (the cell itself is not a neighbor)', () => {
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [makeCell({ cellId: 12, x: 2, y: 2, neighborhood: [[0, 0, 1]] })]
		});
		const issues = checkNeighborhood(entry, ctx({ width: 5, height: 5, neighborhood: 'moore' }));
		expect(issues.some((i) => i.code === 'NEIGHBORHOOD_OFFSET_INVALID')).toBe(true);
	});

	test('vonNeumann rejects diagonal offsets', () => {
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [makeCell({ cellId: 12, x: 2, y: 2, neighborhood: [[1, 1, 0]] })]
		});
		const issues = checkNeighborhood(
			entry,
			ctx({ width: 5, height: 5, neighborhood: 'vonNeumann' })
		);
		expect(issues.some((i) => i.code === 'NEIGHBORHOOD_OFFSET_INVALID')).toBe(true);
	});
});

describe('checkNeighborhood — NEIGHBORHOOD_STATE_MISMATCH', () => {
	test('flags when a neighbor state disagrees with that cell currentState', () => {
		// Cell 12 at (2,2). Its right neighbor is cell at (3,2), id = 17 on width=5.
		// Cell 17 has currentState=1, but cell 12's neighborhood reports it as 0.
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [
				makeCell({
					cellId: 12,
					x: 2,
					y: 2,
					neighborhood: [[1, 0, 0]] // claims (3,2) is dead
				}),
				makeCell({ cellId: 17, x: 3, y: 2, currentState: 1 })
			]
		});
		const issues = checkNeighborhood(entry, ctx({ width: 5, height: 5 }));
		expect(issues.some((i) => i.code === 'NEIGHBORHOOD_STATE_MISMATCH')).toBe(true);
	});

	test('passes when neighbor states are consistent with their currentState', () => {
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [
				makeCell({ cellId: 12, x: 2, y: 2, neighborhood: [[1, 0, 1]] }),
				makeCell({ cellId: 17, x: 3, y: 2, currentState: 1 })
			]
		});
		const issues = checkNeighborhood(entry, ctx({ width: 5, height: 5 }));
		expect(issues.filter((i) => i.code === 'NEIGHBORHOOD_STATE_MISMATCH')).toEqual([]);
	});
});
