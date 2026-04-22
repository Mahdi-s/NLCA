import { describe, expect, test } from 'vitest';
import { hashCellContext } from './orchestrator.js';
import type { CellState01 } from './types.js';

type BwNeighbor = [number, number, CellState01];
type ColorNeighbor = [number, number, CellState01, string | null];

describe('hashCellContext (B/W mode)', () => {
	test('returns a number so Map lookup is O(1) integer-keyed', () => {
		const neighbors: BwNeighbor[] = [[0, -1, 1]];
		const hash = hashCellContext(0, neighbors);
		expect(typeof hash).toBe('number');
		expect(Number.isFinite(hash)).toBe(true);
	});

	test('identical neighborhoods at different positions produce the same hash', () => {
		// Two cells with the same (self, neighbor-states-in-canonical-order) must
		// collide in the dedupe cache — that IS the dedup win.
		const neighbors1: BwNeighbor[] = [
			[-1, -1, 1], [0, -1, 0], [1, -1, 1],
			[-1, 0, 0],              [1, 0, 0],
			[-1, 1, 1], [0, 1, 0], [1, 1, 1]
		];
		const neighbors2: BwNeighbor[] = neighbors1.map(n => [n[0], n[1], n[2]]);
		expect(hashCellContext(1, neighbors1)).toBe(hashCellContext(1, neighbors2));
	});

	test('different self state flips the hash', () => {
		const neighbors: BwNeighbor[] = [[0, -1, 1]];
		expect(hashCellContext(0, neighbors)).not.toBe(hashCellContext(1, neighbors));
	});

	test('different neighbor state flips the hash', () => {
		const a: BwNeighbor[] = [[0, -1, 1]];
		const b: BwNeighbor[] = [[0, -1, 0]];
		expect(hashCellContext(0, a)).not.toBe(hashCellContext(0, b));
	});

	test('history states affect the hash', () => {
		const neighbors: BwNeighbor[] = [[0, -1, 1]];
		const h1: CellState01[] = [0, 1, 0];
		const h2: CellState01[] = [1, 0, 1];
		expect(hashCellContext(0, neighbors, h1)).not.toBe(hashCellContext(0, neighbors, h2));
	});

	test('neighborhood size affects hash (Moore vs Von Neumann dont collide)', () => {
		const moore: BwNeighbor[] = [
			[-1, -1, 0], [0, -1, 0], [1, -1, 0],
			[-1, 0, 0],              [1, 0, 0],
			[-1, 1, 0], [0, 1, 0], [1, 1, 0]
		];
		const vn: BwNeighbor[] = [
			[0, -1, 0], [0, 1, 0],
			[-1, 0, 0], [1, 0, 0]
		];
		// Different neighborhood cardinality must not collide, even if all states are 0.
		expect(hashCellContext(0, moore)).not.toBe(hashCellContext(0, vn));
	});
});

describe('hashCellContext (color mode)', () => {
	test('returns a number for color-mode contexts', () => {
		const neighbors: ColorNeighbor[] = [[0, -1, 1, '#FF0000']];
		const hash = hashCellContext(0, neighbors, undefined, '#00FF00');
		expect(typeof hash).toBe('number');
	});

	test('different neighbor colors flip the hash', () => {
		const a: ColorNeighbor[] = [[0, -1, 1, '#FF0000']];
		const b: ColorNeighbor[] = [[0, -1, 1, '#00FF00']];
		expect(hashCellContext(0, a)).not.toBe(hashCellContext(0, b));
	});

	test('null prevColor and defined prevColor hash differently', () => {
		const neighbors: BwNeighbor[] = [[0, -1, 1]];
		expect(hashCellContext(0, neighbors, undefined, null)).not.toBe(
			hashCellContext(0, neighbors, undefined, '#000000')
		);
	});
});

describe('hashCellContext performance', () => {
	test('completes 100k hashes well under old-impl baseline', () => {
		const neighbors: BwNeighbor[] = [
			[-1, -1, 1], [0, -1, 0], [1, -1, 1],
			[-1, 0, 0],              [1, 0, 0],
			[-1, 1, 1], [0, 1, 0], [1, 1, 1]
		];
		const history: CellState01[] = [1, 0, 1, 0];
		const start = performance.now();
		for (let i = 0; i < 100_000; i++) {
			hashCellContext(i & 1 ? 1 : 0, neighbors, history);
		}
		const elapsed = performance.now() - start;
		// The old string-concat impl on a typical dev machine sat around 150-200ms
		// for 100k calls; the bit-packed impl should sit well under 50ms.
		// Loose bound (<150ms) so CI machines with noisy CPU still pass.
		expect(elapsed).toBeLessThan(150);
	});
});
