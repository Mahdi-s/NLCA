import type { NlcaLogEntry } from '$lib/server/nlcaLogger.js';
import type { CheckContext, Issue } from '../types.js';

export function checkPropagation(entry: NlcaLogEntry, ctx: CheckContext): Issue[] {
	if (!ctx.prevFrame) return [];
	const prevDecisions = new Map<number, 0 | 1>(
		ctx.prevFrame.response.decisions.map((d) => [d.cellId, d.state])
	);

	const issues: Issue[] = [];
	for (const cell of entry.cellBreakdown) {
		const prev = prevDecisions.get(cell.cellId);
		if (prev === undefined) continue;
		if (prev !== cell.currentState) {
			issues.push({
				level: 'error',
				code: 'STATE_PROPAGATION',
				message: `Cell ${cell.cellId} (${cell.x}, ${cell.y}) entered frame ${entry.generation} with currentState=${cell.currentState}, but its decision in frame ${ctx.prevFrame.generation} was ${prev}.`,
				cellId: cell.cellId,
				evidence: { prevDecision: prev, currentState: cell.currentState }
			});
		}
	}
	return issues;
}
