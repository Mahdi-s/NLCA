import { json, error, isHttpError, type RequestHandler } from '@sveltejs/kit';
import { writeNlcaLog, buildCellBreakdown } from '$lib/server/nlcaLogger.js';
import { dev } from '$app/environment';
import { extractApiKey } from '../_shared/extractApiKey.js';

type CellState01 = 0 | 1;

type DecideFrameCell = {
	cellId: number;
	x: number;
	y: number;
	self: CellState01;
	/** [dx, dy, state] or [dx, dy, state, prevColor] when color mode is on */
	neighborhood: Array<[number, number, CellState01] | [number, number, CellState01, string | null]>;
	/** Previous frame color of this cell (#RRGGBB), null = first generation */
	prevColor?: string | null;
	history?: CellState01[];
};

type PromptConfigPayload = {
	taskDescription: string;
	useAdvancedMode: boolean;
	advancedTemplate?: string;
	cellColorHexEnabled?: boolean;
	compressPayload?: boolean;
};

type ApiProvider = 'openrouter' | 'sambanova';

type DecideFrameRequest = {
	apiProvider?: ApiProvider;
	apiKey: string;
	model: string;
	temperature?: number;
	timeoutMs?: number;
	maxOutputTokens?: number;
	width: number;
	height: number;
	generation: number;
	/** Optional experiment/run ID — used for log file organisation only. */
	runId?: string;
	cells: DecideFrameCell[];
	promptConfig: PromptConfigPayload;
};

const SAMBANOVA_DEFAULT_MODEL = 'Meta-Llama-3.3-70B-Instruct';

function resolveUpstream(provider: ApiProvider): string {
	return provider === 'sambanova'
		? 'https://api.sambanova.ai/v1/chat/completions'
		: 'https://openrouter.ai/api/v1/chat/completions';
}

const SAMBANOVA_ZERO_THINKING_SYSTEM =
	'CRITICAL: You are a synchronous cellular automata compute node. Apply the provided task rule to the input array. Output ONLY a valid JSON object matching the strict schema exactly. NO reasoning. NO chain-of-thought. NO markdown blocks (do not use ```json). Output the absolute bare minimum tokens required.';

