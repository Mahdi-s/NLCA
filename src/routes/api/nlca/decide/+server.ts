import { json, error, type RequestHandler } from '@sveltejs/kit';
import { writeNlcaLog } from '$lib/server/nlcaLogger.js';
import { dev } from '$app/environment';
import { extractApiKey } from '../_shared/extractApiKey.js';

type Role = 'system' | 'user' | 'assistant';
type Msg = { role: Role; content: string };

type DecideCell = {
	cellId: number;
	messages: Msg[];
};

type ApiProvider = 'openrouter' | 'sambanova';

type DecideRequest = {
	apiProvider?: ApiProvider;
	apiKey: string;
	model: string;
	temperature?: number;
	maxOutputTokens?: number;
	timeoutMs?: number;
	/** Max concurrent upstream calls (within this request). */
	maxConcurrency?: number;
	/** Optional experiment/run ID — used for log file organisation only. */
	runId?: string;
	/** Cells to decide in this batch. */
	cells: DecideCell[];
};

const SAMBANOVA_DEFAULT_MODEL = 'Meta-Llama-3.3-70B-Instruct';

function resolveUpstream(provider: ApiProvider): { url: string; referer: string } {
	return provider === 'sambanova'
		? { url: 'https://api.sambanova.ai/v1/chat/completions', referer: 'http://localhost' }
		: { url: 'https://openrouter.ai/api/v1/chat/completions', referer: 'http://localhost' };
}

type OpenRouterChatResponse = {
	id?: string;
	choices?: Array<{
		message?: { content?: string };
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
};

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function asyncPool<T, R>(concurrency: number, items: readonly T[], fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await fn(items[i]!, i);
		}
	});
	await Promise.all(workers);
	return results;
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
	const { url, referer } = resolveUpstream(provider);
	try {
		return await fetchFn(url, {
			method: 'POST',
			signal: ctrl.signal,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': referer,
				'X-Title': 'games-of-life-nlca'
			},
			body: JSON.stringify(body)
		});
	} finally {
		clearTimeout(t);
	}
}

