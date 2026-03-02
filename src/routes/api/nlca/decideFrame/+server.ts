import { json, error, type RequestHandler } from '@sveltejs/kit';
import { getCerebrasAgent } from '../_cerebrasAgent.js';

type CellState01 = 0 | 1;

type DecideFrameCell = {
	cellId: number;
	x: number;
	y: number;
	self: CellState01;
	/** Neighborhood samples: [dx, dy, state] */
	neighborhood: Array<[number, number, CellState01]>;
	/** Optional windowed history: most-recent-last */
	history?: CellState01[];
};

type PromptConfigPayload = {
	taskDescription: string;
	useAdvancedMode: boolean;
	advancedTemplate?: string;
	cellColorHexEnabled?: boolean;
	compressPayload?: boolean;
};

type DecideFrameRequest = {
	apiKey: string;
	model: string;
	temperature?: number;
	timeoutMs?: number;
	maxOutputTokens?: number;
	width: number;
	height: number;
	generation: number;
	cells: DecideFrameCell[];
	promptConfig: PromptConfigPayload;
};

type CerebrasChatResponse = {
	id?: string;
	choices?: Array<{ message?: { content?: unknown } }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterSeconds(v: string | null): number | null {
	if (!v) return null;
	const n = Number(v);
	if (Number.isFinite(n) && n > 0) return n;
	return null;
}

async function cerebrasChatOnce(fetchFn: typeof fetch, apiKey: string, body: unknown, timeoutMs: number): Promise<Response> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
	try {
		return await fetchFn('https://api.cerebras.ai/v1/chat/completions', {
			method: 'POST',
			signal: ctrl.signal,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body),
			// @ts-expect-error undici dispatcher not in standard fetch types
			dispatcher: getCerebrasAgent()
		});
	} finally {
		clearTimeout(t);
	}
}

function buildFrameOutputContract(wantColor: boolean): string {
	const formatLine = wantColor
		? 'Format: {"decisions":[{"cellId":0,"state":0|1,"color":"#RRGGBB"}, ...]}'
		: 'Format: {"decisions":[{"cellId":0,"state":0|1}, ...]}';
	return [
		'Return ONLY JSON (no markdown, no prose, no extra keys).',
		formatLine,
		wantColor ? '- "color" must be exactly 7 chars: "#" + 6 uppercase hex digits (0-9, A-F).' : ''
	]
		.filter(Boolean)
		.join('\n');
}

function renderAdvancedTemplateForFrame(
	template: string,
	cfg: PromptConfigPayload,
	width: number,
	height: number,
	outputContract: string
): string {
	// In frame-batched mode, x/y come from each cell entry in the input payload.
	return template
		.replace(/\{\{CELL_X\}\}/g, 'x')
		.replace(/\{\{CELL_Y\}\}/g, 'y')
		.replace(/\{\{GRID_WIDTH\}\}/g, String(width))
		.replace(/\{\{GRID_HEIGHT\}\}/g, String(height))
		.replace(/\{\{MAX_X\}\}/g, String(width - 1))
		.replace(/\{\{MAX_Y\}\}/g, String(height - 1))
		.replace(/\{\{TASK\}\}/g, cfg.taskDescription)
		.replace(/\{\{OUTPUT_CONTRACT\}\}/g, outputContract);
}

function buildSystemPrompt(cfg: PromptConfigPayload, width: number, height: number): string {
	const wantColor = cfg.cellColorHexEnabled === true;
	const compressed = cfg.compressPayload === true;

	const colorLine = wantColor ? 'Color mode is enabled: include a deterministic uppercase hex "#RRGGBB" per cell.' : '';
	const formatLine = compressed
		? 'Cell format: [id,x,y,self,aliveCount,neighborStates]. neighborStates is array of 0/1 in reading order (top-left to bottom-right).'
		: '';

	const hasAdvancedTemplate = cfg.useAdvancedMode === true && typeof cfg.advancedTemplate === 'string' && cfg.advancedTemplate.trim().length > 0;
	if (hasAdvancedTemplate) {
		const outputContract = buildFrameOutputContract(wantColor);
		let rendered = renderAdvancedTemplateForFrame(cfg.advancedTemplate!, cfg, width, height, outputContract);
		if (!cfg.advancedTemplate!.includes('{{OUTPUT_CONTRACT}}')) {
			rendered += `\n\n== OUTPUT CONTRACT ==\n${outputContract}`;
		}

		return [
			'You are computing the next generation of a cellular automaton.',
			'All cells update synchronously: read the provided prev state + neighbors, then output next state for every cell.',
			'Follow the TASK exactly.',
			'Apply the following per-cell system prompt template to each cell entry.',
			'In that template, interpret variables x and y as the cell coordinates from the input payload.',
			formatLine,
			colorLine,
			'',
			rendered,
			'Return ONLY valid JSON matching the provided schema.',
			'Do not include any explanation.'
		]
			.filter(Boolean)
			.join('\n');
	}

	// Default (simple) prompt: keep it short; the schema enforces strict output.
	return [
		'You are computing the next generation of a cellular automaton.',
		'All cells update synchronously: read the provided prev state + neighbors, then output next state for every cell.',
		'Follow the TASK exactly.',
		formatLine,
		colorLine,
		'Return ONLY valid JSON matching the provided schema.',
		'Do not include any explanation.'
	]
		.filter(Boolean)
		.join('\n');
}

