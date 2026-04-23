import { describe, expect, test } from 'vitest';
import { checkCoverage } from './coverage.js';
import { ctx, makeCell, makeEntry } from './_testFixtures.js';

describe('checkCoverage — MISSING_DECISION', () => {
	test('passes when every payload cellId has a decision', () => {
		const entry = makeEntry({
			cellBreakdown: [
				makeCell({ cellId: 0, x: 0, y: 0 }),
				makeCell({ cellId: 1, x: 1, y: 0 })
			],
			response: {
				rawContent: '',
				usage: null,
				decisions: [
					{ cellId: 0, state: 0 },
					{ cellId: 1, state: 1 }
				]
			}
		});
		expect(checkCoverage(entry, ctx({ colorMode: false })).filter((i) => i.code === 'MISSING_DECISION')).toEqual([]);
	});

	test('flags MISSING_DECISION for any cellId in breakdown without a returned decision', () => {
		const entry = makeEntry({
			cellBreakdown: [
				makeCell({ cellId: 0, x: 0, y: 0 }),
				makeCell({ cellId: 1, x: 1, y: 0 })
			],
			response: {
				rawContent: '',
				usage: null,
				decisions: [{ cellId: 0, state: 0 }]
			}
		});
		const issues = checkCoverage(entry, ctx({ colorMode: false }));
		const missing = issues.filter((i) => i.code === 'MISSING_DECISION');
		expect(missing).toHaveLength(1);
		expect(missing[0].cellId).toBe(1);
		expect(missing[0].level).toBe('error');
	});
});

describe('checkCoverage — INVALID_DECISION_FORMAT', () => {
	test('flags state values other than 0 or 1', () => {
		const entry = makeEntry({
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0 })],
			response: {
				rawContent: '',
				usage: null,
				decisions: [{ cellId: 0, state: 2 as 0 | 1 }]
			}
		});
		const issues = checkCoverage(entry, ctx({ colorMode: false }));
		expect(issues.some((i) => i.code === 'INVALID_DECISION_FORMAT')).toBe(true);
	});

	test('with color mode on, flags malformed hex colors', () => {
		const entry = makeEntry({
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0 })],
			response: {
				rawContent: '',
				usage: null,
				decisions: [{ cellId: 0, state: 1, color: 'red' }]
			}
		});
		const issues = checkCoverage(entry, ctx({ colorMode: true }));
		expect(issues.some((i) => i.code === 'INVALID_DECISION_FORMAT')).toBe(true);
	});

	test('with color mode on, accepts uppercase #RRGGBB', () => {
		const entry = makeEntry({
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0 })],
			response: {
				rawContent: '',
				usage: null,
				decisions: [{ cellId: 0, state: 1, color: '#FF00AA' }]
			}
		});
		expect(
			checkCoverage(entry, ctx({ colorMode: true })).filter(
				(i) => i.code === 'INVALID_DECISION_FORMAT'
			)
		).toEqual([]);
	});

	test('with color mode off, missing color is fine', () => {
		const entry = makeEntry({
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0 })],
			response: {
				rawContent: '',
				usage: null,
				decisions: [{ cellId: 0, state: 0 }]
			}
		});
		expect(checkCoverage(entry, ctx({ colorMode: false }))).toEqual([]);
	});
});
