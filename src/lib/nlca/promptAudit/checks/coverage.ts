import type { NlcaLogEntry } from '$lib/server/nlcaLogger.js';
import type { CheckContext, Issue } from '../types.js';

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export function checkCoverage(entry: NlcaLogEntry, ctx: CheckContext): Issue[] {
	const issues: Issue[] = [];
	const decisionMap = new Map<number, { state: 0 | 1; color?: string }>();
	for (const d of entry.response.decisions) {
		decisionMap.set(d.cellId, { state: d.state, color: d.color });
	}

	for (const cell of entry.cellBreakdown) {
		const d = decisionMap.get(cell.cellId);
		if (!d) {
			issues.push({
				level: 'error',
				code: 'MISSING_DECISION',
				message: `Cell ${cell.cellId} (${cell.x}, ${cell.y}) was sent in the payload but no decision came back.`,
				cellId: cell.cellId
			});
			continue;
		}
		if (d.state !== 0 && d.state !== 1) {
			issues.push({
				level: 'error',
				code: 'INVALID_DECISION_FORMAT',
				message: `Cell ${cell.cellId} returned state=${String(d.state)}; only 0 or 1 are valid.`,
				cellId: cell.cellId,
				evidence: { state: d.state }
			});
		}
		if (ctx.colorMode) {
			if (d.color === undefined || d.color === null) {
				issues.push({
					level: 'error',
					code: 'INVALID_DECISION_FORMAT',
					message: `Cell ${cell.cellId} is missing a color value (color mode is on).`,
					cellId: cell.cellId
				});
			} else if (!HEX_RE.test(d.color)) {
				issues.push({
					level: 'error',
					code: 'INVALID_DECISION_FORMAT',
					message: `Cell ${cell.cellId} returned color=${JSON.stringify(d.color)}; expected #RRGGBB.`,
					cellId: cell.cellId,
					evidence: { color: d.color }
				});
			}
		}
	}
	return issues;
}
