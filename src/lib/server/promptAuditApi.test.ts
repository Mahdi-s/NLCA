import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeNlcaLog, type NlcaLogEntry } from './nlcaLogger.js';
import {
	loadAndAuditRun,
	loadAndAuditFrame,
	clearAuditCache,
	inferRunContext
} from './promptAuditApi.js';

let tmpRoot: string;
let originalCwd: string;

function makeEntry(overrides: Partial<NlcaLogEntry> = {}): NlcaLogEntry {
	return {
		runId: 'r',
		generation: 1,
		timestamp: '',
		timestampMs: Date.now(),
		model: 'm',
		provider: 'openrouter',
		mode: 'frame-batched',
		grid: { width: 4, height: 4 },
		systemPrompt: '',
		userPayloadSent: { cells: [] },
		cellBreakdown: [
			{
				cellId: 0,
				x: 0,
				y: 0,
				currentState: 0,
				aliveNeighborCount: 0,
				neighborhood: [],
				decision: 0
			}
		],
		response: {
			rawContent: '',
			usage: null,
			decisions: [{ cellId: 0, state: 0 }]
		},
		latencyMs: 0,
		...overrides
	};
}

beforeEach(() => {
	originalCwd = process.cwd();
	tmpRoot = mkdtempSync(join(tmpdir(), 'nlca-api-'));
	process.chdir(tmpRoot);
	clearAuditCache();
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe('inferRunContext', () => {
	test('infers Moore from 8-neighbor interior cell', () => {
		const entry = makeEntry({
			grid: { width: 5, height: 5 },
			cellBreakdown: [
				{
					cellId: 12,
					x: 2,
					y: 2,
					currentState: 0,
					aliveNeighborCount: 0,
					neighborhood: Array.from({ length: 8 }, (_, i) => [i, 0, 0] as [number, number, 0 | 1]),
					decision: 0
				}
			]
		});
		expect(inferRunContext(entry).neighborhood).toBe('moore');
	});

	test('infers extendedMoore from 24-neighbor interior cell', () => {
		const entry = makeEntry({
			grid: { width: 7, height: 7 },
			cellBreakdown: [
				{
					cellId: 24,
					x: 3,
					y: 3,
					currentState: 0,
					aliveNeighborCount: 0,
					neighborhood: Array.from({ length: 24 }, (_, i) => [i, 0, 0] as [number, number, 0 | 1]),
					decision: 0
				}
			]
		});
		expect(inferRunContext(entry).neighborhood).toBe('extendedMoore');
	});

	test('infers colorMode=true when any cell has a non-undefined prevColor in payload', () => {
		const entry = makeEntry({
			userPayloadSent: {
				cells: [{ id: 0, x: 0, y: 0, self: 0, prevColor: '#FF0000' }]
			}
		});
		expect(inferRunContext(entry).colorMode).toBe(true);
	});

	test('infers colorMode=false when no color fields appear', () => {
		const entry = makeEntry({
			userPayloadSent: { cells: [{ id: 0, x: 0, y: 0, self: 0 }] }
		});
		expect(inferRunContext(entry).colorMode).toBe(false);
	});
});

describe('loadAndAuditRun', () => {
	test('returns null when no logs exist', () => {
		expect(loadAndAuditRun('nope')).toBe(null);
	});

	test('loads logs from disk and returns aggregate report', () => {
		writeNlcaLog(makeEntry({ runId: 'rA', generation: 1 }));
		writeNlcaLog(makeEntry({ runId: 'rA', generation: 2 }));
		const report = loadAndAuditRun('rA');
		expect(report).not.toBe(null);
		expect(report!.runId).toBe('rA');
		expect(report!.frames).toBe(2);
		expect(report!.perFrame).toHaveLength(2);
	});

	test('caches the report based on latest log mtime', () => {
		writeNlcaLog(makeEntry({ runId: 'rB', generation: 1 }));
		const a = loadAndAuditRun('rB');
		const b = loadAndAuditRun('rB');
		// Same object reference indicates a cache hit
		expect(a).toBe(b);
	});

	test('cache invalidates when a new log is added', () => {
		writeNlcaLog(makeEntry({ runId: 'rC', generation: 1, timestampMs: 1000 }));
		const a = loadAndAuditRun('rC');
		writeNlcaLog(makeEntry({ runId: 'rC', generation: 2, timestampMs: 2000 }));
		const b = loadAndAuditRun('rC');
		expect(b!.frames).toBe(2);
		expect(a).not.toBe(b);
	});
});

describe('loadAndAuditFrame', () => {
	test('returns null when generation has no log', () => {
		writeNlcaLog(makeEntry({ runId: 'rD', generation: 1 }));
		expect(loadAndAuditFrame('rD', 99)).toBe(null);
	});

	test('returns full frame report including issues array', () => {
		writeNlcaLog(makeEntry({ runId: 'rE', generation: 1 }));
		const report = loadAndAuditFrame('rE', 1);
		expect(report).not.toBe(null);
		expect(report!.generation).toBe(1);
		expect(Array.isArray(report!.issues)).toBe(true);
	});

	test('uses the previous generation log when computing cross-frame checks', () => {
		// Frame 1 decides cell 0 -> state 1
		writeNlcaLog(
			makeEntry({
				runId: 'rF',
				generation: 1,
				response: {
					rawContent: '',
					usage: null,
					decisions: [{ cellId: 0, state: 1 }]
				}
			})
		);
		// Frame 2's currentState=0 contradicts the decision (STATE_PROPAGATION)
		writeNlcaLog(
			makeEntry({
				runId: 'rF',
				generation: 2,
				cellBreakdown: [
					{
						cellId: 0,
						x: 0,
						y: 0,
						currentState: 0,
						aliveNeighborCount: 0,
						neighborhood: [],
						decision: 0
					}
				]
			})
		);
		const report = loadAndAuditFrame('rF', 2);
		expect(report!.byCode['STATE_PROPAGATION']).toBe(1);
	});
});
