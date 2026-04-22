import { json, error, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { mkdirSync, existsSync, writeFileSync, appendFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { redactExperimentConfigForPersistence, type ExperimentConfig } from '$lib/nlca/types.js';
import {
	findLatestJsonlFrame,
	findJsonlFrameByGeneration,
	countJsonlLines
} from './jsonlReader.js';

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
			meta = JSON.parse(readFileSync(metaPath, 'utf8'));
		} catch {
			meta = null;
		}
	}

	const framesPath = join(dir, 'frames.jsonl');
	if (!existsSync(framesPath)) return json({ ...empty, meta });

	// Stream the file instead of loading it wholesale. `latest` needs only the
	// tail of the file; `frame` scans linearly with readline. Keeps server
	// memory flat as tapes grow into multi-MB territory.
	const latestRecord = (await findLatestJsonlFrame(framesPath)) as FrameRecord | null;
	const latest = latestRecord ? expandFrame(latestRecord) : null;

	const requested = url.searchParams.get('generation');
	const wantedGen = requested !== null ? Number(requested) : null;
	let match: ExpandedFrame | null = null;
	if (wantedGen !== null && Number.isFinite(wantedGen)) {
		const matchRecord = (await findJsonlFrameByGeneration(
			framesPath,
			wantedGen
		)) as FrameRecord | null;
		if (matchRecord) match = expandFrame(matchRecord);
	}

	const frameCount = await countJsonlLines(framesPath);

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
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	if (body.meta !== undefined) {
		const metaPath = join(dir, 'meta.json');
		const meta = body.meta as Record<string, unknown>;
		if (meta.config && typeof meta.config === 'object') {
			meta.config = redactExperimentConfigForPersistence(meta.config as ExperimentConfig);
		}
		writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
	}

	if (body.frame !== undefined) {
		if (typeof body.frame !== 'string') {
			throw error(400, 'frame must be a pre-serialised JSONL line');
		}
		const framesPath = join(dir, 'frames.jsonl');
		const line = body.frame.endsWith('\n') ? body.frame : body.frame + '\n';
		appendFileSync(framesPath, line, 'utf8');
	}

	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ url }) => {
	if (!dev) throw error(403, 'Frames JSONL only available in dev mode');
	const runId = validateRunId(url.searchParams.get('runId'));
	const dir = runDir(runId);
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
	}
	return json({ ok: true });
};
