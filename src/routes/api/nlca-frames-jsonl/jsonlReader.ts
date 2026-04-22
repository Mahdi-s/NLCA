import { createReadStream, existsSync, openSync, readSync, closeSync, statSync } from 'fs';
import { createInterface } from 'readline';

/**
 * Streaming helpers for the JSONL frame tapes under `experiments/<runId>/`.
 *
 * The old implementation read the entire file with `readFileSync` then split
 * on '\n', which spikes server memory into the hundreds of MB for a tape
 * that's been running for hours. These helpers keep the steady-state
 * footprint to a single read buffer (<= 256 KiB) for the common tail read,
 * and to one line at a time for linear scans.
 */

const INITIAL_TAIL_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024; // 4 MiB hard ceiling

type JsonlRecord = Record<string, unknown>;

/**
 * Return the last JSON object in a JSONL file by reading a small tail window.
 * If no complete JSON line is found in the window, double the window (up to
 * MAX_TAIL_BYTES) and retry. Malformed trailing lines (partial writes) are
 * skipped and we walk backward to the previous valid line.
 */
export async function findLatestJsonlFrame(path: string): Promise<JsonlRecord | null> {
	if (!existsSync(path)) return null;
	const size = statSync(path).size;
	if (size === 0) return null;

	let window = Math.min(INITIAL_TAIL_BYTES, size);
	while (window <= MAX_TAIL_BYTES) {
		const start = Math.max(0, size - window);
		const text = readTail(path, start, size - start);
		const lines = text.split('\n');
		// Walk backwards, returning the first parseable line.
		for (let i = lines.length - 1; i >= 0; i--) {
			const trimmed = lines[i]!.trim();
			if (!trimmed) continue;
			try {
				return JSON.parse(trimmed) as JsonlRecord;
			} catch {
				// Skip malformed or truncated line; try the previous one.
			}
		}
		// No valid line in this window. If the window already covers the whole
		// file, we're done — return null.
		if (start === 0) return null;
		// Otherwise expand and retry.
		window = Math.min(window * 2, Math.max(size, MAX_TAIL_BYTES));
		if (window >= size) window = size;
	}
	return null;
}

function readTail(path: string, start: number, length: number): string {
	const fd = openSync(path, 'r');
	try {
		const buf = Buffer.alloc(length);
		const n = readSync(fd, buf, 0, length, start);
		return buf.subarray(0, n).toString('utf8');
	} finally {
		closeSync(fd);
	}
}

/**
 * Linear streaming scan for a specific generation. O(file-size / line-size)
 * reads but only holds one line's worth of memory at a time. Good enough for
 * dev scrub; if hosted scrub becomes hot, add a sidecar offset index.
 */
export async function findJsonlFrameByGeneration(
	path: string,
	generation: number
): Promise<JsonlRecord | null> {
	if (!existsSync(path)) return null;
	const rl = createInterface({
		input: createReadStream(path, { encoding: 'utf8' }),
		crlfDelay: Infinity
	});
	try {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let rec: JsonlRecord;
			try {
				rec = JSON.parse(trimmed) as JsonlRecord;
			} catch {
				continue;
			}
			if (rec.generation === generation) {
				return rec;
			}
		}
	} finally {
		rl.close();
	}
	return null;
}

/**
 * Count non-blank lines without buffering the whole file. Equivalent to
 * `wc -l` but tolerant of blank tail lines.
 */
export async function countJsonlLines(path: string): Promise<number> {
	if (!existsSync(path)) return 0;
	const rl = createInterface({
		input: createReadStream(path, { encoding: 'utf8' }),
		crlfDelay: Infinity
	});
	let n = 0;
	try {
		for await (const line of rl) {
			if (line.trim().length > 0) n++;
		}
	} finally {
		rl.close();
	}
	return n;
}
