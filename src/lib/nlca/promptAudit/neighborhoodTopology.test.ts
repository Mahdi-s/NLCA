import { describe, expect, test } from 'vitest';
import {
	expectedOffsets,
	expectedOffsetCount,
	isOffsetValid,
	offsetSetKey
} from './neighborhoodTopology.js';

describe('expectedOffsetCount', () => {
	test('moore = 8', () => {
		expect(expectedOffsetCount('moore')).toBe(8);
	});
	test('vonNeumann = 4', () => {
		expect(expectedOffsetCount('vonNeumann')).toBe(4);
	});
	test('extendedMoore = 24', () => {
		expect(expectedOffsetCount('extendedMoore')).toBe(24);
	});
});

describe('expectedOffsets', () => {
	test('moore returns 8 offsets in [-1,1] range, excluding (0,0)', () => {
		const offs = expectedOffsets('moore');
		expect(offs.length).toBe(8);
		for (const [dx, dy] of offs) {
			expect(Math.abs(dx)).toBeLessThanOrEqual(1);
			expect(Math.abs(dy)).toBeLessThanOrEqual(1);
		}
		expect(offs).not.toContainEqual([0, 0]);
	});

	test('vonNeumann returns the 4 cardinal offsets only', () => {
		const offs = expectedOffsets('vonNeumann');
		const sorted = [...offs].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		expect(sorted).toEqual([
			[-1, 0],
			[0, -1],
			[0, 1],
			[1, 0]
		]);
	});

	test('extendedMoore returns 24 offsets in [-2,2] range, excluding (0,0)', () => {
		const offs = expectedOffsets('extendedMoore');
		expect(offs.length).toBe(24);
		for (const [dx, dy] of offs) {
			expect(Math.abs(dx)).toBeLessThanOrEqual(2);
			expect(Math.abs(dy)).toBeLessThanOrEqual(2);
		}
		expect(offs).not.toContainEqual([0, 0]);
	});
});

describe('isOffsetValid', () => {
	test('moore accepts (-1,1) but rejects (-2,0)', () => {
		expect(isOffsetValid('moore', -1, 1)).toBe(true);
		expect(isOffsetValid('moore', -2, 0)).toBe(false);
	});

	test('vonNeumann rejects diagonals', () => {
		expect(isOffsetValid('vonNeumann', 1, 0)).toBe(true);
		expect(isOffsetValid('vonNeumann', 1, 1)).toBe(false);
	});

	test('extendedMoore accepts (-2,2) and rejects (3,0)', () => {
		expect(isOffsetValid('extendedMoore', -2, 2)).toBe(true);
		expect(isOffsetValid('extendedMoore', 3, 0)).toBe(false);
	});

	test('any neighborhood rejects (0,0) — the cell itself is not a neighbor', () => {
		expect(isOffsetValid('moore', 0, 0)).toBe(false);
		expect(isOffsetValid('vonNeumann', 0, 0)).toBe(false);
		expect(isOffsetValid('extendedMoore', 0, 0)).toBe(false);
	});
});

describe('offsetSetKey', () => {
	test('produces stable keys regardless of array order', () => {
		const a = offsetSetKey([
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1]
		]);
		const b = offsetSetKey([
			[0, -1],
			[0, 1],
			[-1, 0],
			[1, 0]
		]);
		expect(a).toBe(b);
	});
});
