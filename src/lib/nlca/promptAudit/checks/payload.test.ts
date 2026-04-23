import { describe, expect, test } from 'vitest';
import { checkPayload } from './payload.js';
import { ctx, makeCell, makeEntry } from './_testFixtures.js';

describe('checkPayload — PAYLOAD_BREAKDOWN_MISMATCH', () => {
	test('passes when verbose payload cells match cellBreakdown', () => {
		const entry = makeEntry({
			userPayloadSent: {
				cells: [
					{ id: 0, x: 0, y: 0, self: 0, aliveNeighbors: 0, neighborhood: [] },
					{ id: 5, x: 1, y: 1, self: 1, aliveNeighbors: 0, neighborhood: [] }
				]
			},
			cellBreakdown: [
				makeCell({ cellId: 0, x: 0, y: 0, currentState: 0 }),
				makeCell({ cellId: 5, x: 1, y: 1, currentState: 1 })
			]
		});
		expect(checkPayload(entry, ctx())).toEqual([]);
	});

	test('passes when compressed payload cells match cellBreakdown', () => {
		// Compressed format: d = [[cellId, x, y, self, aliveCount, [neighborStates]]]
		const entry = makeEntry({
			userPayloadSent: {
				d: [
					[0, 0, 0, 0, 0, []],
					[5, 1, 1, 1, 0, []]
				]
			},
			cellBreakdown: [
				makeCell({ cellId: 0, x: 0, y: 0, currentState: 0 }),
				makeCell({ cellId: 5, x: 1, y: 1, currentState: 1 })
			]
		});
		expect(checkPayload(entry, ctx())).toEqual([]);
	});

	test('flags PAYLOAD_BREAKDOWN_MISMATCH when payload (x,y) differs from breakdown', () => {
		const entry = makeEntry({
			userPayloadSent: {
				cells: [{ id: 5, x: 2, y: 2, self: 0, aliveNeighbors: 0, neighborhood: [] }]
			},
			cellBreakdown: [makeCell({ cellId: 5, x: 1, y: 1 })]
		});
		const issues = checkPayload(entry, ctx());
		expect(issues).toHaveLength(1);
		expect(issues[0].code).toBe('PAYLOAD_BREAKDOWN_MISMATCH');
		expect(issues[0].cellId).toBe(5);
	});

	test('flags PAYLOAD_BREAKDOWN_MISMATCH when payload self differs from breakdown currentState', () => {
		const entry = makeEntry({
			userPayloadSent: {
				cells: [{ id: 5, x: 1, y: 1, self: 0, aliveNeighbors: 0, neighborhood: [] }]
			},
			cellBreakdown: [makeCell({ cellId: 5, x: 1, y: 1, currentState: 1 })]
		});
		const issues = checkPayload(entry, ctx());
		expect(issues.some((i) => i.code === 'PAYLOAD_BREAKDOWN_MISMATCH')).toBe(true);
	});

	test('flags PAYLOAD_BREAKDOWN_MISMATCH when payload has a cellId missing from breakdown', () => {
		const entry = makeEntry({
			userPayloadSent: {
				cells: [{ id: 99, x: 3, y: 3, self: 0, aliveNeighbors: 0, neighborhood: [] }]
			},
			cellBreakdown: []
		});
		const issues = checkPayload(entry, ctx());
		expect(issues.some((i) => i.code === 'PAYLOAD_BREAKDOWN_MISMATCH')).toBe(true);
	});
});

describe('checkPayload — PAYLOAD_LEAK', () => {
	test('passes when payload contains only per-cell view', () => {
		const entry = makeEntry({
			userPayloadSent: {
				cells: [{ id: 0, x: 0, y: 0, self: 0, aliveNeighbors: 0, neighborhood: [] }]
			}
		});
		expect(checkPayload(entry, ctx()).filter((i) => i.code === 'PAYLOAD_LEAK')).toEqual([]);
	});

	test('flags PAYLOAD_LEAK when payload contains a global grid array', () => {
		const entry = makeEntry({
			userPayloadSent: {
				grid: [0, 0, 0, 0, 1, 0, 0, 0, 0],
				cells: []
			}
		});
		const issues = checkPayload(entry, ctx());
		expect(issues.some((i) => i.code === 'PAYLOAD_LEAK')).toBe(true);
	});

	test('flags PAYLOAD_LEAK for known global-state field names', () => {
		for (const key of ['fullGrid', 'allCells', 'globalState']) {
			const entry = makeEntry({ userPayloadSent: { [key]: 'anything', cells: [] } });
			const issues = checkPayload(entry, ctx());
			expect(issues.some((i) => i.code === 'PAYLOAD_LEAK')).toBe(true);
		}
	});
});
