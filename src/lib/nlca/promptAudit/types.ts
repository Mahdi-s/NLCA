import type { NlcaLogEntry } from '$lib/server/nlcaLogger.js';
import type { NlcaNeighborhood } from '../types.js';

export type Severity = 'error' | 'warning' | 'info';

/** A single finding from a check. */
export interface Issue {
	level: Severity;
	/** Stable code, e.g. "POSITION_INDEX_MISMATCH". */
	code: string;
	/** Human-readable description for the UI. */
	message: string;
	/** Optional cell this issue is about — used by the UI to pulse the canvas. */
	cellId?: number;
	/** Optional structured evidence for the UI to render (kept small). */
	evidence?: Record<string, unknown>;
}

/** Context passed to every check. */
export interface CheckContext {
	width: number;
	height: number;
	neighborhood: NlcaNeighborhood;
	colorMode: boolean;
	/** Previous frame's log, if available — used by cross-frame checks. */
	prevFrame?: NlcaLogEntry;
}

/** Per-frame audit result. */
export interface FrameAuditReport {
	generation: number;
	/** Total issue count, regardless of severity. */
	total: number;
	errorCount: number;
	warningCount: number;
	/** Counts grouped by check code, e.g. `{COLOR_MISMATCH: 8}`. */
	byCode: Record<string, number>;
	/** Full issue list — only loaded for the per-frame detail endpoint. */
	issues: Issue[];
}

/** Aggregate report for an entire run. */
export interface AuditReport {
	runId: string;
	frames: number;
	totalIssues: number;
	errorCount: number;
	warningCount: number;
	/** Roll-up of issue counts by check code across all frames. */
	byCode: Record<string, number>;
	/** Per-frame summaries (no individual issues — use the detail endpoint). */
	perFrame: Array<Omit<FrameAuditReport, 'issues'>>;
}

/** A check function signature. */
export type Check = (entry: NlcaLogEntry, ctx: CheckContext) => Issue[];
