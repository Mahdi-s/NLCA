/**
 * Extract the provider API key from a request. Prefers `Authorization: Bearer <key>`
 * over the legacy body-field path so (a) APMs and middlewares that log request
 * bodies don't capture secrets, and (b) the header transport is what hosted
 * deployments can safely strip at the edge.
 *
 * The body-field fallback stays for one transitional release cycle — any call
 * that lands in it gets a deprecation warning so we can retire it cleanly.
 */
export function extractApiKey(
	request: Request,
	payload: { apiKey?: unknown } | null
): string {
	const auth = request.headers.get('authorization') ?? '';
	const bearer = auth.match(/^Bearer\s+(.+)$/i);
	if (bearer && bearer[1]) return bearer[1].trim();
	if (payload && typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
		console.warn(
			'[nlca] Deprecated: API key supplied in request body. Use `Authorization: Bearer <key>` header instead.'
		);
		return payload.apiKey.trim();
	}
	return '';
}
