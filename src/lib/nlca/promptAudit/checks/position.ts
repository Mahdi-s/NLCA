import type { NlcaLogEntry } from '$lib/server/nlcaLogger.js';
import type { CheckContext, Issue } from '../types.js';

export function checkPosition(entry: NlcaLogEntry, ctx: CheckContext): Issue[] {
	const issues: Issue[] = [];
	const { width, height } = ctx;

	for (const cell of entry.cellBreakdown) {
		const { cellId, x, y } = cell;

		const inBounds = x >= 0 && x < width && y >= 0 && y < height;
		if (!inBounds) {
			issues.push({
				level: 'error',
				code: 'POSITION_OUT_OF_BOUNDS',
				message: `Cell ${cellId} at (${x}, ${y}) is outside the ${width}×${height} grid.`,
				cellId,
				evidence: { x, y, width, height }
			});
			continue;
		}

		const expectedId = x + y * width;
		if (cellId !== expectedId) {
			issues.push({
				level: 'error',
				code: 'POSITION_INDEX_MISMATCH',
				message: `Cell ${cellId} at (${x}, ${y}) should have id ${expectedId} (x + y·width).`,
				cellId,
				evidence: { x, y, expectedId, actualId: cellId, width }
			});
		}
	}

	return issues;
}
