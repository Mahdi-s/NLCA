import { Agent } from 'undici';

/**
 * Two specialised undici Agents for Cerebras API calls.
 *
 * SvelteKit's default global fetch (also backed by undici) limits concurrent
 * connections per origin. When the decide endpoint fans out hundreds of parallel
 * requests to api.cerebras.ai, those requests queue behind the default connection
 * cap, destroying throughput. These shared agents raise the limit and keep
 * connections alive across requests to eliminate TLS handshake overhead.
 *
 * Why two agents?
 *
 * 1. `cerebrasAgent` — used by non-streaming endpoints (`/decide`, `/decideFrame`).
 *    HTTP pipelining is set to 6 so multiple rapid fire requests can be dispatched
 *    over the same connection without waiting for each response. This is safe
 *    because non-streaming responses are short and arrive atomically.
 *
 * 2. `cerebrasStreamAgent` — used by streaming endpoints (`/decideFrameStream`).
 *    Pipelining is set to 1 because each streaming response must be consumed
 *    serially per connection; interleaving pipelined streams would corrupt the
 *    event-stream framing. Keep-alive timeouts are also longer to accommodate
 *    the inherently long-lived nature of streamed responses.
 */

/** Non-streaming agent: high pipelining for rapid chunk dispatch. */
const cerebrasAgent = new Agent({
	keepAliveTimeout: 30_000,
	keepAliveMaxTimeout: 60_000,
	connections: 200,
	pipelining: 6
});

/** Streaming agent: serial consumption per connection, longer keep-alive. */
const cerebrasStreamAgent = new Agent({
	keepAliveTimeout: 60_000,
	keepAliveMaxTimeout: 120_000,
	connections: 100,
	pipelining: 1
});

export function getCerebrasAgent(): Agent {
	return cerebrasAgent;
}

export function getCerebrasStreamAgent(): Agent {
	return cerebrasStreamAgent;
}
