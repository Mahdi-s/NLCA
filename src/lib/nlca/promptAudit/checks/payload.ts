import type { NlcaLogEntry, CellLogEntry } from '$lib/server/nlcaLogger.js';
import type { CheckContext, Issue } from '../types.js';

/** Field names that, if present in the payload, indicate a leaked global view. */
const FORBIDDEN_KEYS = ['grid', 'fullGrid', 'allCells', 'globalState'];

interface PayloadCellView {
	id: number;
	x: number;
	y: number;
	self: 0 | 1;
}

/** Extract per-cell views from either the verbose `cells` array or the compressed `d` tuples. */
function extractCellViews(payload: unknown): PayloadCellView[] | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const obj = payload as Record<string, unknown>;

	if (Array.isArray(obj.cells)) {
		return obj.cells.map((c) => {
			const cell = c as Record<string, unknown>;
			return {
				id: Number(cell.id),
				x: Number(cell.x),
				y: Number(cell.y),
				self: Number(cell.self) as 0 | 1
			};
		});
	}

	if (Array.isArray(obj.d)) {
		return obj.d.map((tuple) => {
			const t = tuple as unknown[];
			return {
				id: Number(t[0]),
				x: Number(t[1]),
				y: Number(t[2]),
				self: Number(t[3]) as 0 | 1
			};
		});
	}

	return null;
}

export function checkPayload(entry: NlcaLogEntry, _ctx: CheckContext): Issue[] {
	const issues: Issue[] = [];
	const payload = entry.userPayloadSent;

	// PAYLOAD_LEAK — flag known global-state field names.
	if (typeof payload === 'object' && payload !== null) {
		const obj = payload as Record<string, unknown>;
		for (const key of FORBIDDEN_KEYS) {
			if (key in obj) {
				issues.push({
					level: 'error',
					code: 'PAYLOAD_LEAK',
					message: `Payload contains forbidden global-state field "${key}". Per-cell payloads must only carry per-cell views.`,
					evidence: { field: key }
				});
			}
		}
	}

	// PAYLOAD_BREAKDOWN_MISMATCH — every payload cell must appear in cellBreakdown
	// with matching (x, y, self).
	const views = extractCellViews(payload);
	if (views) {
		const breakdownById = new Map<number, CellLogEntry>(
			entry.cellBreakdown.map((c) => [c.cellId, c])
		);
		for (const v of views) {
			const b = breakdownById.get(v.id);
			if (!b) {
				issues.push({
					level: 'error',
					code: 'PAYLOAD_BREAKDOWN_MISMATCH',
					message: `Cell ${v.id} appears in the wire payload but is missing from cellBreakdown.`,
					cellId: v.id,
					evidence: { payload: v }
				});
				continue;
			}
			if (b.x !== v.x || b.y !== v.y || b.currentState !== v.self) {
				issues.push({
					level: 'error',
					code: 'PAYLOAD_BREAKDOWN_MISMATCH',
					message: `Cell ${v.id} payload (x=${v.x}, y=${v.y}, self=${v.self}) disagrees with breakdown (x=${b.x}, y=${b.y}, currentState=${b.currentState}).`,
					cellId: v.id,
					evidence: {
						payload: v,
						breakdown: { x: b.x, y: b.y, currentState: b.currentState }
					}
				});
			}
		}
	}

	return issues;
}
