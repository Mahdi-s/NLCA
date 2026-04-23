import {
	listLogs,
	readLog,
	hasLogs,
	latestMtimeMs,
	type NlcaLogEntry
} from './nlcaLogger.js';
import { auditFrame, auditRun, type AuditReport, type FrameAuditReport } from '$lib/nlca/promptAudit/index.js';
import type { CheckContext } from '$lib/nlca/promptAudit/types.js';
import type { NlcaNeighborhood } from '$lib/nlca/types.js';

interface RunCacheValue {
	mtime: number;
	report: AuditReport;
}

const runCache = new Map<string, RunCacheValue>();
const CACHE_LIMIT = 20;

export function clearAuditCache(): void {
	runCache.clear();
}

/**
 * Infer the audit context (neighborhood + colorMode) from the log content.
 * The log doesn't carry the experiment config, so we derive it from cell shapes.
 */
export function inferRunContext(entry: NlcaLogEntry): {
	width: number;
	height: number;
	neighborhood: NlcaNeighborhood;
	colorMode: boolean;
} {
	const { width, height } = entry.grid;

	// Find an interior cell (so its neighborhood is the full set, not clipped).
	const isInterior = (x: number, y: number, r: number) =>
		x >= r && x < width - r && y >= r && y < height - r;
	let neighborhood: NlcaNeighborhood = 'moore';
	for (const cell of entry.cellBreakdown) {
		// Try both Moore radius 1 and extendedMoore radius 2.
		if (isInterior(cell.x, cell.y, 2) && cell.neighborhood.length === 24) {
			neighborhood = 'extendedMoore';
			break;
		}
		if (isInterior(cell.x, cell.y, 1)) {
			if (cell.neighborhood.length === 8) {
				neighborhood = 'moore';
				break;
			}
			if (cell.neighborhood.length === 4) {
				neighborhood = 'vonNeumann';
				break;
			}
		}
	}

	// colorMode: any cell in the verbose payload mentioning prevColor, or any
	// decision carrying a color value.
	let colorMode = false;
	const payload = entry.userPayloadSent as { cells?: Array<{ prevColor?: unknown }> } | null;
	if (payload && Array.isArray(payload.cells)) {
		colorMode = payload.cells.some((c) => 'prevColor' in (c as object));
	}
	if (!colorMode) {
		colorMode = entry.response.decisions.some((d) => typeof d.color === 'string');
	}

	return { width, height, neighborhood, colorMode };
}

function loadAllEntries(runId: string): NlcaLogEntry[] {
	const generations = listLogs(runId);
	const entries: NlcaLogEntry[] = [];
	for (const g of generations) {
		const entry = readLog(runId, g);
		if (entry) entries.push(entry);
	}
	return entries;
}

function pruneCacheIfNeeded(): void {
	while (runCache.size > CACHE_LIMIT) {
		const oldest = runCache.keys().next().value;
		if (oldest === undefined) break;
		runCache.delete(oldest);
	}
}

export function loadAndAuditRun(runId: string): AuditReport | null {
	if (!hasLogs(runId)) return null;
	const mtime = latestMtimeMs(runId);
	const cached = runCache.get(runId);
	if (cached && cached.mtime === mtime) return cached.report;

	const entries = loadAllEntries(runId);
	if (entries.length === 0) return null;
	const ctx = inferRunContext(entries[0]);
	const report = auditRun(entries, ctx);
	runCache.set(runId, { mtime, report });
	pruneCacheIfNeeded();
	return report;
}

export function loadAndAuditFrame(runId: string, generation: number): FrameAuditReport | null {
	const entry = readLog(runId, generation);
	if (!entry) return null;
	const ctx: CheckContext = inferRunContext(entry);
	if (generation > 1) {
		const prev = readLog(runId, generation - 1);
		if (prev) ctx.prevFrame = prev;
	}
	return auditFrame(entry, ctx);
}
