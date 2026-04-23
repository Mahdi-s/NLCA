import type { NlcaLogEntry, CellLogEntry } from '$lib/server/nlcaLogger.js';
import type { CheckContext, Issue } from '../types.js';
import { expectedOffsetCount, isOffsetValid } from '../neighborhoodTopology.js';

/**
 * Returns true when the cell sits on the boundary — Moore needs |dx|<=1, so an
 * interior cell is one whose `radius` neighborhood fits entirely inside the
 * grid.  We use the largest radius supported (2 for extendedMoore) so this
 * stays valid for all neighborhood types.
 */
function isInterior(cell: CellLogEntry, width: number, height: number, radius: number): boolean {
	return (
		cell.x >= radius && cell.x < width - radius && cell.y >= radius && cell.y < height - radius
	);
}

function radiusFor(neighborhood: CheckContext['neighborhood']): number {
	return neighborhood === 'extendedMoore' ? 2 : 1;
}

export function checkNeighborhood(entry: NlcaLogEntry, ctx: CheckContext): Issue[] {
	const issues: Issue[] = [];
	const expected = expectedOffsetCount(ctx.neighborhood);
	const r = radiusFor(ctx.neighborhood);

	const breakdownByPos = new Map<string, CellLogEntry>();
	for (const c of entry.cellBreakdown) {
		breakdownByPos.set(`${c.x},${c.y}`, c);
	}

	for (const cell of entry.cellBreakdown) {
		// NEIGHBORHOOD_OFFSET_INVALID
		for (const [dx, dy] of cell.neighborhood) {
			if (!isOffsetValid(ctx.neighborhood, dx, dy)) {
				issues.push({
					level: 'error',
					code: 'NEIGHBORHOOD_OFFSET_INVALID',
					message: `Cell ${cell.cellId} (${cell.x}, ${cell.y}) lists invalid offset (${dx}, ${dy}) for ${ctx.neighborhood}.`,
					cellId: cell.cellId,
					evidence: { offset: [dx, dy], neighborhood: ctx.neighborhood }
				});
			}
		}

		// NEIGHBORHOOD_INCOMPLETE — only meaningful for interior cells (edge cells
		// legitimately have fewer in-bounds neighbors when the boundary is clipped).
		if (isInterior(cell, ctx.width, ctx.height, r) && cell.neighborhood.length !== expected) {
			issues.push({
				level: 'warning',
				code: 'NEIGHBORHOOD_INCOMPLETE',
				message: `Interior cell ${cell.cellId} (${cell.x}, ${cell.y}) has ${cell.neighborhood.length} neighbors; ${ctx.neighborhood} expects ${expected}.`,
				cellId: cell.cellId,
				evidence: { actual: cell.neighborhood.length, expected, neighborhood: ctx.neighborhood }
			});
		}

		// NEIGHBORHOOD_STATE_MISMATCH — each [dx, dy, state] should match the
		// neighbor cell's currentState in this same payload.
		for (const [dx, dy, state] of cell.neighborhood) {
			const neighbor = breakdownByPos.get(`${cell.x + dx},${cell.y + dy}`);
			if (!neighbor) continue;
			if (neighbor.currentState !== state) {
				issues.push({
					level: 'error',
					code: 'NEIGHBORHOOD_STATE_MISMATCH',
					message: `Cell ${cell.cellId} reports neighbor at offset (${dx}, ${dy}) state=${state}, but cell ${neighbor.cellId} has currentState=${neighbor.currentState}.`,
					cellId: cell.cellId,
					evidence: {
						offset: [dx, dy],
						reported: state,
						actual: neighbor.currentState,
						neighborCellId: neighbor.cellId
					}
				});
			}
		}
	}

	return issues;
}
