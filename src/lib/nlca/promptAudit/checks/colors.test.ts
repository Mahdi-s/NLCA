import { describe, expect, test } from 'vitest';
import { checkColors } from './colors.js';
import { ctx, makeCell, makeEntry } from './_testFixtures.js';

describe('checkColors — COLOR_INVALID_HEX', () => {
	test('color mode off: returns no issues regardless of payload colors', () => {
		const entry = makeEntry({
			userPayloadSent: {
				cells: [{ id: 0, x: 0, y: 0, self: 0, prevColor: 'not-a-hex' }]
			},
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0 })]
		});
		expect(checkColors(entry, ctx({ colorMode: false }))).toEqual([]);
	});

	test('flags non-hex prevColor strings when color mode is on', () => {
		const entry = makeEntry({
			userPayloadSent: {
				cells: [{ id: 0, x: 0, y: 0, self: 0, prevColor: 'red' }]
			},
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0 })]
		});
		const issues = checkColors(entry, ctx({ colorMode: true }));
		expect(issues.some((i) => i.code === 'COLOR_INVALID_HEX')).toBe(true);
	});

	test('accepts null prevColor (first generation)', () => {
		const entry = makeEntry({
			userPayloadSent: {
				cells: [{ id: 0, x: 0, y: 0, self: 0, prevColor: null }]
			},
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0 })]
		});
		expect(checkColors(entry, ctx({ colorMode: true }))).toEqual([]);
	});

	test('accepts uppercase #RRGGBB', () => {
		const entry = makeEntry({
			userPayloadSent: {
				cells: [{ id: 0, x: 0, y: 0, self: 0, prevColor: '#FFAA00' }]
			},
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0 })]
		});
		expect(checkColors(entry, ctx({ colorMode: true }))).toEqual([]);
	});
});

describe('checkColors — COLOR_MISMATCH', () => {
	test('passes when prevColor matches the previous frame decision color', () => {
		const prev = makeEntry({
			generation: 0,
			response: {
				rawContent: '',
				usage: null,
				decisions: [{ cellId: 0, state: 1, color: '#FFAA00' }]
			}
		});
		const entry = makeEntry({
			generation: 1,
			userPayloadSent: {
				cells: [{ id: 0, x: 0, y: 0, self: 1, prevColor: '#FFAA00' }]
			},
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0, currentState: 1 })]
		});
		expect(
			checkColors(entry, ctx({ colorMode: true, prevFrame: prev })).filter(
				(i) => i.code === 'COLOR_MISMATCH'
			)
		).toEqual([]);
	});

	test('flags COLOR_MISMATCH when prevColor differs from previous decision color', () => {
		const prev = makeEntry({
			generation: 0,
			response: {
				rawContent: '',
				usage: null,
				decisions: [{ cellId: 0, state: 1, color: '#FFAA00' }]
			}
		});
		const entry = makeEntry({
			generation: 1,
			userPayloadSent: {
				cells: [{ id: 0, x: 0, y: 0, self: 1, prevColor: '#00FFFF' }]
			},
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0, currentState: 1 })]
		});
		const issues = checkColors(entry, ctx({ colorMode: true, prevFrame: prev }));
		const mm = issues.filter((i) => i.code === 'COLOR_MISMATCH');
		expect(mm).toHaveLength(1);
		expect(mm[0].cellId).toBe(0);
		expect(mm[0].level).toBe('warning');
	});

	test('does nothing without prevFrame (first generation)', () => {
		const entry = makeEntry({
			userPayloadSent: {
				cells: [{ id: 0, x: 0, y: 0, self: 0, prevColor: '#FFFFFF' }]
			},
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0 })]
		});
		expect(
			checkColors(entry, ctx({ colorMode: true })).filter((i) => i.code === 'COLOR_MISMATCH')
		).toEqual([]);
	});
});
