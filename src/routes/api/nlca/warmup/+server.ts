import { json, type RequestHandler } from '@sveltejs/kit';
import { getCerebrasAgent } from '../_cerebrasAgent.js';

/**
 * Lightweight warm-up endpoint. Fires a minimal request to the Cerebras API
 * to establish TLS sessions and populate the undici connection pool, so that
 * subsequent inference calls avoid the cold-start handshake penalty.
 */
export const POST: RequestHandler = async ({ request, fetch }) => {
	let ok = false;
	try {
		const body = (await request.json()) as { apiKey?: string };
		const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : '';
		if (!apiKey) return json({ ok: false });

		// Fire a lightweight models-list request — the response content doesn't
		// matter, we just want to warm the TLS session and keep-alive pool.
		await fetch('https://api.cerebras.ai/v1/models', {
			method: 'GET',
			headers: { Authorization: `Bearer ${apiKey}` },
			// @ts-expect-error undici dispatcher option
			dispatcher: getCerebrasAgent()
		});
		ok = true;
	} catch {
		// Warm-up failures are non-fatal — the real requests will handle errors.
	}

	return json({ ok });
};
