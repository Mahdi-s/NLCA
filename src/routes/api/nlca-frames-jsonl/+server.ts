import { json, error, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { existsSync } from 'fs';
import { mkdir, writeFile, appendFile, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { redactExperimentConfigForPersistence, type ExperimentConfig } from '$lib/nlca/types.js';
import { enqueueFileMutation } from '$lib/server/fileMutationQueue.js';
import { deriveFrameCount } from './frameCount.js';
import {
	findLatestJsonlFrame,
	findJsonlFrameByGeneration
} from './jsonlReader.js';

// #region agent log
function postDebugLog(
	location: string,
	message: string,
	data: Record<string, unknown>,
	hypothesisId: string
): void {
	fetch('http://127.0.0.1:7569/ingest/ff2fa46d-1b83-4d22-8de5-bf276ff29f2d', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '9e7e3d' },
		body: JSON.stringify({
			sessionId: '9e7e3d',
			runId: 'initial',
			hypothesisId,
			location,
			message,
			data,
			timestamp: Date.now()
		})
	}).catch(() => {});
}
// #endregion

/**
 * Dev-only, file-system-backed JSONL tape.
 *
 * Layout under <repo-root>/experiments:
 *   experiments/<runId>/meta.json       — config + latest status snapshot
 *   experiments/<runId>/frames.jsonl    — one JSON object per generation
 *                                         ({generation, createdAt, width, height,
 *                                          cells: [[x,y,colorHex|null], ...],
 *                                          metrics: {avgLatencyMs, changedCount}})
 *
 * Sits alongside the existing SQLite tape — SQLite stays the in-browser fast
 * cache; this endpoint gives the user a plain-text audit trail they can
 * `cat | jq .` without needing a SQLite client.
 */

const EXPERIMENTS_DIR = join(process.cwd(), 'experiments');

function validateRunId(runId: unknown): string {
	if (typeof runId !== 'string') throw error(400, 'runId must be a string');
	// Guard against path traversal — runIds are UUIDs in normal use.
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) throw error(400, 'Invalid runId format');
	return runId;
}

function runDir(runId: string): string {
	return join(EXPERIMENTS_DIR, runId);
}

type FrameRecord = {
	generation: number;
	createdAt: number;
	width: number;
	height: number;
	cells: Array<[number, number, string | null]>;
};

type ExpandedFrame = {
	generation: number;
	createdAt: number;
	width: number;
	height: number;
	grid01: number[];
	colorsHex: Array<string | null> | null;
};

function expandFrame(frame: FrameRecord): ExpandedFrame {
	const total = frame.width * frame.height;
	const grid01 = new Array<number>(total).fill(0);
	const colorsHex = new Array<string | null>(total).fill(null);
	for (const [x, y, hex] of frame.cells) {
		if (x < 0 || x >= frame.width || y < 0 || y >= frame.height) continue;
		const idx = y * frame.width + x;
		grid01[idx] = 1;
		colorsHex[idx] = hex;
	}
	return {
		generation: frame.generation,
		createdAt: frame.createdAt,
		width: frame.width,
		height: frame.height,
		grid01,
		colorsHex: colorsHex.some((c) => c != null) ? colorsHex : null
	};
}

/**
 * GET /api/nlca-frames-jsonl?runId=X[&generation=N]
 *   → { meta, latest, frame?, frameCount }
 *
 * `latest` is the final frame in the tape (used for rehydrate-on-load).
 * When `generation=N` is provided, `frame` is the expanded state at that
 * generation (used by the scrubber / prev / next buttons — SQLite is
 * in-memory only in browser dev mode so seeks have to go to disk).
 */
