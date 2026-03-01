import { Agent } from 'undici';

/**
 * A persistent undici Agent for all Cerebras API calls.
 *
 * SvelteKit's default global fetch (also backed by undici) limits concurrent
 * connections per origin. When the decide endpoint fans out hundreds of parallel
 * requests to api.cerebras.ai, those requests queue behind the default connection
 * cap, destroying throughput. This shared agent raises the limit and keeps
 * connections alive across requests to eliminate TLS handshake overhead.
 */
const cerebrasAgent = new Agent({
	keepAliveTimeout: 30_000,
	keepAliveMaxTimeout: 60_000,
	connections: 500,
	pipelining: 1
});

export function getCerebrasAgent(): Agent {
	return cerebrasAgent;
}
