/**
 * Cost estimation for NLCA experiments.
 *
 * Given an experiment's configuration and live pricing from the provider's
 * models endpoint, produce:
 *   - an up-front `estimateExperimentCost()` projecting the full target-frames
 *     run so the experiment card can show "≈ $0.012" before a single API call,
 *   - a `computeCallCost()` helper the orchestrator uses to accumulate actual
 *     cost from each call's usage.prompt_tokens / completion_tokens.
 *
 * Pricing is cached per `(provider, modelId)` for the page session.
 */

import type { ExperimentConfig, NlcaNeighborhood } from './types.js';

export interface ModelPricing {
	/** USD per input (prompt) token */
	prompt: number;
	/** USD per output (completion) token */
	completion: number;
}

export interface CostEstimate {
	totalFrames: number;
	chunksPerFrame: number;
	totalChunks: number;
	inputTokensPerChunk: number;
	outputTokensPerChunk: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	/** USD */
	cost: number;
	/** True when pricing wasn't available and we've used a zeroed stub. */
	pricingUnknown: boolean;
}

const SYSTEM_PROMPT_TOKENS = 500; // coarse upper bound incl. task description
const OUTPUT_SAFETY_FACTOR = 1.4; // matches the server-side `max_tokens` padding

/**
 * Tokens the server's compressed / verbose payload uses per cell, matched to
 * the estimator already baked into orchestrator.ts so quotes stay consistent
 * with the actual chunking decisions.
 */
function inputTokensPerCell(compressed: boolean, memoryWindow: number, neighborhoodSize: number): number {
	const base = compressed ? 18 : 55;
	const historyPad = memoryWindow * 2;
	const neighborhoodBonus = Math.max(0, neighborhoodSize - 8) * (compressed ? 1 : 3);
	return base + historyPad + neighborhoodBonus;
}

function outputTokensPerCell(wantColor: boolean): number {
	return wantColor ? 18 : 12;
}

function neighborhoodSize(n: NlcaNeighborhood): number {
	if (n === 'vonNeumann') return 4;
	if (n === 'extendedMoore') return 24;
	return 8;
}

/** Conservative per-provider chunk-size assumptions used when we don't have
 * the orchestrator's live estimate to hand. Matches orchestrator's defaults. */
function defaultChunkSize(cfg: ExperimentConfig): number {
	const totalCells = cfg.gridWidth * cfg.gridHeight;
	if (cfg.apiProvider === 'sambanova') {
		const model = (cfg.model || '').toLowerCase();
		// Mirrors SAMBANOVA_MODEL_CHUNK_CAPS in orchestrator.ts
		if (/llama/.test(model)) return Math.min(totalCells, 200);
		if (/qwen/.test(model)) return Math.min(totalCells, 300);
		if (/deepseek/.test(model)) return Math.min(totalCells, 400);
		return Math.min(totalCells, 1000);
	}
	// OpenRouter: the client caps chunk size to fit within the server's 12288
	// output-token ceiling (outputPerCell * 1.4). With colour mode that lands
	// around ~480 cells; without colour, ~900. The client also applies a
	// configurable `batchSize` from settings; honour the smaller.
	const wantColor = cfg.cellColorEnabled;
	const outputCap = Math.floor(12_288 / (outputTokensPerCell(wantColor) * OUTPUT_SAFETY_FACTOR));
	const configured = Math.max(1, cfg.batchSize || totalCells);
	return Math.min(totalCells, outputCap, configured);
}

/**
 * Project total cost for a full `targetFrames` run. Returns a detailed
 * breakdown so the UI can show tokens / calls alongside the dollar value.
 */