type OpenRouterChatResponse = {
	id?: string;
	choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
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

async function upstreamChatOnce(
	fetchFn: typeof fetch,
	provider: ApiProvider,
	apiKey: string,
	body: unknown,
	timeoutMs: number
): Promise<Response> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
	try {
		return await fetchFn(resolveUpstream(provider), {
			method: 'POST',
			signal: ctrl.signal,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'http://localhost',
				'X-Title': 'games-of-life-nlca'
			},
			body: JSON.stringify(body)
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

function buildSystemPrompt(
	cfg: PromptConfigPayload,
	width: number,
	height: number,
	provider: ApiProvider
): string {
	const wantColor = cfg.cellColorHexEnabled === true;
	const compressed = cfg.compressPayload === true && !wantColor;

	// SambaNova Hyperscale: rigid zero-thinking directive. Bypass conversational
	// templates entirely. We pair this with json_schema strict=false at the API
	// layer — the schema gives the model a target, the prompt repeats the exact
	// shape for models that ignore the response_format hint, and the loose
	// validation mode lets responses through even when Llama drifts on one cell.
	if (provider === 'sambanova') {
		const schemaLine = wantColor
			? 'Output EXACTLY this JSON shape: {"d":[{"i":<integer cellId>,"s":0 or 1,"c":"#RRGGBB uppercase hex"}, ...]}'
			: 'Output EXACTLY this JSON shape: {"d":[{"i":<integer cellId>,"s":0 or 1}, ...]}';
		return [
			SAMBANOVA_ZERO_THINKING_SYSTEM,
			'',
			`Grid: ${width}×${height}.`,
			`Input rows: [cellId, self, aliveCount, [neighbor_states_in_offset_order]]${wantColor ? ' (color mode ON).' : '.'}`,
			schemaLine,
			'Every input cellId must appear in the output exactly once. No extra keys, no duplicates, no non-JSON text.',
			`Task: ${cfg.taskDescription}`
		].join('\n');
	}

	const colorLine = wantColor
		? [
				'Color mode is enabled.',
				'Each cell\'s "prevColor" field contains its previous frame hex color (null on the first generation).',
				'Each neighbor entry has a 4th element: the neighbor\'s previous color (null if unknown or first generation).',
				'Prefer color continuity: only change a cell\'s color if it clearly improves coherence with its neighbors.',
				'When prevColor is non-null, keep it unless a noticeably better color is obvious from context.',
				'Output a deterministic uppercase hex "#RRGGBB" per cell.'
			].join('\n')
		: '';
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
			'Prefer state continuity: only change a cell\'s state if doing so clearly improves the overall image.',
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
		'Prefer state continuity: only change a cell\'s state if doing so clearly improves the overall image.',
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
	// Force verbose format when color mode is on: neighbor tuples carry prevColor as 4th element,
	// which requires the dx/dy/state/color structure that the compressed format drops.
	const compressed = req.promptConfig?.compressPayload === true && !wantColor;
	const provider: ApiProvider = req.apiProvider === 'sambanova' ? 'sambanova' : 'openrouter';

	// SambaNova Hyperscale: max dedup efficiency. Strip absolute x/y coordinates
	// (they break dedup across identical contexts), strip the task (already in the
	// system prompt), and emit each row as a compact positional array.
	// Format: [cellId, self, aliveCount, [neighborStates]]
	if (provider === 'sambanova') {
		return {
			g: req.generation,
			c: wantColor ? 1 : 0,
			d: req.cells.map((cell) => {
				let alive = 0;
				const nStates: CellState01[] = [];
				for (const nn of cell.neighborhood) {
					const s = (nn[2] ?? 0) as CellState01;
					if (s === 1) alive++;
					nStates.push(s);
				}
				return [cell.cellId, cell.self, alive, nStates] as const;
			})
		};
	}

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
				...(wantColor ? { prevColor: c.prevColor ?? null } : {}),
				aliveNeighbors,
				neighborhood: c.neighborhood,
				history: Array.isArray(c.history) ? c.history : undefined
			};
		})
	};
}

