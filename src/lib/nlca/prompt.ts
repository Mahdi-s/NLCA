import type { NlcaCellRequest, NlcaCellResponse, CellColorStatus, CellState01 } from './types.js';

/**
 * Prompt strategy for NLCA (Neural-Linguistic Cellular Automata):
 * 
 * Each cell is a binary agent that outputs ONLY 0 or 1:
 * - 1 = ON (active/alive)
 * - 0 = OFF (inactive/dead)
 * 
 * The task and coordination rules are customizable via the prompt config store.
 * System placeholders (cell position, grid size) are filled automatically.
 */

/**
 * Configuration for building cell prompts
 */
export interface PromptConfig {
	/** The task description (what cells should accomplish) */
	taskDescription: string;
	/** Whether to use a custom template */
	useAdvancedMode: boolean;
	/** Custom template with placeholders (advanced mode only) */
	advancedTemplate?: string;
	/** If true, require a deterministic per-cell hex color output */
	cellColorHexEnabled?: boolean;
}

// Default task description (forms a filled square in the center)
const DEFAULT_TASK = `Together with your neighbors, form a solid filled square in the middle of the grid.

Shared goal:
- A single coherent square block centered on the grid, roughly 40% of the grid's width/height on each side.

Your decision:
- Let centerX = gridWidth / 2 and centerY = gridHeight / 2.
- Let halfSide = max(2, floor(min(gridWidth, gridHeight) * 0.20)).
- If |x - centerX| <= halfSide AND |y - centerY| <= halfSide → join the square (state=1).
- Otherwise → stay outside (state=0).
- If you are right at the edge and unsure, use your neighborhood: if most of your neighbors on the "inside" side are alive, close the edge; if most are dead, stay out.`;

function buildOutputContract(cfg?: PromptConfig): string {
	const wantColor = cfg?.cellColorHexEnabled === true;
	if (wantColor) {
		return [
			'Return ONLY JSON (no markdown, no prose, no extra keys).',
			'Format: {"state":0|1,"color":"#RRGGBB"}',
			'- "color" must be exactly 7 chars, leading "#", 6 uppercase hex digits (0-9, A-F).'
		].join('\n');
	}
	return [
		'Return ONLY JSON (no markdown, no prose).',
		'Format: {"state":0} or {"state":1}'
	].join('\n');
}

export function buildOutputContractText(cfg?: PromptConfig): string {
	return buildOutputContract(cfg);
}

// Default template - provides full context about cellular automata
const DEFAULT_TEMPLATE = `== YOUR POSITION ==
You occupy cell ({{CELL_X}}, {{CELL_Y}}) on a {{GRID_WIDTH}}×{{GRID_HEIGHT}} grid.
x increases rightward (0 to {{MAX_X}}), y increases downward (0 to {{MAX_Y}}).

== HOW THIS GRID WORKS ==
{{GRID_WIDTH}}×{{GRID_HEIGHT}} cells update at the same time each generation. Every cell
reads the current frame (its own state + neighbor states), then all cells
commit their next state simultaneously. You cooperate with your neighbors
to accomplish the shared task below — your choice depends on the
collective pattern the group is trying to form, not only on your position
alone.

== TASK ==
{{TASK}}

== INPUT (each generation) ==
A JSON object with:
- "generation": Current time step (0, 1, 2, ...).
- "state": Your current state (0 or 1).
- "neighbors": Count of alive neighbors.
- "neighborhood": Array of [dx, dy, state] — offsets relative to you.

== OUTPUT FORMAT ==
{{OUTPUT_CONTRACT}}`;

/**
 * Replace all placeholders in a template string
 */
function replacePlaceholders(
	template: string,
	x: number,
	y: number,
	width: number,
	height: number,
	task: string,
	outputContract: string
): string {
	return template
		.replace(/\{\{CELL_X\}\}/g, String(x))
		.replace(/\{\{CELL_Y\}\}/g, String(y))
		.replace(/\{\{GRID_WIDTH\}\}/g, String(width))
		.replace(/\{\{GRID_HEIGHT\}\}/g, String(height))
		.replace(/\{\{MAX_X\}\}/g, String(width - 1))
		.replace(/\{\{MAX_Y\}\}/g, String(height - 1))
		.replace(/\{\{TASK\}\}/g, task)
		.replace(/\{\{OUTPUT_CONTRACT\}\}/g, outputContract);
}

/**
 * Build the system prompt for a cell agent.
 * Uses the provided config or falls back to defaults.
 * 
 * @param cellId - Unique cell identifier
 * @param x - Cell X coordinate
 * @param y - Cell Y coordinate  
 * @param width - Grid width
 * @param height - Grid height
 * @param config - Optional prompt configuration
 */
