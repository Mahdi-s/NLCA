import { error, type RequestHandler } from '@sveltejs/kit';

type CellState01 = 0 | 1;

type DecideFrameCell = {
	cellId: number;
	x: number;
	y: number;
	self: CellState01;
	neighborhood: Array<[number, number, CellState01]>;
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

type OpenRouterStreamChunk = {
	id?: string;
	choices?: Array<{
		delta?: { content?: string; role?: string };
		finish_reason?: string | null;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

let inflightFrames = 0;

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterSeconds(v: string | null): number | null {
	if (!v) return null;
	const n = Number(v);
	if (Number.isFinite(n) && n > 0) return n;
	return null;
}

async function openRouterChatStreamOnce(fetchFn: typeof fetch, apiKey: string, body: unknown, timeoutMs: number): Promise<Response> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
	try {
		return await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			signal: ctrl.signal,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
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

function buildSystemPrompt(cfg: PromptConfigPayload, width: number, height: number): string {
	const wantColor = cfg.cellColorHexEnabled === true;
	const compressed = cfg.compressPayload === true;

	// Compressed format explanation
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
			wantColor ? 'Color mode is enabled: include a deterministic uppercase hex "#RRGGBB" per cell.' : '',
			'',
			rendered,
			'Return ONLY valid JSON matching the provided schema.',
			'Do not include any explanation.'
		]
			.filter(Boolean)
			.join('\n');
	}

	return [
		'You are computing the next generation of a cellular automaton.',
		'All cells update synchronously: read the provided prev state + neighbors, then output next state for every cell.',
		'Follow the TASK exactly.',
		formatLine,
		wantColor ? 'Color mode is enabled: include a deterministic uppercase hex "#RRGGBB" per cell.' : '',
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
					pattern: '^#[0-9A-F]{6}$'
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

function encodeSse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type ExtractorState = {
	decisionsStarted: boolean;
	scanPos: number;
};

function ensureDecisionsArrayStarted(buf: string, st: ExtractorState): void {
	if (st.decisionsStarted) return;
	const keyIdx = buf.indexOf('"decisions"');
	if (keyIdx < 0) return;
	const arrIdx = buf.indexOf('[', keyIdx);
	if (arrIdx < 0) return;
	st.decisionsStarted = true;
	st.scanPos = arrIdx + 1;
}

function extractDecisionObjects(buf: string, st: ExtractorState): { objects: string[]; newBuf: string; newScanPos: number } {
	ensureDecisionsArrayStarted(buf, st);
	if (!st.decisionsStarted) return { objects: [], newBuf: buf, newScanPos: st.scanPos };

	const objects: string[] = [];
	let i = st.scanPos;

	// Drop leading whitespace and commas.
	while (i < buf.length && (buf[i] === ' ' || buf[i] === '\n' || buf[i] === '\r' || buf[i] === '\t' || buf[i] === ',')) i++;

	while (i < buf.length) {
		if (buf[i] !== '{') break;
		let depth = 0;
		let inString = false;
		let escape = false;
		let j = i;
		for (; j < buf.length; j++) {
			const ch = buf[j]!;
			if (inString) {
				if (escape) {
					escape = false;
				} else if (ch === '\\\\') {
					escape = true;
				} else if (ch === '"') {
					inString = false;
				}
				continue;
			}

			if (ch === '"') {
				inString = true;
				continue;
			}
			if (ch === '{') depth++;
			else if (ch === '}') {
				depth--;
				if (depth === 0) {
					const objText = buf.slice(i, j + 1);
					objects.push(objText);
					i = j + 1;
					// Skip commas/whitespace before next object
					while (i < buf.length && (buf[i] === ' ' || buf[i] === '\n' || buf[i] === '\r' || buf[i] === '\t' || buf[i] === ',')) i++;
					break;
				}
			}
		}
		// Incomplete object
		if (j >= buf.length) break;
	}

	// To keep memory bounded, if we've advanced far, drop consumed prefix.
	const dropBefore = Math.max(0, Math.min(i, buf.length));
	const newBuf = buf.slice(dropBefore);
	const newScanPos = 0;
	return { objects, newBuf, newScanPos };
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

	// Validate that every requested cellId is unique (so we can enforce exact coverage in the stream).
	const expectedIds = new Set<number>();
	for (const c of cells) {
		const id = Number((c as { cellId?: unknown }).cellId ?? NaN);
		if (!Number.isFinite(id) || id < 0) throw error(400, 'Invalid cellId in request');
		expectedIds.add(id);
	}
	if (expectedIds.size !== cells.length) throw error(400, 'Duplicate cellId in request');

	const schema = buildJsonSchema(cells.length, wantColor);
	const messages = [
		{ role: 'system', content: buildSystemPrompt(promptConfig, width, height) },
		{ role: 'user', content: JSON.stringify(buildUserPayload({ ...(payload as DecideFrameRequest), cells, promptConfig })) }
	];

	const body = {
		model,
		temperature,
		max_tokens: maxOutputTokens,
		stream: true,
		// OpenAI-style: include usage at end if supported by provider.
		streamOptions: { includeUsage: true },
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

	const frameId = `${generation}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const total = cells.length;
	const startedAt = performance.now();
	inflightFrames++;
	console.log(
		`[NLCA STREAM] start frame=${frameId} inflight=${inflightFrames} gen=${generation} ` +
			`grid=${width}x${height} cells=${total} model=${model} max_tokens=${maxOutputTokens} wantColor=${wantColor}`
	);

	const maxAttempts = 3;
	let attempt = 0;
	let upstream: Response | null = null;
	while (true) {
		attempt++;
		upstream = await openRouterChatStreamOnce(fetch, apiKey, body, timeoutMs);
		if (upstream.status === 429 && attempt < maxAttempts) {
			const retryAfter = parseRetryAfterSeconds(upstream.headers.get('retry-after'));
			const waitMs = Math.max(250, Math.round(((retryAfter ?? 1) * 1000) + Math.random() * 250));
			console.log(`[NLCA STREAM] 429 frame=${frameId} retryAfterMs=${waitMs} attempt=${attempt}/${maxAttempts}`);
			await sleep(waitMs);
			continue;
		}
		if (upstream.status >= 500 && attempt < maxAttempts) {
			const waitMs = Math.round(200 * 2 ** (attempt - 1) + Math.random() * 100);
			console.log(`[NLCA STREAM] 5xx frame=${frameId} status=${upstream.status} retryMs=${waitMs} attempt=${attempt}/${maxAttempts}`);
			await sleep(waitMs);
			continue;
		}
		break;
	}

	if (!upstream.ok || !upstream.body) {
		const text = await upstream.text().catch(() => '');
		console.log(`[NLCA STREAM] fail frame=${frameId} status=${upstream.status} body=${text.slice(0, 200)}`);
		throw error(upstream.status, text || `OpenRouter error (${upstream.status})`);
	}

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	let completed = 0;
	let lastLogAt = performance.now();
	const logEvery = 100;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(encodeSse('start', { frameId, generation, width, height, total })));
		},
		async pull(controller) {
			// We run the full upstream consumption in pull, then close.
			const reader = upstream!.body!.getReader();
			let carry = '';
			let jsonBuf = '';
			let st: ExtractorState = { decisionsStarted: false, scanPos: 0 };
			let usage: OpenRouterStreamChunk['usage'] | null = null;
			const seenIds = new Set<number>();

			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) {
						// Flush decoder for any remaining bytes
						if (value && value.length > 0) {
							carry += decoder.decode(value, { stream: false });
						} else {
							// Final flush of decoder buffer
							try {
								carry += decoder.decode(new Uint8Array(0), { stream: false });
							} catch {
								// Ignore decode errors on final flush
							}
						}
						
						// Process any remaining data in carry (even if incomplete SSE block)
						if (carry.length > 0) {
							// Try to process complete SSE blocks first
							while (true) {
								const sep = carry.indexOf('\n\n');
								if (sep < 0) break;
								const block = carry.slice(0, sep);
								carry = carry.slice(sep + 2);

								const lines = block.split('\n');
								for (const ln of lines) {
									const line = ln.trimEnd();
									if (!line.startsWith('data:')) continue;
									const data = line.slice(5).trimStart();
									if (!data) continue;
									if (data === '[DONE]') continue;
									let chunk: OpenRouterStreamChunk | null = null;
									try {
										chunk = JSON.parse(data) as OpenRouterStreamChunk;
									} catch {
										continue;
									}

									if (chunk.usage) usage = chunk.usage;

									const delta = chunk.choices?.[0]?.delta?.content;
									if (typeof delta === 'string' && delta.length > 0) {
										jsonBuf += delta;
									}
								}
							}
							
							// Process any remaining incomplete SSE lines
							const lines = carry.split('\n');
							for (const ln of lines) {
								const line = ln.trimEnd();
								if (!line.startsWith('data:')) continue;
								const data = line.slice(5).trimStart();
								if (!data) continue;
								if (data === '[DONE]') continue;
								let chunk: OpenRouterStreamChunk | null = null;
								try {
									chunk = JSON.parse(data) as OpenRouterStreamChunk;
								} catch {
									continue;
								}

								if (chunk.usage) usage = chunk.usage;

								const delta = chunk.choices?.[0]?.delta?.content;
								if (typeof delta === 'string' && delta.length > 0) {
									jsonBuf += delta;
								}
							}
						}
						
						// Final extraction pass on jsonBuf to get any remaining complete objects
						const extracted = extractDecisionObjects(jsonBuf, st);
						jsonBuf = extracted.newBuf;
						st.scanPos = extracted.newScanPos;

						for (const objText of extracted.objects) {
							let obj: unknown;
							try {
								obj = JSON.parse(objText);
							} catch {
								continue;
							}

							const o = obj as { cellId?: unknown; state?: unknown; color?: unknown };
							const cellId = Number(o.cellId);
							const stateNum = Number(o.state);
							if (!Number.isFinite(cellId) || cellId < 0) continue;
							if (stateNum !== 0 && stateNum !== 1) continue;
							if (!expectedIds.has(cellId)) throw new Error(`Invalid cellId in output: ${cellId}`);
							if (seenIds.has(cellId)) throw new Error(`Duplicate cellId in output: ${cellId}`);
							seenIds.add(cellId);

							let color: string | undefined;
							if (wantColor && typeof o.color === 'string') {
								const c = o.color.trim().toUpperCase();
								if (/^#[0-9A-F]{6}$/.test(c)) color = c;
							}

							completed++;
							controller.enqueue(encoder.encode(encodeSse('decision', { cellId, state: stateNum, color })));

							if (completed % logEvery === 0 || completed === total) {
								controller.enqueue(encoder.encode(encodeSse('progress', { completed, total })));
								const now = performance.now();
								const dt = now - lastLogAt;
								if (dt >= 1000) {
									const elapsed = now - startedAt;
									const rate = completed / Math.max(1, elapsed / 1000);
									console.log(
										`[NLCA STREAM] progress frame=${frameId} ${completed}/${total} ` +
											`elapsedMs=${elapsed.toFixed(0)} rate=${rate.toFixed(0)} decisions/s`
									);
									lastLogAt = now;
								}
							}
						}
						break;
					}
					if (!value) continue;

					carry += decoder.decode(value, { stream: true });

					// Process complete SSE event blocks separated by blank line.
					while (true) {
						const sep = carry.indexOf('\n\n');
						if (sep < 0) break;
						const block = carry.slice(0, sep);
						carry = carry.slice(sep + 2);

						const lines = block.split('\n');
						for (const ln of lines) {
							const line = ln.trimEnd();
							if (!line.startsWith('data:')) continue;
							const data = line.slice(5).trimStart();
							if (!data) continue;
							if (data === '[DONE]') {
								// We'll close after loop.
								continue;
							}
							let chunk: OpenRouterStreamChunk | null = null;
							try {
								chunk = JSON.parse(data) as OpenRouterStreamChunk;
							} catch {
								continue;
							}

							if (chunk.usage) usage = chunk.usage;

							const delta = chunk.choices?.[0]?.delta?.content;
							if (typeof delta === 'string' && delta.length > 0) {
								jsonBuf += delta;

								const extracted = extractDecisionObjects(jsonBuf, st);
								jsonBuf = extracted.newBuf;
								st.scanPos = extracted.newScanPos;

								for (const objText of extracted.objects) {
									let obj: unknown;
									try {
										obj = JSON.parse(objText);
									} catch {
										continue;
									}

									const o = obj as { cellId?: unknown; state?: unknown; color?: unknown };
									const cellId = Number(o.cellId);
									const stateNum = Number(o.state);
									if (!Number.isFinite(cellId) || cellId < 0) continue;
									if (stateNum !== 0 && stateNum !== 1) continue;
									if (!expectedIds.has(cellId)) throw new Error(`Invalid cellId in output: ${cellId}`);
									if (seenIds.has(cellId)) throw new Error(`Duplicate cellId in output: ${cellId}`);
									seenIds.add(cellId);

									let color: string | undefined;
									if (wantColor && typeof o.color === 'string') {
										const c = o.color.trim().toUpperCase();
										if (/^#[0-9A-F]{6}$/.test(c)) color = c;
									}

									completed++;
									controller.enqueue(encoder.encode(encodeSse('decision', { cellId, state: stateNum, color })));

									if (completed % logEvery === 0 || completed === total) {
										controller.enqueue(encoder.encode(encodeSse('progress', { completed, total })));
										const now = performance.now();
										const dt = now - lastLogAt;
										if (dt >= 1000) {
											const elapsed = now - startedAt;
											const rate = completed / Math.max(1, elapsed / 1000);
											console.log(
												`[NLCA STREAM] progress frame=${frameId} ${completed}/${total} ` +
													`elapsedMs=${elapsed.toFixed(0)} rate=${rate.toFixed(0)} decisions/s`
											);
											lastLogAt = now;
										}
									}
								}
							}
						}
					}
				}

				const latencyMs = performance.now() - startedAt;
				if (completed !== total) {
					// Log diagnostic info before failing
					console.log(
						`[NLCA STREAM] incomplete frame=${frameId} completed=${completed}/${total} ` +
							`jsonBufChars=${jsonBuf.length} jsonBufPreview=${jsonBuf.slice(0, 200)} ` +
							`usage=${usage ? `${usage.completion_tokens ?? 0}/${maxOutputTokens}` : '—'}`
					);
					// Hard fail: incomplete streamed frames must not silently succeed.
					// This commonly indicates provider streaming/structured-output incompatibility at larger sizes,
					// or the model hit max_tokens before completing all decisions.
					throw new Error(
						`Incomplete streamed frame: ${completed}/${total} decisions. ` +
							`model=${model} max_tokens=${maxOutputTokens} wantColor=${wantColor} ` +
							`jsonBufChars=${jsonBuf.length} ` +
							`usage=${usage ? `${usage.completion_tokens ?? 0} tokens` : 'unknown'}`
					);
				}
				controller.enqueue(encoder.encode(encodeSse('done', { frameId, completed, total, latencyMs, usage })));
				console.log(
					`[NLCA STREAM] done frame=${frameId} ${completed}/${total} ` +
						`latencyMs=${latencyMs.toFixed(0)} usage=${usage ? `${usage.prompt_tokens ?? 0}/${usage.completion_tokens ?? 0}` : '—'}`
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const latencyMs = performance.now() - startedAt;
				controller.enqueue(encoder.encode(encodeSse('error', { frameId, message: msg, latencyMs })));
				console.log(`[NLCA STREAM] error frame=${frameId} latencyMs=${latencyMs.toFixed(0)} msg=${msg}`);
			} finally {
				inflightFrames = Math.max(0, inflightFrames - 1);
				console.log(`[NLCA STREAM] end frame=${frameId} inflight=${inflightFrames}`);
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive'
		}
	});
};
