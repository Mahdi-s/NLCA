import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const SAMBANOVA_MODELS_URL = 'https://api.sambanova.ai/v1/models';

/**
 * Hardcoded SambaNova pricing. SambaNova does not expose per-model pricing via
 * its API, so we match model IDs against a lookup of their published rates
 * (USD per token, matching OpenRouter's per-token numeric convention).
 *
 * Ordering matters — first matching substring wins. Tiered guesses at the
 * bottom catch unknown model families so a user's quote is never zero when
 * the live SambaNova list returns something new.
 *
 * Keep this in sync with https://cloud.sambanova.ai/pricing when the vendor
 * updates their sheet.
 */
const SAMBANOVA_PRICING: Array<{ match: RegExp; prompt: number; completion: number }> = [
	// Llama family
	{ match: /llama.*3\.1.*8b/i, prompt: 0.0000001, completion: 0.0000002 },
	{ match: /llama.*3\.2.*1b/i, prompt: 0.00000004, completion: 0.00000008 },
	{ match: /llama.*3\.2.*3b/i, prompt: 0.00000008, completion: 0.00000016 },
	{ match: /llama.*3\.3.*70b/i, prompt: 0.0000006, completion: 0.0000012 },
	{ match: /llama.*70b/i, prompt: 0.0000006, completion: 0.0000012 },
	{ match: /llama.*405b/i, prompt: 0.000005, completion: 0.00001 },
	{ match: /llama.*maverick/i, prompt: 0.00000063, completion: 0.0000018 },
	{ match: /llama.*scout/i, prompt: 0.00000011, completion: 0.00000034 },
	// DeepSeek
	{ match: /deepseek.*v3|deepseek.*r1/i, prompt: 0.0000015, completion: 0.0000045 },
	// Qwen
	{ match: /qwen.*72b|qwen.*2\.5.*72/i, prompt: 0.0000009, completion: 0.0000018 },
	{ match: /qwen.*32b|qwen.*coder/i, prompt: 0.0000004, completion: 0.0000008 },
	// MiniMax
	{ match: /minimax/i, prompt: 0.000001, completion: 0.000002 },
	// Fallbacks by scale signal in the id
	{ match: /(^|[^0-9])405b|(^|[^0-9])400b/i, prompt: 0.000005, completion: 0.00001 },
	{ match: /(^|[^0-9])70b|(^|[^0-9])72b/i, prompt: 0.0000008, completion: 0.0000016 },
	{ match: /(^|[^0-9])30b|(^|[^0-9])32b/i, prompt: 0.0000004, completion: 0.0000008 },
	{ match: /(^|[^0-9])7b|(^|[^0-9])8b/i, prompt: 0.0000001, completion: 0.0000002 },
	{ match: /(^|[^0-9])3b/i, prompt: 0.00000008, completion: 0.00000016 },
	{ match: /(^|[^0-9])1b/i, prompt: 0.00000004, completion: 0.00000008 }
];

function sambanovaPricing(modelId: string): { prompt: number; completion: number } | null {
	for (const row of SAMBANOVA_PRICING) {
		if (row.match.test(modelId)) return { prompt: row.prompt, completion: row.completion };
	}
	return null;
}

/**
 * Safe fallback SambaNova list — used only if the live fetch fails (missing key,
 * network blocked, etc.). Keep this minimal and stick to names SambaNova has
 * stated will remain available; deprecated entries here cause silent
 * "model not available" failures for users.
 */
const SAMBANOVA_FALLBACK = [
	{ id: 'Meta-Llama-3.3-70B-Instruct', name: 'Meta Llama 3.3 70B Instruct' },
	{ id: 'Meta-Llama-3.1-8B-Instruct', name: 'Meta Llama 3.1 8B Instruct' },
	{ id: 'Meta-Llama-3.1-405B-Instruct', name: 'Meta Llama 3.1 405B Instruct' }
];

