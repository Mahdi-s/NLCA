import { describe, expect, test } from 'vitest';
import { resolveLocalPath, EXPERIMENTS_DIR } from './resolvePath.js';
import { join, sep } from 'path';

describe('resolveLocalPath — safe filename handling', () => {
	test('resolves a valid experiment filename under experiments/<slug>/', () => {
		const out = resolveLocalPath('/nlca-12345-openai-gpt-4o-mini-10x10.sqlite3');
		expect(out).toBe(join(EXPERIMENTS_DIR, 'openai-gpt-4o-mini', 'nlca-12345-openai-gpt-4o-mini-10x10.sqlite3'));
	});

	test('resolves the index DB under experiments/ (no slug subdir)', () => {
		const out = resolveLocalPath('/nlca-index.sqlite3');
		expect(out).toBe(join(EXPERIMENTS_DIR, 'nlca-index.sqlite3'));
	});

	test('resolves the default standalone tape (/nlca.sqlite3) under experiments/', () => {
		// Canvas.svelte constructs an NlcaTape with no args, defaulting to
		// /nlca.sqlite3 — the legacy standalone tape used before per-experiment
		// tapes landed. Has to keep working so WebGPU initialization doesn't break.
		const out = resolveLocalPath('/nlca.sqlite3');
		expect(out).toBe(join(EXPERIMENTS_DIR, 'nlca.sqlite3'));
	});
});

describe('resolveLocalPath — path traversal is blocked', () => {
	test('rejects a path with ".." segments in it', () => {
		expect(() => resolveLocalPath('/../../../etc/passwd')).toThrow();
	});

	test('rejects a path that tries to escape via the slug capture', () => {
		// Old impl regex-matched only a specific filename shape — anything else
		// fell through to modelSlug='unknown' and escaped via the raw dbPath.
		expect(() => resolveLocalPath('../../etc/shadow')).toThrow();
	});

	test('rejects bare "..", backslash traversal, and absolute paths outside experiments', () => {
		expect(() => resolveLocalPath('..')).toThrow();
		expect(() => resolveLocalPath('..\\..\\windows\\system32')).toThrow();
		expect(() => resolveLocalPath('/absolute/not-our-file.sqlite3')).toThrow();
	});

	test('rejects an empty filename', () => {
		expect(() => resolveLocalPath('')).toThrow();
		expect(() => resolveLocalPath('/')).toThrow();
	});

	test('resolved path must start with EXPERIMENTS_DIR + separator', () => {
		// Positive case for boundary assertion.
		const out = resolveLocalPath('/nlca-12345-m-10x10.sqlite3');
		expect(out.startsWith(EXPERIMENTS_DIR + sep)).toBe(true);
	});
});