export function estimateExperimentCost(
	cfg: ExperimentConfig,
	pricing: ModelPricing | null
): CostEstimate {
	const totalCells = cfg.gridWidth * cfg.gridHeight;
	const chunk = defaultChunkSize(cfg);
	const chunksPerFrame = Math.max(1, Math.ceil(totalCells / chunk));
	const cellsInTypicalChunk = Math.ceil(totalCells / chunksPerFrame);

	const compressed = cfg.apiProvider === 'sambanova' || cfg.compressPayload;
	const nbSize = neighborhoodSize(cfg.neighborhood);
	const perCellInput = inputTokensPerCell(compressed, cfg.memoryWindow || 0, nbSize);
	const perCellOutput = outputTokensPerCell(cfg.cellColorEnabled);

	const inputTokensPerChunk = SYSTEM_PROMPT_TOKENS + perCellInput * cellsInTypicalChunk;
	const outputTokensPerChunk = Math.ceil(perCellOutput * cellsInTypicalChunk * OUTPUT_SAFETY_FACTOR);

	const totalChunks = cfg.targetFrames * chunksPerFrame;
	const totalInputTokens = totalChunks * inputTokensPerChunk;
	const totalOutputTokens = totalChunks * outputTokensPerChunk;

	const pricingUnknown = !pricing || (pricing.prompt <= 0 && pricing.completion <= 0);
	const cost = pricing
		? totalInputTokens * pricing.prompt + totalOutputTokens * pricing.completion
		: 0;

	return {
		totalFrames: cfg.targetFrames,
		chunksPerFrame,
		totalChunks,
		inputTokensPerChunk,
		outputTokensPerChunk,
		totalInputTokens,
		totalOutputTokens,
		cost,
		pricingUnknown
	};
}

/** USD cost for one API call given its actual usage. */
export function computeCallCost(
	promptTokens: number | null | undefined,
	completionTokens: number | null | undefined,
	pricing: ModelPricing | null
): number {
	if (!pricing) return 0;
	const p = Number.isFinite(promptTokens) ? Number(promptTokens) : 0;
	const c = Number.isFinite(completionTokens) ? Number(completionTokens) : 0;
	return p * pricing.prompt + c * pricing.completion;
}

// ---------------------------------------------------------------------------
// Session-scoped pricing cache — we hit /api/nlca-models at most once per
// (provider, apiKey) per page load. Results are keyed on the key too so
// switching keys doesn't serve stale SambaNova models.
// ---------------------------------------------------------------------------

type ProviderKey = 'openrouter' | 'sambanova';

const pricingCache = new Map<string, Promise<Map<string, ModelPricing | null>>>();

function cacheKey(provider: ProviderKey, apiKey: string): string {
	return `${provider}::${apiKey || ''}`;
}

async function fetchModelList(
	provider: ProviderKey,
	apiKey: string
): Promise<Map<string, ModelPricing | null>> {
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const res = await fetch(`/api/nlca-models?provider=${provider}`, { headers });
	if (!res.ok) return new Map();
	const body = (await res.json()) as {
		data?: Array<{ id?: string; pricing?: ModelPricing | null }>;
	};
	const out = new Map<string, ModelPricing | null>();
	for (const row of body.data ?? []) {
		if (typeof row.id === 'string') out.set(row.id, row.pricing ?? null);
	}
	return out;
}

async function fetchPricingFor(
	provider: ProviderKey,
	modelId: string,
	apiKey: string
): Promise<ModelPricing | null> {
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const qs = new URLSearchParams({ provider, priceFor: modelId });
	const res = await fetch(`/api/nlca-models?${qs.toString()}`, { headers });
	if (!res.ok) return null;
	const body = (await res.json()) as {
		data?: Array<{ id?: string; pricing?: ModelPricing | null }>;
	};
	const row = (body.data ?? []).find((r) => r.id === modelId);
	return row?.pricing ?? null;
}

export async function getModelPricing(
	provider: ProviderKey,
	modelId: string,
	apiKey: string
): Promise<ModelPricing | null> {
	const key = cacheKey(provider, apiKey);
	let pending = pricingCache.get(key);
	if (!pending) {
		pending = fetchModelList(provider, apiKey).catch(() => new Map());
		pricingCache.set(key, pending);
	}
	const map = await pending;
	if (map.has(modelId)) return map.get(modelId) ?? null;

	// Fallback — the list didn't include this model (common on SambaNova when
	// no API key is set: the fallback list only covers a handful of canonical
	// Llama IDs, not MiniMax / Qwen / DeepSeek etc.). Ask the endpoint to
	// price-match this specific id against the hardcoded table.
	const pricing = await fetchPricingFor(provider, modelId, apiKey).catch(() => null);
	map.set(modelId, pricing);
	return pricing;
}

/** Force the next call to re-fetch (used after the user edits their key). */
export function invalidatePricingCache(): void {
	pricingCache.clear();
}