type ModelRow = {
	id: string;
	name: string;
	pricing?: { prompt: number; completion: number } | null;
	contextLength?: number | null;
};

export const GET: RequestHandler = async ({ request, url }) => {
	const provider = url.searchParams.get('provider') === 'sambanova' ? 'sambanova' : 'openrouter';
	const authHeader = request.headers.get('Authorization') ?? '';
	// Optional: caller names a specific model they need priced. Useful when
	// the live-fetch fallback list is short and the user has older experiments
	// in their CSV referencing models not in that list. We always price-match
	// this id against the hardcoded table and append it to the response.
	const priceFor = url.searchParams.get('priceFor') || url.searchParams.get('model') || '';

	if (provider === 'sambanova') {
		const decorate = (rows: Array<{ id: string; name: string }>): ModelRow[] =>
			rows.map((m) => ({ ...m, pricing: sambanovaPricing(m.id) }));
		const withPriceFor = (rows: ModelRow[]): ModelRow[] => {
			if (!priceFor || rows.some((r) => r.id === priceFor)) return rows;
			return [...rows, { id: priceFor, name: priceFor, pricing: sambanovaPricing(priceFor) }];
		};

		if (!authHeader) {
			return json({ data: withPriceFor(decorate(SAMBANOVA_FALLBACK)), fallback: true });
		}
		try {
			const res = await fetch(SAMBANOVA_MODELS_URL, { headers: { Authorization: authHeader } });
			if (!res.ok) {
				return json({
					data: withPriceFor(decorate(SAMBANOVA_FALLBACK)),
					fallback: true,
					status: res.status
				});
			}
			const body = (await res.json()) as { data?: Array<{ id?: string; object?: string }> };
			const rows =
				(body?.data ?? [])
					.filter((m) => typeof m.id === 'string')
					.map((m) => ({ id: m.id as string, name: m.id as string }));
			if (rows.length === 0) return json({ data: withPriceFor(decorate(SAMBANOVA_FALLBACK)), fallback: true });
			return json({ data: withPriceFor(decorate(rows)) });
		} catch {
			return json({ data: withPriceFor(decorate(SAMBANOVA_FALLBACK)), fallback: true });
		}
	}

	const headers: Record<string, string> = {
		'HTTP-Referer': 'https://github.com/games-of-life',
		'X-Title': 'games-of-life-nlca'
	};
	if (authHeader) headers.Authorization = authHeader;

	const res = await fetch(OPENROUTER_MODELS_URL, { headers });
	if (!res.ok) {
		const txt = await res.text().catch(() => '');
		return json({ error: txt || `OpenRouter ${res.status}` }, { status: res.status });
	}

	// OpenRouter shape: { data: [{id, name, context_length, pricing: {prompt, completion, ...}}] }
	// The prompt/completion values are numeric strings in dollars per token.
	const body = (await res.json()) as {
		data?: Array<{
			id?: string;
			name?: string;
			context_length?: number;
			pricing?: { prompt?: string; completion?: string };
		}>;
	};
	const rows: ModelRow[] = (body?.data ?? [])
		.filter((m) => typeof m.id === 'string')
		.map((m) => {
			const promptStr = m.pricing?.prompt;
			const completionStr = m.pricing?.completion;
			const promptNum = typeof promptStr === 'string' ? Number.parseFloat(promptStr) : NaN;
			const completionNum = typeof completionStr === 'string' ? Number.parseFloat(completionStr) : NaN;
			const pricing =
				Number.isFinite(promptNum) && Number.isFinite(completionNum) && promptNum >= 0 && completionNum >= 0
					? { prompt: promptNum, completion: completionNum }
					: null;
			return {
				id: m.id as string,
				name: (m.name as string | undefined) ?? (m.id as string),
				contextLength: typeof m.context_length === 'number' ? m.context_length : null,
				pricing
			};
		});
	return json({ data: rows });
};
