import type { NlcaLogEntry } from '$lib/server/nlcaLogger.js';
import type { CheckContext, Issue } from '../types.js';

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

interface PayloadCellColor {
	id: number;
	prevColor: string | null | undefined;
}

function extractPrevColors(payload: unknown): PayloadCellColor[] {
	if (typeof payload !== 'object' || payload === null) return [];
	const obj = payload as Record<string, unknown>;
	if (Array.isArray(obj.cells)) {
		return obj.cells.map((c) => {
			const cell = c as Record<string, unknown>;
			return { id: Number(cell.id), prevColor: cell.prevColor as string | null | undefined };
		});
	}
	// Compressed format does not carry per-cell prevColor, so we skip checks for
	// COLOR_MISMATCH / COLOR_INVALID_HEX in that case.
	return [];
}

export function checkColors(entry: NlcaLogEntry, ctx: CheckContext): Issue[] {
	if (!ctx.colorMode) return [];
	const issues: Issue[] = [];
	const cells = extractPrevColors(entry.userPayloadSent);

	const prevColorByCell = new Map<number, string | undefined>();
	if (ctx.prevFrame) {
		for (const d of ctx.prevFrame.response.decisions) {
			prevColorByCell.set(d.cellId, d.color);
		}
	}

	for (const c of cells) {
		// COLOR_INVALID_HEX
		if (c.prevColor !== null && c.prevColor !== undefined && !HEX_RE.test(c.prevColor)) {
			issues.push({
				level: 'warning',
				code: 'COLOR_INVALID_HEX',
				message: `Cell ${c.id} payload prevColor=${JSON.stringify(c.prevColor)} is not a valid #RRGGBB hex.`,
				cellId: c.id,
				evidence: { prevColor: c.prevColor }
			});
		}

		// COLOR_MISMATCH (cross-frame)
		if (ctx.prevFrame) {
			const expected = prevColorByCell.get(c.id);
			if (expected !== undefined && c.prevColor !== expected) {
				issues.push({
					level: 'warning',
					code: 'COLOR_MISMATCH',
					message: `Cell ${c.id} payload prevColor=${JSON.stringify(c.prevColor)} does not match its frame ${ctx.prevFrame.generation} decision color ${JSON.stringify(expected)}.`,
					cellId: c.id,
					evidence: { payload: c.prevColor, prevDecision: expected }
				});
			}
		}
	}

	return issues;
}
