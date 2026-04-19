import { describe, expect, test } from 'vitest';
import { extractCellContext } from './neighborhood.js';

function makeGrid(states: number[]): Uint32Array {
	return new Uint32Array(states);
}

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
