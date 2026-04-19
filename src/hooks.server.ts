import type { Handle } from '@sveltejs/kit';

/**
 * Inject Cross-Origin Isolation headers on every response so that
 * SharedArrayBuffer and Atomics are available in the browser.
 * These are required by @sqlite.org/sqlite-wasm to use the OPFS
 * persistence layer in production, and eliminate the OPFS warning in dev.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
	return response;
};