export const POST: RequestHandler = async ({ request, fetch }) => {
	let payload: DecideRequest | null = null;
	try {
		payload = (await request.json()) as DecideRequest;
	} catch {
		// ignore
	}

	const provider: ApiProvider = payload?.apiProvider === 'sambanova' ? 'sambanova' : 'openrouter';
	const apiKey = extractApiKey(request, payload);
	const rawModel = typeof payload?.model === 'string' ? payload.model.trim() : '';
	const model = rawModel || (provider === 'sambanova' ? SAMBANOVA_DEFAULT_MODEL : '');
	const cells = Array.isArray(payload?.cells) ? payload!.cells : [];
	const runId = typeof payload?.runId === 'string' && payload.runId.trim() ? payload.runId.trim() : `anon-${Date.now()}`;

	if (!apiKey) throw error(400, 'Missing apiKey');
	if (!model) throw error(400, 'Missing model');
	if (cells.length === 0) throw error(400, 'No cells provided');

	// SambaNova runs deterministic-only; OpenRouter respects the user-supplied value.
	const temperature =
		provider === 'sambanova'
			? 0
			: typeof payload?.temperature === 'number' && Number.isFinite(payload.temperature)
				? payload.temperature
				: 0;
	const maxOutputTokens =
		typeof payload?.maxOutputTokens === 'number' && Number.isFinite(payload.maxOutputTokens) ? payload.maxOutputTokens : 64;
	const timeoutMs = typeof payload?.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs) ? payload.timeoutMs : 30_000;
	const maxConcurrency =
		typeof payload?.maxConcurrency === 'number' && Number.isFinite(payload.maxConcurrency) ? Math.max(1, payload.maxConcurrency) : 50;

	const results = await asyncPool(maxConcurrency, cells, async (cell) => {
		const t0 = performance.now();
		const cellId = Number(cell?.cellId ?? NaN);
		const messages = Array.isArray(cell?.messages) ? (cell.messages as Msg[]) : [];
		if (!Number.isFinite(cellId) || cellId < 0) {
			return { cellId: -1, ok: false, error: 'Invalid cellId', latencyMs: performance.now() - t0 } as const;
		}
		if (messages.length === 0) {
			return { cellId, ok: false, error: 'Missing messages', latencyMs: performance.now() - t0 } as const;
		}

		const body = {
			model,
			temperature,
			max_tokens: maxOutputTokens,
			messages: messages.map((m) => ({
				role: m.role,
				content: m.content
			}))
		};

		// Conservative retries: respect Retry-After on 429, and retry a couple times on transient 5xx.
		const maxAttempts = 3;
		let attempt = 0;
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

				if (!res.ok) {
					const text = await res.text().catch(() => '');
					return { cellId, ok: false, status: res.status, error: text || `HTTP ${res.status}`, latencyMs: performance.now() - t0 } as const;
				}

				const data = (await res.json()) as OpenRouterChatResponse;
				const content = data?.choices?.[0]?.message?.content;
				return {
					cellId,
					ok: true,
					id: data?.id ?? null,
					content: typeof content === 'string' ? content : '',
					usage: data?.usage ?? null,
					latencyMs: performance.now() - t0
				} as const;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (attempt < maxAttempts) {
					const waitMs = Math.round(200 * 2 ** (attempt - 1) + Math.random() * 100);
					await sleep(waitMs);
					continue;
				}
				return { cellId, ok: false, error: msg, latencyMs: performance.now() - t0 } as const;
			}
		}
	});

	let okCount = 0;
	let errorCount = 0;
	let rateLimitedCount = 0;
	let totalLatencyMs = 0;
	for (const r of results) {
		const latency = typeof (r as { latencyMs?: unknown }).latencyMs === 'number' ? ((r as { latencyMs: number }).latencyMs ?? 0) : 0;
		totalLatencyMs += Number.isFinite(latency) ? latency : 0;
		if ((r as { ok?: unknown }).ok === true) {
			okCount++;
		} else {
			errorCount++;
			if ((r as { status?: unknown }).status === 429) rateLimitedCount++;
		}
	}

	// Fire-and-forget disk log (dev only).
	if (dev) {
		try {
			// In per-cell mode there is no shared frame context — extract what we can
			// from each cell's message history (system = cell context, user = observation).
			// We infer generation from the first user message's JSON payload.
			let generation = 0;
			let width = 0;
			let height = 0;
			const perCellBreakdown: Array<{
				cellId: number;
				systemPrompt: string;
				userMessage: string;
				response: string;
				ok: boolean;
			}> = [];

			for (let i = 0; i < cells.length; i++) {
				const cell = cells[i]!;
				const msgList = Array.isArray(cell.messages) ? cell.messages : [];
				const systemPrompt = msgList.find((m) => m.role === 'system')?.content ?? '';
				const userMsg = msgList.filter((m) => m.role === 'user').pop()?.content ?? '';
				const result = results[i] as { ok?: unknown; content?: unknown; cellId?: unknown };
				const response = result?.ok === true && typeof result.content === 'string' ? result.content : '';

				// Best-effort: parse generation/grid from the last user message JSON
				if (i === 0 && userMsg) {
					try {
						const parsed = JSON.parse(userMsg) as {
							generation?: unknown;
						};
						generation = typeof parsed.generation === 'number' ? parsed.generation : 0;
					} catch {
						// ignore
					}
				}

				perCellBreakdown.push({
					cellId: cell.cellId,
					systemPrompt,
					userMessage: userMsg,
					response,
					ok: result?.ok === true
				});
			}

			const nowMs = Date.now();
			writeNlcaLog({
				runId,
				generation,
				timestamp: new Date(nowMs).toISOString(),
				timestampMs: nowMs,
				model,
				provider,
				mode: 'per-cell',
				grid: { width, height },
				systemPrompt: perCellBreakdown[0]?.systemPrompt ?? '',
				userPayloadSent: perCellBreakdown.map((c) => ({
					cellId: c.cellId,
					userMessage: c.userMessage
				})),
				cellBreakdown: perCellBreakdown.map((c) => {
					// Parse the user message to extract cell state/neighborhood
					let currentState: 0 | 1 = 0;
					let aliveNeighborCount = 0;
					let neighborhood: Array<[number, number, 0 | 1]> = [];
					let history: Array<0 | 1> | undefined;
					try {
						const parsed = JSON.parse(c.userMessage) as {
							state?: unknown;
							neighbors?: unknown;
							neighborhood?: unknown;
							history?: unknown;
						};
						currentState = Number(parsed.state ?? 0) === 1 ? 1 : 0;
						aliveNeighborCount = typeof parsed.neighbors === 'number' ? parsed.neighbors : 0;
						if (Array.isArray(parsed.neighborhood)) {
							neighborhood = (parsed.neighborhood as Array<[number, number, 0 | 1]>);
						}
						if (Array.isArray(parsed.history)) {
							history = parsed.history as Array<0 | 1>;
						}
					} catch { /* ignore */ }

					// Parse decision from response
					let decision: 0 | 1 | null = null;
					let color: string | undefined;
					try {
						const parsed = JSON.parse(c.response) as { state?: unknown; color?: unknown };
						if (parsed.state === 0 || parsed.state === 1) decision = parsed.state as 0 | 1;
						if (typeof parsed.color === 'string') color = parsed.color;
					} catch { /* ignore */ }

					// Extract x/y from system prompt heuristic (Position: (X, Y))
					let x = -1, y = -1;
					const posMatch = c.systemPrompt.match(/Position:\s*\((\d+),\s*(\d+)\)/);
					if (posMatch) { x = Number(posMatch[1]); y = Number(posMatch[2]); }

					return {
						cellId: c.cellId,
						x,
						y,
						currentState,
						aliveNeighborCount,
						neighborhood,
						history,
						decision,
						color
					};
				}),
				response: {
					rawContent: '',
					decisions: perCellBreakdown
						.map((c) => {
							let state: 0 | 1 = 0;
							let color: string | undefined;
							try {
								const p = JSON.parse(c.response) as { state?: unknown; color?: unknown };
								state = Number(p.state) === 1 ? 1 : 0;
								if (typeof p.color === 'string') color = p.color;
							} catch { /* ignore */ }
							return { cellId: c.cellId, state, color };
						})
						.filter((d) => perCellBreakdown.find((c) => c.cellId === d.cellId)?.ok),
					usage: null
				},
				latencyMs: results.length > 0 ? totalLatencyMs / results.length : 0
			});
		} catch (logErr) {
			console.warn('[NLCA LOG] decide logging error:', logErr instanceof Error ? logErr.message : String(logErr));
		}
	}

	return json({
		model,
		results,
		stats: {
			total: results.length,
			ok: okCount,
			errors: errorCount,
			rateLimited: rateLimitedCount,
			avgLatencyMs: results.length > 0 ? totalLatencyMs / results.length : 0
		}
	});
};

