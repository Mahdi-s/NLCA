import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const SAMBANOVA_MODELS_URL = 'https://api.sambanova.ai/v1/models';

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

export const GET: RequestHandler = async ({ request, url }) => {
	const provider = url.searchParams.get('provider') === 'sambanova' ? 'sambanova' : 'openrouter';
	const authHeader = request.headers.get('Authorization') ?? '';

	if (provider === 'sambanova') {
		if (!authHeader) {
			// No key supplied — return fallback so the dropdown is still populated.
			return json({ data: SAMBANOVA_FALLBACK, fallback: true });
		}
		try {
			const res = await fetch(SAMBANOVA_MODELS_URL, {
				headers: { Authorization: authHeader }
			});
			if (!res.ok) {
				return json({ data: SAMBANOVA_FALLBACK, fallback: true, status: res.status });
			}
			const body = (await res.json()) as { data?: Array<{ id?: string; object?: string }> };
			// SambaNova uses the OpenAI shape: { data: [{ id, object: 'model', ... }] }
			const rows =
				(body?.data ?? [])
					.filter((m) => typeof m.id === 'string')
					.map((m) => ({ id: m.id as string, name: m.id as string }));
			if (rows.length === 0) return json({ data: SAMBANOVA_FALLBACK, fallback: true });
			return json({ data: rows });
		} catch {
			return json({ data: SAMBANOVA_FALLBACK, fallback: true });
		}
	}

	const headers: Record<string, string> = {
		'HTTP-Referer': 'https://github.com/games-of-life',
		'X-Title': 'games-of-life-nlca'
	};
	if (authHeader) headers.Authorization = authHeader;

	const res = await fetch(OPENROUTER_MODELS_URL, { headers });
	const data = await res.json();
	return json(data, { status: res.status });
};
