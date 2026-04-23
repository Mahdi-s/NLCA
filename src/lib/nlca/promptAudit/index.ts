import type { NlcaLogEntry } from '$lib/server/nlcaLogger.js';
import type {
	AuditReport,
	Check,
	CheckContext,
	FrameAuditReport,
	Issue
} from './types.js';
import { checkPosition } from './checks/position.js';
import { checkPayload } from './checks/payload.js';
import { checkPropagation } from './checks/propagation.js';
import { checkCoverage } from './checks/coverage.js';
import { checkNeighborhood } from './checks/neighborhood.js';
import { checkColors } from './checks/colors.js';
import { checkBoundary } from './checks/boundary.js';

export type {
	AuditReport,
	FrameAuditReport,
	Issue,
	CheckContext,
	Severity
} from './types.js';

const ALL_CHECKS: Check[] = [
	checkPosition,
	checkPayload,
	checkPropagation,
	checkCoverage,
	checkNeighborhood,
	checkColors,
	checkBoundary
];

export function auditFrame(entry: NlcaLogEntry, ctx: CheckContext): FrameAuditReport {
	const issues: Issue[] = [];
	for (const check of ALL_CHECKS) {
		issues.push(...check(entry, ctx));
	}

	const byCode: Record<string, number> = {};
	let errorCount = 0;
	let warningCount = 0;
	for (const issue of issues) {
		byCode[issue.code] = (byCode[issue.code] ?? 0) + 1;
		if (issue.level === 'error') errorCount++;
		else if (issue.level === 'warning') warningCount++;
	}

	return {
		generation: entry.generation,
		total: issues.length,
		errorCount,
		warningCount,
		byCode,
		issues
	};
}

export interface RunCheckContext {
	width: number;
	height: number;
	neighborhood: CheckContext['neighborhood'];
	colorMode: boolean;
}

export function auditRun(entries: NlcaLogEntry[], baseCtx: RunCheckContext): AuditReport {
	if (entries.length === 0) {
		return {
			runId: '',
			frames: 0,
			totalIssues: 0,
			errorCount: 0,
			warningCount: 0,
			byCode: {},
			perFrame: []
		};
	}

	// Order by generation so the prevFrame chain is correct even if the caller
	// passed entries in an arbitrary order.
	const sorted = [...entries].sort((a, b) => a.generation - b.generation);
	const runId = sorted[0].runId;

	const perFrame: AuditReport['perFrame'] = [];
	const byCode: Record<string, number> = {};
	let errorCount = 0;
	let warningCount = 0;
	let totalIssues = 0;

	let prevFrame: NlcaLogEntry | undefined;
	for (const entry of sorted) {
		const ctx: CheckContext = { ...baseCtx, prevFrame };
		const report = auditFrame(entry, ctx);
		const { issues: _issues, ...summary } = report;
		perFrame.push(summary);

		errorCount += report.errorCount;
		warningCount += report.warningCount;
		totalIssues += report.total;
		for (const [code, count] of Object.entries(report.byCode)) {
			byCode[code] = (byCode[code] ?? 0) + count;
		}

		prevFrame = entry;
	}

	return { runId, frames: sorted.length, totalIssues, errorCount, warningCount, byCode, perFrame };
}
