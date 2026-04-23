import type { NlcaLogEntry, CellLogEntry } from '$lib/server/nlcaLogger.js';
import type { CheckContext, Issue } from '../types.js';
import { offsetSetKey, expectedOffsetCount } from '../neighborhoodTopology.js';

function isEdgeCell(cell: CellLogEntry, width: number, height: number, radius: number): boolean {
	return (
		cell.x < radius || cell.x >= width - radius || cell.y < radius || cell.y >= height - radius
	);
}

function radiusFor(neighborhood: CheckContext['neighborhood']): number {
	return neighborhood === 'extendedMoore' ? 2 : 1;
}

/**
 * For each edge cell, classify which boundary strategy was used:
 *  - "wrap"   : full neighborhood (count == expected)
 *  - "clip"   : strictly fewer than full
 * Then ensure all edge cells in the frame agree.  If they mix strategies,
 * flag once per frame with the cell ids that diverged.
 */
export function checkBoundary(entry: NlcaLogEntry, ctx: CheckContext): Issue[] {
	const expected = expectedOffsetCount(ctx.neighborhood);
	const r = radiusFor(ctx.neighborhood);

	const strategies = new Map<string, number[]>(); // strategyKey -> cellIds
	for (const cell of entry.cellBreakdown) {
		if (!isEdgeCell(cell, ctx.width, ctx.height, r)) continue;
		const strategy = cell.neighborhood.length === expected ? 'wrap' : 'clip';
		const list = strategies.get(strategy) ?? [];
		list.push(cell.cellId);
		strategies.set(strategy, list);
		// Also note the offset-set shape — different clip strategies (e.g. pad-with-0
		// vs. true clip) may be distinguishable by the offset set.
	}

	if (strategies.size <= 1) return [];

	const summary: Record<string, number> = {};
	for (const [k, v] of strategies) summary[k] = v.length;

	return [
		{
			level: 'warning',
			code: 'EDGE_INCONSISTENT',
			message: `Edge cells use mixed boundary strategies in this frame: ${JSON.stringify(summary)}. Boundary handling should be uniform across the grid.`,
			evidence: { strategies: summary, neighborhood: ctx.neighborhood }
		}
	];
}

// Re-export the helper in case other modules want to inspect offset shapes for
// the boundary heuristic.
export { offsetSetKey };