function buildUserPayload(req: DecideFrameRequest) {
	const wantColor = req.promptConfig?.cellColorHexEnabled === true;
	const compressed = req.promptConfig?.compressPayload === true;
	
	if (compressed) {
		// Compressed format: reduces token count by ~40-50%
		// Cell format: [id, x, y, self, aliveCount, neighborStates]
		// neighborStates: just the state values (0/1), omitting dx/dy since they're constant
		return {
			g: req.generation,  // generation
			w: req.width,       // width
			h: req.height,      // height
			t: req.promptConfig.taskDescription,  // task
			c: wantColor ? 1 : 0,  // color mode
			d: req.cells.map((cell) => {
				let alive = 0;
				const nStates: CellState01[] = [];
				for (const nn of cell.neighborhood) {
					const s = (nn[2] ?? 0) as CellState01;
					if (s === 1) alive++;
					nStates.push(s);
				}
				// Compact array: [id, x, y, self, aliveCount, neighborStates, history?]
				const arr: (number | CellState01[])[] = [cell.cellId, cell.x, cell.y, cell.self, alive, nStates];
				if (Array.isArray(cell.history) && cell.history.length > 0) {
					arr.push(cell.history);
				}
				return arr;
			})
		};
	}
	
	// Standard verbose format (backwards compatible)
	return {
		generation: req.generation,
		width: req.width,
		height: req.height,
		task: req.promptConfig.taskDescription,
		colorMode: wantColor ? 'on' : 'off',
		cells: req.cells.map((c) => {
			let aliveNeighbors = 0;
			for (const nn of c.neighborhood) if ((nn[2] ?? 0) === 1) aliveNeighbors++;
			return {
				id: c.cellId,
				x: c.x,
				y: c.y,
				self: c.self,
				aliveNeighbors,
				neighborhood: c.neighborhood,
				history: Array.isArray(c.history) ? c.history : undefined
			};
		})
	};
}

function buildJsonSchema(cellCount: number, wantColor: boolean) {
	const colorProp = wantColor
		? {
				color: {
					type: 'string',
					pattern: '^#[0-9A-F]{6}$',
					description: 'Uppercase hex color for this cell'
				}
			}
		: {};

	const required = wantColor ? ['cellId', 'state', 'color'] : ['cellId', 'state'];

	return {
		type: 'object',
		additionalProperties: false,
		properties: {
			decisions: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						cellId: { type: 'integer' },
						state: { type: 'integer', enum: [0, 1] },
						...colorProp
					},
					required
				}
			}
		},
		required: ['decisions']
	} as const;
}

