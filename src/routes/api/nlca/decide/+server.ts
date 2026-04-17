import { json, error, type RequestHandler } from '@sveltejs/kit';

type Role = 'system' | 'user' | 'assistant';
type Msg = { role: Role; content: string };

type DecideCell = {
	cellId: number;
	messages: Msg[];
};

type DecideRequest = {
	apiKey: string;
	model: string;
	temperature?: number;
	maxOutputTokens?: number;
	timeoutMs?: number;
	/** Max concurrent upstream OpenRouter calls (within this request). */
	maxConcurrency?: number;
	/** Cells to decide in this batch. */
	cells: DecideCell[];
};

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

async function openRouterChatOnce(fetchFn: typeof fetch, apiKey: string, body: unknown, timeoutMs: number): Promise<Response> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
	try {
		return await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
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

export const POST: RequestHandler = async ({ request, fetch }) => {
	let payload: DecideRequest | null = null;
	try {
		payload = (await request.json()) as DecideRequest;
	} catch {
		// ignore
	}

	const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';
	const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
	const cells = Array.isArray(payload?.cells) ? payload!.cells : [];

	if (!apiKey) throw error(400, 'Missing apiKey');
	if (!model) throw error(400, 'Missing model');
	if (cells.length === 0) throw error(400, 'No cells provided');

	const temperature = typeof payload?.temperature === 'number' && Number.isFinite(payload.temperature) ? payload.temperature : 0;
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
				const res = await openRouterChatOnce(fetch, apiKey, body, timeoutMs);
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

