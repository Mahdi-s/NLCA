import { describe, expect, test } from 'vitest';
import { checkBoundary } from './boundary.js';
import { ctx, makeCell, makeEntry } from './_testFixtures.js';

describe('checkBoundary — EDGE_INCONSISTENT', () => {
	test('passes when all edge cells use the same boundary strategy (clip)', () => {
		// 5x5 grid, Moore. Both corners report only their in-bounds neighbors.
		const tlCorner: Array<[number, number, 0 | 1]> = [
			[1, 0, 0],
			[0, 1, 0],
			[1, 1, 0]
		];
		const trCorner: Array<[number, number, 0 | 1]> = [
			[-1, 0, 0],
			[0, 1, 0],
			[-1, 1, 0]
		];
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [
				makeCell({ cellId: 0, x: 0, y: 0, neighborhood: tlCorner }),
				makeCell({ cellId: 4, x: 4, y: 0, neighborhood: trCorner })
			]
		});
		expect(
			checkBoundary(entry, ctx({ width: 5, height: 5 })).filter(
				(i) => i.code === 'EDGE_INCONSISTENT'
			)
		).toEqual([]);
	});

	test('passes when all edge cells use wrap (full 8 neighbors at corner)', () => {
		const allMoore: Array<[number, number, 0 | 1]> = [];
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++)
				if (!(dx === 0 && dy === 0)) allMoore.push([dx, dy, 0]);
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [
				makeCell({ cellId: 0, x: 0, y: 0, neighborhood: allMoore }),
				makeCell({ cellId: 4, x: 4, y: 0, neighborhood: allMoore })
			]
		});
		expect(
			checkBoundary(entry, ctx({ width: 5, height: 5 })).filter(
				(i) => i.code === 'EDGE_INCONSISTENT'
			)
		).toEqual([]);
	});

	test('flags EDGE_INCONSISTENT when one corner clips and another wraps', () => {
		const allMoore: Array<[number, number, 0 | 1]> = [];
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++)
				if (!(dx === 0 && dy === 0)) allMoore.push([dx, dy, 0]);
		const tlClipped: Array<[number, number, 0 | 1]> = [
			[1, 0, 0],
			[0, 1, 0],
			[1, 1, 0]
		];
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [
				makeCell({ cellId: 0, x: 0, y: 0, neighborhood: tlClipped }),
				makeCell({ cellId: 4, x: 4, y: 0, neighborhood: allMoore })
			]
		});
		const issues = checkBoundary(entry, ctx({ width: 5, height: 5 }));
		expect(issues.some((i) => i.code === 'EDGE_INCONSISTENT')).toBe(true);
	});

	test('returns no issues when there are no edge cells in the breakdown', () => {
		const allMoore: Array<[number, number, 0 | 1]> = [];
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++)
				if (!(dx === 0 && dy === 0)) allMoore.push([dx, dy, 0]);
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [makeCell({ cellId: 12, x: 2, y: 2, neighborhood: allMoore })]
		});
		expect(checkBoundary(entry, ctx({ width: 5, height: 5 }))).toEqual([]);
	});
});