export const POST: RequestHandler = async ({ request, fetch }) => {
	let payload: DecideFrameRequest | null = null;
	try {
		payload = (await request.json()) as DecideFrameRequest;
	} catch {
		// ignore
	}

	const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';
	const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
	const width = Number(payload?.width ?? NaN);
	const height = Number(payload?.height ?? NaN);
	const generation = Number(payload?.generation ?? NaN);
	const cells = Array.isArray(payload?.cells) ? payload!.cells : [];
	const promptConfig = payload?.promptConfig as PromptConfigPayload | undefined;

	if (!apiKey) throw error(400, 'Missing apiKey');
	if (!model) throw error(400, 'Missing model');
	if (!Number.isFinite(width) || width <= 0) throw error(400, 'Invalid width');
	if (!Number.isFinite(height) || height <= 0) throw error(400, 'Invalid height');
	if (!Number.isFinite(generation) || generation < 0) throw error(400, 'Invalid generation');
	if (!promptConfig || typeof promptConfig.taskDescription !== 'string') throw error(400, 'Missing promptConfig.taskDescription');
	if (cells.length === 0) throw error(400, 'No cells provided');

	const temperature = typeof payload?.temperature === 'number' && Number.isFinite(payload.temperature) ? payload.temperature : 0;
	const timeoutMs = typeof payload?.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : 30_000;
	
	// Calculate a safe max_tokens estimate based on cell count and color mode.
	// Each decision: ~30-35 chars without color (~8 tokens), ~40-45 chars with color (~11 tokens).
	// Add 30% buffer for JSON structure overhead (array brackets, commas, etc.).
	const wantColor = promptConfig.cellColorHexEnabled === true;
	const tokensPerDecision = wantColor ? 11 : 8;
	const estimatedTokens = Math.ceil(cells.length * tokensPerDecision * 1.3);
	const userMaxTokens = typeof payload?.maxOutputTokens === 'number' && Number.isFinite(payload.maxOutputTokens) ? payload.maxOutputTokens : 8_192;
	const maxOutputTokens = Math.max(userMaxTokens, estimatedTokens, 8_192);
	const schema = buildJsonSchema(cells.length, wantColor);

	const messages = [
		{ role: 'system', content: buildSystemPrompt(promptConfig, width, height) },
		{ role: 'user', content: JSON.stringify(buildUserPayload({ ...(payload as DecideFrameRequest), cells, promptConfig })) }
	];

	const body = {
		model,
		temperature,
		max_tokens: maxOutputTokens,
		messages,
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'nlca_frame_decisions',
				strict: true,
				schema
			}
		}
	};

	const maxAttempts = 3;
	let attempt = 0;
	const t0 = performance.now();
	while (true) {
		attempt++;
		try {
			const res = await cerebrasChatOnce(fetch, apiKey, body, timeoutMs);

			if (res.status === 429 && attempt < maxAttempts) {
				const retryAfter = parseRetryAfterSeconds(res.headers.get('retry-after'));
				const waitMs = Math.max(250, Math.round(((retryAfter ?? 1) * 1000) + Math.random() * 250));
				await sleep(waitMs);
				continue;
			}
			if (res.status >= 500 && attempt < maxAttempts) {
				const waitMs = Math.round(200 * 2 ** (attempt - 1) + Math.random() * 100);
				await sleep(waitMs);
				continue;
			}

			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw error(res.status, text || `Cerebras error (${res.status})`);
			}

			const data = (await res.json()) as CerebrasChatResponse;
			const content = data?.choices?.[0]?.message?.content;
			const latencyMs = performance.now() - t0;

			// Structured outputs often returns parsed JSON; but some providers still return string.
			const parsed = typeof content === 'string' ? JSON.parse(content) : content;
			const decisions = (parsed as { decisions?: unknown }).decisions;
			if (!Array.isArray(decisions) || decisions.length !== cells.length) {
				throw error(502, 'Model returned invalid decisions array');
			}
			
			// Validate that every requested cellId appears exactly once.
			const expectedIds = new Set<number>();
			for (const c of cells) {
				const id = Number((c as { cellId?: unknown }).cellId ?? NaN);
				if (!Number.isFinite(id)) throw error(400, 'Invalid cellId in request');
				expectedIds.add(id);
			}
			if (expectedIds.size !== cells.length) throw error(400, 'Duplicate cellId in request');

			const seen = new Set<number>();
			for (const d of decisions) {
				const cellId = Number((d as { cellId?: unknown }).cellId ?? NaN);
				if (!Number.isFinite(cellId) || !expectedIds.has(cellId)) {
					throw error(502, 'Model returned invalid cellId');
				}
				if (seen.has(cellId)) throw error(502, 'Model returned duplicate cellId');
				seen.add(cellId);
			}
			if (seen.size !== expectedIds.size) throw error(502, 'Model returned incomplete decisions');

			return json({
				id: data?.id ?? null,
				model,
				usage: data?.usage ?? null,
				latencyMs,
				decisions
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (attempt < maxAttempts) {
				const waitMs = Math.round(200 * 2 ** (attempt - 1) + Math.random() * 100);
				await sleep(waitMs);
				continue;
			}
			throw error(502, msg);
		}
	}
};
