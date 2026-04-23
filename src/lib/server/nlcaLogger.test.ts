import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listLogs, readLog, hasLogs, latestMtimeMs, writeNlcaLog, type NlcaLogEntry } from './nlcaLogger.js';

let tmpRoot: string;
let originalCwd: string;

function makeEntry(generation: number, runId: string): NlcaLogEntry {
	return {
		runId,
		generation,
		timestamp: '',
		timestampMs: Date.now(),
		model: 'm',
		provider: 'openrouter',
		mode: 'frame-batched',
		grid: { width: 4, height: 4 },
		systemPrompt: '',
		userPayloadSent: { cells: [] },
		cellBreakdown: [],
		response: { rawContent: '', decisions: [], usage: null },
		latencyMs: 0
	};
}

beforeEach(() => {
	originalCwd = process.cwd();
	tmpRoot = mkdtempSync(join(tmpdir(), 'nlca-logger-'));
	process.chdir(tmpRoot);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe('listLogs', () => {
	test('returns [] when run directory does not exist', () => {
		expect(listLogs('nope')).toEqual([]);
	});

	test('returns generation numbers ascending, no duplicates from retries', () => {
		writeNlcaLog(makeEntry(1, 'r1'));
		writeNlcaLog({ ...makeEntry(1, 'r1'), timestampMs: Date.now() + 1 }); // retry
		writeNlcaLog(makeEntry(3, 'r1'));
		writeNlcaLog(makeEntry(2, 'r1'));
		expect(listLogs('r1')).toEqual([1, 2, 3]);
	});
});

describe('readLog', () => {
	test('returns null when no log exists for that generation', () => {
		expect(readLog('nope', 1)).toBe(null);
	});

	test('returns the entry parsed from disk', () => {
		writeNlcaLog(makeEntry(7, 'r2'));
		const got = readLog('r2', 7);
		expect(got).not.toBe(null);
		expect(got!.generation).toBe(7);
		expect(got!.runId).toBe('r2');
	});

	test('when multiple files exist for the same generation (retries), returns the LATEST one', () => {
		writeNlcaLog({ ...makeEntry(2, 'r3'), timestampMs: 1000 });
		writeNlcaLog({ ...makeEntry(2, 'r3'), timestampMs: 9000 });
		const got = readLog('r3', 2);
		expect(got!.timestampMs).toBe(9000);
	});
});

describe('hasLogs', () => {
	test('true when any log file exists', () => {
		writeNlcaLog(makeEntry(1, 'r4'));
		expect(hasLogs('r4')).toBe(true);
	});
	test('false otherwise', () => {
		expect(hasLogs('nothing')).toBe(false);
	});
});

describe('latestMtimeMs', () => {
	test('returns 0 when no logs exist', () => {
		expect(latestMtimeMs('nope')).toBe(0);
	});

	test('returns the largest mtime among the run logs', () => {
		const entry = makeEntry(1, 'r5');
		writeNlcaLog(entry);
		const dir = join(process.cwd(), 'logs', 'nlca', 'r5');
		mkdirSync(dir, { recursive: true });
		const touched = new Date('2030-01-01T00:00:00Z');
		const file = join(dir, `gen-0001-${entry.timestampMs}.json`);
		utimesSync(file, touched, touched);
		const m = latestMtimeMs('r5');
		expect(m).toBeGreaterThan(0);
	});
});