export const GET: RequestHandler = async ({ url }) => {
	if (!dev) throw error(403, 'Frames JSONL only available in dev mode');
	const runId = validateRunId(url.searchParams.get('runId'));
	const dir = runDir(runId);
	const empty = { meta: null, latest: null, frame: null, frameCount: 0 };
	if (!existsSync(dir)) return json(empty);

	let meta: unknown = null;
	const metaPath = join(dir, 'meta.json');
	if (existsSync(metaPath)) {
		try {
			meta = JSON.parse(await readFile(metaPath, 'utf8'));
		} catch {
			meta = null;
		}
	}

	const framesPath = join(dir, 'frames.jsonl');
	if (!existsSync(framesPath)) return json({ ...empty, meta });
	// #region agent log
	const requestStartedAt = performance.now();
	// #endregion

	// Stream the file instead of loading it wholesale. `latest` needs only the
	// tail of the file; `frame` scans linearly with readline. Keeps server
	// memory flat as tapes grow into multi-MB territory.
	// #region agent log
	const latestStartedAt = performance.now();
	// #endregion
	const latestRecord = (await findLatestJsonlFrame(framesPath)) as FrameRecord | null;
	// #region agent log
	const latestDurationMs = Math.round((performance.now() - latestStartedAt) * 100) / 100;
	// #endregion
	const latest = latestRecord ? expandFrame(latestRecord) : null;

	const requested = url.searchParams.get('generation');
	const wantedGen = requested !== null ? Number(requested) : null;
	let match: ExpandedFrame | null = null;
	// #region agent log
	let matchDurationMs = 0;
	// #endregion
	if (wantedGen !== null && Number.isFinite(wantedGen)) {
		// #region agent log
		const matchStartedAt = performance.now();
		// #endregion
		const matchRecord = (await findJsonlFrameByGeneration(
			framesPath,
			wantedGen
		)) as FrameRecord | null;
		// #region agent log
		matchDurationMs = Math.round((performance.now() - matchStartedAt) * 100) / 100;
		// #endregion
		if (matchRecord) match = expandFrame(matchRecord);
	}

	const frameCount = deriveFrameCount(meta as { progress?: { current?: unknown } } | null, latestRecord);
	// #region agent log
	const totalDurationMs = Math.round((performance.now() - requestStartedAt) * 100) / 100;
	if (totalDurationMs >= 50 || latestDurationMs >= 50 || matchDurationMs >= 50) {
		postDebugLog(
			'src/routes/api/nlca-frames-jsonl/+server.ts:123',
			'JSONL frame request timing',
			{
				runId,
				wantedGeneration: wantedGen,
				latestDurationMs,
				matchDurationMs,
				totalDurationMs,
				latestGeneration: latestRecord?.generation ?? null,
				frameCount
			},
			'F'
		);
	}
	// #endregion

	return json({
		meta,
		latest,
		frame: match,
		frameCount
	});
};

export const POST: RequestHandler = async ({ request }) => {
	if (!dev) throw error(403, 'Frames JSONL only available in dev mode');

	let body: { runId?: unknown; meta?: unknown; frame?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const runId = validateRunId(body.runId);
	const dir = runDir(runId);
	if (!existsSync(dir)) await mkdir(dir, { recursive: true });

	if (body.meta !== undefined) {
		const metaPath = join(dir, 'meta.json');
		const meta = body.meta as Record<string, unknown>;
		if (meta.config && typeof meta.config === 'object') {
			meta.config = redactExperimentConfigForPersistence(meta.config as ExperimentConfig);
		}
		await enqueueFileMutation(metaPath, async () => {
			await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
		});
	}

	if (body.frame !== undefined) {
		if (typeof body.frame !== 'string') {
			throw error(400, 'frame must be a pre-serialised JSONL line');
		}
		const framesPath = join(dir, 'frames.jsonl');
		const line = body.frame.endsWith('\n') ? body.frame : body.frame + '\n';
		await enqueueFileMutation(framesPath, async () => {
			await appendFile(framesPath, line, 'utf8');
		});
	}

	// Batched frame appends — N lines in a single append. Callers buffer
	// on the client and flush as one HTTP round-trip to cut persistence
	// pressure by ~N× when many experiments run concurrently.
	if ((body as { frames?: unknown }).frames !== undefined) {
		const frames = (body as { frames?: unknown }).frames;
		if (!Array.isArray(frames) || !frames.every((f) => typeof f === 'string')) {
			throw error(400, 'frames must be an array of pre-serialised JSONL lines');
		}
		if (frames.length > 0) {
			const framesPath = join(dir, 'frames.jsonl');
			const blob = (frames as string[])
				.map((f) => (f.endsWith('\n') ? f : f + '\n'))
				.join('');
			await enqueueFileMutation(framesPath, async () => {
				await appendFile(framesPath, blob, 'utf8');
			});
		}
	}

	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ url }) => {
	if (!dev) throw error(403, 'Frames JSONL only available in dev mode');
	const runId = validateRunId(url.searchParams.get('runId'));
	const dir = runDir(runId);
	if (existsSync(dir)) {
		await rm(dir, { recursive: true, force: true });
	}
	return json({ ok: true });
};