export function buildCellSystemPrompt(
	cellId: number,
	x: number,
	y: number,
	width: number,
	height: number,
	config?: PromptConfig
): string {
	// Use config if provided, otherwise use defaults
	const task = config?.taskDescription ?? DEFAULT_TASK;
	const template = (config?.useAdvancedMode && config?.advancedTemplate) 
		? config.advancedTemplate 
		: DEFAULT_TEMPLATE;

	const outputContract = buildOutputContract(config);
	const filled = replacePlaceholders(template, x, y, width, height, task, outputContract);

	// Ensure the output contract is always explicit and easy to audit, even if a custom template omits it.
	return /\{\{OUTPUT_CONTRACT\}\}/.test(template)
		? filled
		: `${filled}\n\n== OUTPUT CONTRACT ==\n${outputContract}`;
}

/**
 * Legacy function signature for backwards compatibility
 * @deprecated Use buildCellSystemPrompt with config parameter
 */
export function buildCellSystemPromptLegacy(
	cellId: number,
	x: number,
	y: number,
	width: number,
	height: number
): string {
	return buildCellSystemPrompt(cellId, x, y, width, height);
}

/**
 * Build the user prompt for a single cell's decision.
 * Uses clear, descriptive field names so the LLM understands the context.
 */
export function buildCellUserPrompt(req: NlcaCellRequest): string {
	// Count alive neighbors for quick context
	const aliveCount = req.neighbors.filter(n => n.state === 1).length;
	
	// Clear, descriptive format matching what's documented in the system prompt
	const payload = {
		generation: req.generation,
		state: req.self,
		neighbors: aliveCount,
		neighborhood: req.neighbors.map((nn) => [nn.dx, nn.dy, nn.state])
	};
	return JSON.stringify(payload);
}

/**
 * Parse the response from a single cell agent.
 * Handles various response formats gracefully.
 */
export function parseCellResponse(text: string): NlcaCellResponse | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	try {
		// Try to extract JSON from the response (handle markdown code blocks)
		let jsonStr = trimmed;
		
		// Remove markdown code blocks if present
		const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1] ?? trimmed;
		}

		const obj = JSON.parse(jsonStr) as Record<string, unknown>;
		if (!obj || typeof obj !== 'object') return null;

		// Accept "state" or "s" as the key
		const stateRaw = obj.state ?? obj.s;
		const stateNum = Number(stateRaw);
		
		if (!Number.isFinite(stateNum)) return null;
		
		const state: CellState01 = stateNum === 1 ? 1 : 0;

		// Optional confidence
		const confidenceRaw = obj.confidence ?? obj.c;
		const confidence =
			typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
				? Math.max(0, Math.min(1, confidenceRaw))
				: undefined;

		const colorRaw = obj.color;
		let colorHex: string | undefined;
		let colorStatus: CellColorStatus | undefined;
		if (typeof colorRaw === 'string') {
			const normalized = normalizeHexColor(colorRaw);
			if (normalized) {
				colorHex = normalized;
				colorStatus = 'valid';
			} else {
				colorStatus = 'invalid';
			}
		} else if (colorRaw === undefined) {
			colorStatus = 'missing';
		}

		const base: NlcaCellResponse = { state };
		if (confidence !== undefined) base.confidence = confidence;
		if (colorHex !== undefined) base.colorHex = colorHex;
		if (colorStatus !== undefined) base.colorStatus = colorStatus;
		return base;
	} catch {
		// Fallback: try to find just 0 or 1 in the response
		if (/\b1\b/.test(trimmed) && !/\b0\b/.test(trimmed)) {
			return { state: 1 };
		}
		if (/\b0\b/.test(trimmed) && !/\b1\b/.test(trimmed)) {
			return { state: 0 };
		}
		return null;
	}
}

export function normalizeHexColor(input: string): string | null {
	const s = input.trim();
	if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
	return s.toUpperCase();
}

/**
 * Pack a per-cell color into a u32 for the WebGPU render pipeline.
 *
 * Packed format (u32):
 * - bits 0..7: B
 * - bits 8..15: G
 * - bits 16..23: R
 * - bits 24..25: status (0=missing, 1=valid, 2=invalid)
 */
export function packCellColorHexToU32(
	colorHex: string | null | undefined,
	colorStatus: CellColorStatus | undefined
): number {
	let statusBits: number = colorStatus === 'valid' ? 1 : colorStatus === 'invalid' ? 2 : 0;
	let r = 0;
	let g = 0;
	let b = 0;

	if (statusBits === 1 && typeof colorHex === 'string') {
		const normalized = normalizeHexColor(colorHex);
		if (normalized) {
			r = Number.parseInt(normalized.slice(1, 3), 16) & 0xff;
			g = Number.parseInt(normalized.slice(3, 5), 16) & 0xff;
			b = Number.parseInt(normalized.slice(5, 7), 16) & 0xff;
		} else {
			// Defensive: if a caller marks it valid but it doesn't parse, treat as invalid.
			statusBits = 2;
		}
	}

	return ((((statusBits & 0x3) << 24) | (r << 16) | (g << 8) | b) >>> 0) >>> 0;
}


