import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findLatestJsonlFrame, findJsonlFrameByGeneration, countJsonlLines } from './jsonlReader.js';

let tmpDir: string;

function tmpFile(name = 'frames.jsonl'): string {
	return join(tmpDir, name);
}

function writeFrames(path: string, frames: Array<Record<string, unknown>>): void {
	writeFileSync(path, frames.map((f) => JSON.stringify(f)).join('\n') + '\n', 'utf8');
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'nlca-jsonl-test-'));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('findLatestJsonlFrame', () => {
	test('returns null on missing file', async () => {
		expect(await findLatestJsonlFrame(tmpFile('does-not-exist.jsonl'))).toBeNull();
	});

	test('returns null on empty file', async () => {
		const p = tmpFile();
		writeFileSync(p, '', 'utf8');
		expect(await findLatestJsonlFrame(p)).toBeNull();
	});

	test('returns the last JSON object in a small file', async () => {
		const p = tmpFile();
		writeFrames(p, [
			{ generation: 1, cells: [] },
			{ generation: 2, cells: [[0, 0, '#FF0000']] },
			{ generation: 3, cells: [[1, 1, null]] }
		]);
		const latest = await findLatestJsonlFrame(p);
		expect(latest).toEqual({ generation: 3, cells: [[1, 1, null]] });
	});

	test('returns the last frame when the file has a trailing newline', async () => {
		const p = tmpFile();
		writeFileSync(p, '{"generation":1}\n{"generation":2}\n\n', 'utf8');
		const latest = await findLatestJsonlFrame(p);
		expect(latest).toEqual({ generation: 2 });
	});

	test('skips malformed last lines and walks back to the latest valid line', async () => {
		const p = tmpFile();
		writeFileSync(p, '{"generation":1}\n{"generation":2}\nbogus-truncation-here\n', 'utf8');
		const latest = await findLatestJsonlFrame(p);
		expect(latest).toEqual({ generation: 2 });
	});

	test('handles a frame that is larger than the initial tail window', async () => {
		const p = tmpFile();
		// Build a deliberately-huge final frame (>128 KiB of JSON) to force the
		// tail reader to expand its window. Earlier frames are small.
		writeFrames(p, [{ generation: 1 }, { generation: 2 }]);
		const bigPayload = 'x'.repeat(150_000);
		appendFileSync(p, JSON.stringify({ generation: 3, big: bigPayload }) + '\n', 'utf8');
		const latest = await findLatestJsonlFrame(p);
		expect(latest).toMatchObject({ generation: 3 });
	});
});

describe('findJsonlFrameByGeneration', () => {
	test('finds a specific generation via streaming scan', async () => {
		const p = tmpFile();
		writeFrames(p, [
			{ generation: 1, payload: 'a' },
			{ generation: 2, payload: 'b' },
			{ generation: 3, payload: 'c' }
		]);
		expect(await findJsonlFrameByGeneration(p, 2)).toMatchObject({ payload: 'b' });
	});

	test('returns null when the generation is not present', async () => {
		const p = tmpFile();
		writeFrames(p, [{ generation: 1 }, { generation: 2 }]);
		expect(await findJsonlFrameByGeneration(p, 99)).toBeNull();
	});

	test('returns null on missing file without throwing', async () => {
		expect(await findJsonlFrameByGeneration(tmpFile('missing.jsonl'), 1)).toBeNull();
	});
});

describe('countJsonlLines', () => {
	test('counts non-blank lines without reading the whole file into memory', async () => {
		const p = tmpFile();
		writeFrames(p, [{ generation: 1 }, { generation: 2 }, { generation: 3 }]);
		expect(await countJsonlLines(p)).toBe(3);
	});

	test('ignores blank lines', async () => {
		const p = tmpFile();
		writeFileSync(p, '{"a":1}\n\n{"a":2}\n', 'utf8');
		expect(await countJsonlLines(p)).toBe(2);
	});

	test('returns 0 for missing file', async () => {
		expect(await countJsonlLines(tmpFile('missing.jsonl'))).toBe(0);
	});
});
