import { describe, expect, test } from 'vitest';
import { computeActiveMask, extractCellContext } from './neighborhood.js';

function makeGrid(states: number[]): Uint32Array {
	return new Uint32Array(states);
}

describe('computeActiveMask', () => {
	test('all-zero grid produces all-zero mask', () => {
		const grid = new Uint32Array(9);
		const mask = computeActiveMask(grid, 3, 3, 'moore', 'torus');
		expect(Array.from(mask)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
	});

	test('single live cell flags the whole 3x3 Moore neighborhood as active', () => {
		// Grid:  . . .
		//        . X .
		//        . . .
		const grid = makeGrid([0, 0, 0, 0, 1, 0, 0, 0, 0]);
		const mask = computeActiveMask(grid, 3, 3, 'moore', 'plane');
		expect(Array.from(mask)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
	});

	test('single live cell in a large grid activates only its Moore neighborhood', () => {
		// 5x5 grid, live cell at (2,2). Active region is cells (1..3, 1..3).
		const grid = new Uint32Array(25);
		grid[2 * 5 + 2] = 1;
		const mask = computeActiveMask(grid, 5, 5, 'moore', 'plane');
		const expected = [
			0, 0, 0, 0, 0,
			0, 1, 1, 1, 0,
			0, 1, 1, 1, 0,
			0, 1, 1, 1, 0,
			0, 0, 0, 0, 0
		];
		expect(Array.from(mask)).toEqual(expected);
	});

	test('Von Neumann neighborhood only activates the 4 orthogonal neighbors', () => {
		const grid = new Uint32Array(25);
		grid[2 * 5 + 2] = 1;
		const mask = computeActiveMask(grid, 5, 5, 'vonNeumann', 'plane');
		const expected = [
			0, 0, 0, 0, 0,
			0, 0, 1, 0, 0,
			0, 1, 1, 1, 0,
			0, 0, 1, 0, 0,
			0, 0, 0, 0, 0
		];
		expect(Array.from(mask)).toEqual(expected);
	});

	test('torus boundary — live cell in corner wraps the mask', () => {
		const grid = new Uint32Array(9);
		grid[0] = 1; // corner
		const mask = computeActiveMask(grid, 3, 3, 'moore', 'torus');
		// On a 3x3 torus, the neighborhood of (0,0) covers ALL other cells.
		expect(Array.from(mask)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
	});

	test('plane boundary — live cell in corner does NOT wrap', () => {
		const grid = new Uint32Array(25);
		grid[0] = 1;
		const mask = computeActiveMask(grid, 5, 5, 'moore', 'plane');
		// Only the top-left 2x2 should be flagged.
		const expected = [
			1, 1, 0, 0, 0,
			1, 1, 0, 0, 0,
			0, 0, 0, 0, 0,
			0, 0, 0, 0, 0,
			0, 0, 0, 0, 0
		];
		expect(Array.from(mask)).toEqual(expected);
	});
});

describe('extractCellContext without prevColors', () => {
	test('returns undefined prevColor on self and neighbors', () => {
		const grid = makeGrid([1, 1, 1, 1, 1, 1, 1, 1, 1]);
		const ctx = extractCellContext(grid, 3, 3, 1, 1, 'moore', 'plane');
		expect(ctx.prevColor).toBeUndefined();
		expect(ctx.neighbors[0]!.prevColor).toBeUndefined();
	});
});

describe('extractCellContext with prevColors', () => {
	test('populates self prevColor from prevColors array', () => {
		const grid = makeGrid([1, 1, 1, 1, 1, 1, 1, 1, 1]);
		const prevColors = Array(9).fill(null) as Array<string | null>;
		prevColors[4] = '#FFA500'; // center cell (1,1)
		const ctx = extractCellContext(grid, 3, 3, 1, 1, 'moore', 'plane', prevColors);
		expect(ctx.prevColor).toBe('#FFA500');
	});

	test('sets self prevColor to null when color array entry is null', () => {
		const grid = makeGrid([1, 1, 1, 1, 1, 1, 1, 1, 1]);
		const prevColors = Array(9).fill(null) as Array<string | null>;
		const ctx = extractCellContext(grid, 3, 3, 1, 1, 'moore', 'plane', prevColors);
		expect(ctx.prevColor).toBeNull();
	});

	test('populates neighbor prevColors from prevColors array', () => {
		const grid = makeGrid([1, 1, 1, 1, 1, 1, 1, 1, 1]);
		const prevColors = Array(9).fill(null) as Array<string | null>;
		prevColors[0] = '#FF0000'; // top-left (0,0) = index 0
		const ctx = extractCellContext(grid, 3, 3, 1, 1, 'moore', 'plane', prevColors);
		// NW neighbor of center (1,1) is at (0,0) = index 0
		const nw = ctx.neighbors.find(n => n.dx === -1 && n.dy === -1);
		expect(nw?.prevColor).toBe('#FF0000');
	});

	test('out-of-bounds neighbor (no wrap) gets prevColor null', () => {
		const grid = makeGrid([1, 1, 1, 1, 1, 1, 1, 1, 1]);
		const prevColors = Array(9).fill('#AAAAAA') as Array<string | null>;
		// Corner cell (0,0) — its NW neighbor is out of bounds
		const ctx = extractCellContext(grid, 3, 3, 0, 0, 'moore', 'plane', prevColors);
		const nw = ctx.neighbors.find(n => n.dx === -1 && n.dy === -1);
		expect(nw?.prevColor).toBeNull();
	});
});