function buildJsonSchema(cellCount: number, wantColor: boolean, provider: ApiProvider) {
	// SambaNova Hyperscale: minified keys — d/i/s/c. Each extra character in a
	// repeated key multiplies across thousands of decisions, so output volume
	// matters far more here than readability.
	if (provider === 'sambanova') {
		const colorProp = wantColor
			? {
					c: { type: 'string', pattern: '^#[0-9A-F]{6}$' }
				}
			: {};
		const required = wantColor ? ['i', 's', 'c'] : ['i', 's'];
		return {
			type: 'object',
			additionalProperties: false,
			properties: {
				d: {
					type: 'array',
					minItems: cellCount,
					maxItems: cellCount,
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							i: { type: 'integer' },
							s: { type: 'integer', enum: [0, 1] },
							...colorProp
						},
						required
					}
				}
			},
			required: ['d']
		} as const;
	}

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
				minItems: cellCount,
				maxItems: cellCount,
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

	const provider: ApiProvider = payload?.apiProvider === 'sambanova' ? 'sambanova' : 'openrouter';
	const apiKey = extractApiKey(request, payload);
	const rawModel = typeof payload?.model === 'string' ? payload.model.trim() : '';
	const model = rawModel || (provider === 'sambanova' ? SAMBANOVA_DEFAULT_MODEL : '');
	const width = Number(payload?.width ?? NaN);
	const height = Number(payload?.height ?? NaN);
	const generation = Number(payload?.generation ?? NaN);
	const runId = typeof payload?.runId === 'string' && payload.runId.trim() ? payload.runId.trim() : `anon-${Date.now()}`;
	const cells = Array.isArray(payload?.cells) ? payload!.cells : [];
	const promptConfig = payload?.promptConfig as PromptConfigPayload | undefined;

	if (!apiKey) throw error(400, 'Missing apiKey');
	if (!model) throw error(400, 'Missing model');
	if (!Number.isFinite(width) || width <= 0) throw error(400, 'Invalid width');
	if (!Number.isFinite(height) || height <= 0) throw error(400, 'Invalid height');
	if (!Number.isFinite(generation) || generation < 0) throw error(400, 'Invalid generation');
	if (!promptConfig || typeof promptConfig.taskDescription !== 'string') throw error(400, 'Missing promptConfig.taskDescription');
	if (cells.length === 0) throw error(400, 'No cells provided');

	// SambaNova is deterministic-only per the hyperscale contract.
	const temperature =
		provider === 'sambanova'
			? 0
			: typeof payload?.temperature === 'number' && Number.isFinite(payload.temperature)
				? payload.temperature
				: 0;
	const timeoutMs = typeof payload?.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : 30_000;
	
	// Per-decision output budget — see decideFrameStream for the rationale.
	// Empirical: ~17 tokens/decision real cost with color; budget +40%.
	// Floor 4096, ceiling 12288 so we never blow small-context windows.
	const wantColor = promptConfig.cellColorHexEnabled === true;
	const tokensPerDecision = wantColor ? 18 : 12;
	const estimatedTokens = Math.ceil(cells.length * tokensPerDecision * 1.4);
	const userMaxTokens =
		typeof payload?.maxOutputTokens === 'number' && Number.isFinite(payload.maxOutputTokens)
			? payload.maxOutputTokens
			: 8_192;
	const maxOutputTokens = Math.max(
		4096,
		Math.min(12_288, Math.max(userMaxTokens, estimatedTokens))
	);
	const schema = buildJsonSchema(cells.length, wantColor, provider);

	const messages = [
		{ role: 'system', content: buildSystemPrompt(promptConfig, width, height, provider) },
		{
			role: 'user',
			content: JSON.stringify(
				buildUserPayload({ ...(payload as DecideFrameRequest), apiProvider: provider, cells, promptConfig })
			)
		}
	];

	// SambaNova: start with `json_schema` strict=false so the model has a schema
	// target (more reliable than bare json_object per SambaNova's own guidance)
	// but the server won't hard-reject on minor deviations the way strict=true
	// does. If the response validator still rejects the output (observed: Llama
	// hallucinates Chinese SEO-spam tokens into `c` values), we downgrade to
	// plain json_object on a retry below — better a loose-parsed frame than a
	// 422 that wastes a quota-cycle.
	//
	// OpenRouter: keep strict json_schema; provider-level enforcement varies by
	// model but most of our supported models handle it well.
	const initialResponseFormat =
		provider === 'sambanova'
			? { type: 'json_schema', json_schema: { name: 'nlca_frame_decisions', strict: false, schema } }
			: { type: 'json_schema', json_schema: { name: 'nlca_frame_decisions', strict: true, schema } };

	const body: Record<string, unknown> = {
		model,
		temperature,
		max_tokens: maxOutputTokens,
		messages,
		response_format: initialResponseFormat
	};
	let structuredOutputDowngraded = false;

	const maxAttempts = 3;
	let attempt = 0;
	let currentMaxTokens = maxOutputTokens;
	const t0 = performance.now();
	while (true) {
		attempt++;
		try {
			const res = await upstreamChatOnce(fetch, provider, apiKey, body, timeoutMs);

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
			// Context-length overflow: halve max_tokens and retry.
			if (res.status === 400 && attempt < maxAttempts) {
				const text = await res.clone().text().catch(() => '');
				if (/maximum context length|context_length|context window/i.test(text)) {
					const next = Math.max(2048, Math.floor(currentMaxTokens / 2));
					if (next < currentMaxTokens) {
						console.log(
							`[NLCA decideFrame] context-overflow max_tokens ${currentMaxTokens}→${next} attempt=${attempt}/${maxAttempts}`
						);
						currentMaxTokens = next;
						body.max_tokens = next;
						continue;
					}
				}
				// Rate-limit can come back as 400 on SambaNova with "rate limit"
				// in the body. Fail fast and surface as 429 — retrying burns
				// the remaining daily quota.
				if (/rate limit|rate_limit_exceeded/i.test(text)) {
					console.log(`[NLCA decideFrame] rate-limited (no retry) body=${text.slice(0, 160)}`);
					throw error(429, `Rate limit exceeded on ${provider}. ${text.slice(0, 200)}`);
				}
				// Invalid structured output: the upstream validator rejected the
				// model's text as non-conforming JSON. Temperature=0 means retrying
				// the identical request is pointless — but we CAN change the
				// response_format and retry that. Downgrade strict json_schema to
				// bare json_object for one attempt; if that still fails, give up.
				if (/Invalid structured output|Model did not output valid JSON/i.test(text)) {
					if (provider === 'sambanova' && !structuredOutputDowngraded && attempt < maxAttempts) {
						structuredOutputDowngraded = true;
						body.response_format = { type: 'json_object' };
						console.log(
							`[NLCA decideFrame] downgrading sambanova to json_object and retrying attempt=${attempt}/${maxAttempts}`
						);
						continue;
					}
					console.log(`[NLCA decideFrame] invalid-structured-output (no retry left) body=${text.slice(0, 160)}`);
					throw error(
						422,
						`${provider} model output violated JSON contract (no retry left). Try a different model or disable color mode. ${text.slice(0, 200)}`
					);
				}
			}

			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw error(res.status, text || `${provider} error (${res.status})`);
			}

			const data = (await res.json()) as OpenRouterChatResponse;
			const content = data?.choices?.[0]?.message?.content;
			const latencyMs = performance.now() - t0;

			// Structured outputs often returns parsed JSON; but some providers still return string.
			const parsed = typeof content === 'string' ? JSON.parse(content) : content;
			// SambaNova uses minified keys (d/i/s/c); OpenRouter uses verbose.
			const decisionsRaw =
				provider === 'sambanova'
					? (parsed as { d?: unknown }).d ?? (parsed as { decisions?: unknown }).decisions
					: (parsed as { decisions?: unknown }).decisions;
			if (!Array.isArray(decisionsRaw) || decisionsRaw.length !== cells.length) {
				const rawText = typeof content === 'string' ? content : JSON.stringify(content ?? '');
				const got = Array.isArray(decisionsRaw) ? decisionsRaw.length : 'not-an-array';
				const finish = data?.choices?.[0]?.finish_reason ?? 'unknown';
				// Fire-and-forget failure log so the user can inspect what the model
				// actually returned — the normal success-path logger is skipped on errors.
				if (dev) {
					try {
						const nowMs = Date.now();
						writeNlcaLog({
							runId,
							generation,
							timestamp: new Date(nowMs).toISOString(),
							timestampMs: nowMs,
							model,
							provider,
							mode: 'frame-batched',
							grid: { width, height },
							systemPrompt: messages[0]!.content as string,
							userPayloadSent: JSON.parse(messages[1]!.content as string) as unknown,
							cellBreakdown: [],
							response: {
								rawContent: rawText,
								decisions: [],
								usage: data?.usage
									? {
											promptTokens: data.usage.prompt_tokens ?? 0,
											completionTokens: data.usage.completion_tokens ?? 0
										}
									: null
							},
							latencyMs,
							error: `invalid decisions array: expected=${cells.length} got=${got} finish=${finish}`
						});
					} catch {
						// swallow — logger must not throw
					}
				}
				throw error(
					502,
					`Model returned invalid decisions array (expected=${cells.length} got=${got} finish=${finish}). ` +
						`First 200 chars of response: ${rawText.slice(0, 200)}`
				);
			}

			// Normalise minified rows back to the canonical shape {cellId,state,color?}
			// so the client's parser doesn't need to know which provider ran.
			let decisions = decisionsRaw.map((d) => {
				const rec = d as Record<string, unknown>;
				const cellId = Number(rec.cellId ?? rec.i ?? NaN);
				const state = Number(rec.state ?? rec.s ?? 0) === 1 ? 1 : 0;
				const color = typeof (rec.color ?? rec.c) === 'string' ? (rec.color ?? rec.c) : undefined;
				return wantColor ? { cellId, state, color } : { cellId, state };
			});

			// Validate that every requested cellId appears exactly once.
			const expectedIds = new Set<number>();
			for (const c of cells) {
				const id = Number((c as { cellId?: unknown }).cellId ?? NaN);
				if (!Number.isFinite(id)) throw error(400, 'Invalid cellId in request');
				expectedIds.add(id);
			}
			if (expectedIds.size !== cells.length) throw error(400, 'Duplicate cellId in request');

			// Filter invalid/duplicate model decisions; fall back to current state for missing cells
			// rather than crashing the whole experiment with a 502.
			const seen = new Set<number>();
			const validDecisions = decisions.filter((d) => {
				const { cellId } = d;
				if (!Number.isFinite(cellId) || !expectedIds.has(cellId)) {
					console.warn(`[NLCA decideFrame] Ignoring invalid cellId ${cellId} from model`);
					return false;
				}
				if (seen.has(cellId)) {
					console.warn(`[NLCA decideFrame] Ignoring duplicate cellId ${cellId} from model`);
					return false;
				}
				seen.add(cellId);
				return true;
			});
			for (const expectedId of expectedIds) {
				if (!seen.has(expectedId)) {
					const fb = cells.find((c) => c.cellId === expectedId)!;
					validDecisions.push(
						wantColor
							? { cellId: expectedId, state: fb.self, color: fb.prevColor ?? undefined }
							: { cellId: expectedId, state: fb.self }
					);
					console.warn(`[NLCA decideFrame] Missing cellId ${expectedId} — falling back to state ${fb.self}`);
				}
			}
			decisions = validDecisions;

			// Fire-and-forget disk log (dev only to avoid cluttering production).
			if (dev) {
				const nowMs = Date.now();
				const systemPrompt = messages[0]!.content as string;
				const userPayloadSent = JSON.parse(messages[1]!.content as string) as unknown;
				writeNlcaLog({
					runId,
					generation,
					timestamp: new Date(nowMs).toISOString(),
					timestampMs: nowMs,
					model,
					provider,
					mode: 'frame-batched',
					grid: { width, height },
					systemPrompt,
					userPayloadSent,
					cellBreakdown: buildCellBreakdown(
						cells.map((c) => ({
							cellId: c.cellId,
							x: c.x,
							y: c.y,
							self: c.self,
							neighborhood: c.neighborhood as Array<[number, number, 0 | 1]>,
							history: c.history as Array<0 | 1> | undefined
						})),
						decisions as Array<{ cellId: number; state: 0 | 1; color?: string }>
					),
					response: {
						rawContent: typeof content === 'string' ? content : JSON.stringify(content),
						decisions: decisions as Array<{ cellId: number; state: 0 | 1; color?: string }>,
						usage: data?.usage
							? {
									promptTokens: data.usage.prompt_tokens ?? 0,
									completionTokens: data.usage.completion_tokens ?? 0
								}
							: null
					},
					latencyMs
				});
			}

			return json({
				id: data?.id ?? null,
				model,
				provider,
				usage: data?.usage ?? null,
				latencyMs,
				decisions
			});
		} catch (e) {
			if (isHttpError(e)) {
				// Preserve explicit upstream status classification (e.g. 429 rate limit)
				// and avoid retrying known terminal failures as opaque 502s.
				throw e;
			}
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
