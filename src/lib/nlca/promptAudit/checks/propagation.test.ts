import { describe, expect, test } from 'vitest';
import { checkPropagation } from './propagation.js';
import { ctx, makeCell, makeEntry } from './_testFixtures.js';

describe('checkPropagation', () => {
	test('returns no issues when no prevFrame is provided (first generation)', () => {
		const entry = makeEntry({
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0, currentState: 1 })]
		});
		expect(checkPropagation(entry, ctx())).toEqual([]);
	});

	test('passes when every currentState matches prev frame decisions', () => {
		const prev = makeEntry({
			generation: 0,
			response: {
				rawContent: '',
				usage: null,
				decisions: [
					{ cellId: 0, state: 1 },
					{ cellId: 5, state: 0 }
				]
			}
		});
		const entry = makeEntry({
			generation: 1,
			cellBreakdown: [
				makeCell({ cellId: 0, x: 0, y: 0, currentState: 1 }),
				makeCell({ cellId: 5, x: 1, y: 1, currentState: 0 })
			]
		});
		expect(checkPropagation(entry, ctx({ prevFrame: prev }))).toEqual([]);
	});

	test('flags STATE_PROPAGATION when currentState does not match previous decision', () => {
		const prev = makeEntry({
			generation: 0,
			response: {
				rawContent: '',
				usage: null,
				decisions: [{ cellId: 5, state: 1 }]
			}
		});
		const entry = makeEntry({
			generation: 1,
			cellBreakdown: [makeCell({ cellId: 5, x: 1, y: 1, currentState: 0 })]
		});
		const issues = checkPropagation(entry, ctx({ prevFrame: prev }));
		expect(issues).toHaveLength(1);
		expect(issues[0].code).toBe('STATE_PROPAGATION');
		expect(issues[0].level).toBe('error');
		expect(issues[0].cellId).toBe(5);
	});

	test('does not flag cells with no previous decision (newly introduced cells skipped)', () => {
		const prev = makeEntry({
			generation: 0,
			response: { rawContent: '', usage: null, decisions: [] }
		});
		const entry = makeEntry({
			generation: 1,
			cellBreakdown: [makeCell({ cellId: 0, x: 0, y: 0, currentState: 1 })]
		});
		expect(checkPropagation(entry, ctx({ prevFrame: prev }))).toEqual([]);
	});
});
