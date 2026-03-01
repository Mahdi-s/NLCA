import { base } from '$app/paths';
import type { NlcaCellRequest, NlcaOrchestratorConfig, CellColorStatus, CellState01 } from './types.js';
import { buildCellSystemPrompt, buildCellUserPrompt, parseCellResponse, type PromptConfig } from './prompt.js';
import type { CellAgent } from './agentManager.js';

export interface CellDecisionResult {
	state: CellState01;
	confidence?: number;
	colorHex?: string;
	colorStatus?: CellColorStatus;
	latencyMs: number;
	raw: string;
	success: boolean;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
}

export interface DebugLogEntry {
	timestamp: number;
	cellId: number;
	x: number;
	y: number;
	generation: number;
	input: string; // User prompt (for backward compatibility)
	fullPrompt: string; // Full prompt including system message
	output: string;
	latencyMs: number;
	success: boolean;
	cost?: number;
}

export interface NlcaCostStats {
	totalCost: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	callCount: number;
}

type ProxyResult = {
	cellId: number;
	ok: boolean;
	content?: string;
	latencyMs?: number;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
	error?: string;
	status?: number;
};

type FrameDecision = { cellId: number; state: 0 | 1; color?: string };

/**
 * Known model context windows (in tokens).
 * These are approximate and may change. When unknown, we use a conservative default.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	// OpenAI models
	'openai/gpt-4o': 128_000,
	'openai/gpt-4o-mini': 128_000,
	'openai/gpt-4-turbo': 128_000,
	'openai/gpt-4': 8_192,
	'openai/gpt-3.5-turbo': 16_385,
	// Anthropic models
	'anthropic/claude-3-opus': 200_000,
	'anthropic/claude-3-sonnet': 200_000,
	'anthropic/claude-3-haiku': 200_000,
	'anthropic/claude-3.5-sonnet': 200_000,
	// Google models
	'google/gemini-pro': 32_000,
	'google/gemini-pro-1.5': 1_000_000,
	'google/gemini-flash-1.5': 1_000_000,
	// Meta models
	'meta-llama/llama-3-70b-instruct': 8_192,
	'meta-llama/llama-3-8b-instruct': 8_192,
	// Mistral models
	'mistralai/mistral-large': 32_000,
	'mistralai/mixtral-8x7b-instruct': 32_000,
};

const DEFAULT_CONTEXT_WINDOW = 16_000; // Conservative default for unknown models

/**
 * Estimate input tokens per cell.
 * - Compressed format: ~15-20 tokens per cell
 * - Verbose format: ~50-60 tokens per cell
 * - Add ~5 tokens for history per generation in window
 */
function estimateInputTokensPerCell(compressed: boolean, memoryWindow: number, neighborhoodSize: number): number {
	const baseTokens = compressed ? 18 : 55;
	const historyTokens = memoryWindow * 2; // ~2 tokens per history entry
	const neighborhoodBonus = Math.max(0, neighborhoodSize - 8) * (compressed ? 1 : 3); // Extra for extended Moore
	return baseTokens + historyTokens + neighborhoodBonus;
}

/**
 * Estimate output tokens per decision.
 * - Without color: ~8 tokens (e.g., {"cellId":0,"state":1})
 * - With color: ~12 tokens (e.g., {"cellId":0,"state":1,"color":"#FF0000"})
 */
function estimateOutputTokensPerCell(wantColor: boolean): number {
	return wantColor ? 12 : 8;
}

export interface ChunkSizeEstimate {
	maxCellsPerChunk: number;
	estimatedInputTokensPerCell: number;
	estimatedOutputTokensPerCell: number;
	modelContextWindow: number;
	safeOutputBudget: number;
}

/**
 * Calculate optimal chunk size based on model context window and cell parameters.
 */
export function calculateOptimalChunkSize(
	modelId: string,
	compressed: boolean,
	wantColor: boolean,
	memoryWindow: number,
	neighborhoodSize: number = 8
): ChunkSizeEstimate {
	// Get context window for the model
	const modelContextWindow = MODEL_CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_WINDOW;
	
	// Reserve space for system prompt (~200 tokens) and JSON structure (~100 tokens)
	const systemOverhead = 300;
	
	// Safe output budget: 30% of context for output (conservative for structured outputs)
	const safeOutputBudget = Math.floor((modelContextWindow - systemOverhead) * 0.3);
	
	// Estimate tokens per cell
	const inputPerCell = estimateInputTokensPerCell(compressed, memoryWindow, neighborhoodSize);
	const outputPerCell = estimateOutputTokensPerCell(wantColor);
	
	// Calculate max cells that fit in the context window
	// Formula: inputPerCell * N + outputPerCell * N <= contextWindow - systemOverhead
	// So: N <= (contextWindow - systemOverhead) / (inputPerCell + outputPerCell)
	const tokensPerCell = inputPerCell + outputPerCell;
	const maxCellsRaw = Math.floor((modelContextWindow - systemOverhead) / tokensPerCell);
	
	// Also constrain by output budget (structured outputs may have limits)
	const maxCellsByOutput = Math.floor(safeOutputBudget / outputPerCell);
	
	// Use the smaller of the two, with some safety margin (80%)
	const maxCellsPerChunk = Math.max(50, Math.floor(Math.min(maxCellsRaw, maxCellsByOutput) * 0.8));
	
	return {
		maxCellsPerChunk,
		estimatedInputTokensPerCell: inputPerCell,
		estimatedOutputTokensPerCell: outputPerCell,
		modelContextWindow,
		safeOutputBudget
	};
}

/**
 * Hash a cell's decision context for deduplication.
 * The hash includes: self state, neighbor states, and history (if any).
 * Position (x, y) is intentionally excluded since cells with identical
 * context at different positions should behave the same way.
 */
export function hashCellContext(
	self: CellState01,
	neighbors: Array<[number, number, CellState01]>,
	history?: CellState01[]
): string {
	// Sort neighbors by offset to ensure consistent ordering
	const sortedNeighbors = [...neighbors].sort((a, b) => {
		if (a[0] !== b[0]) return a[0] - b[0];
		return a[1] - b[1];
	});
	
	// Build hash string: self + neighbor states + history
	const parts: string[] = [
		String(self),
		sortedNeighbors.map(n => String(n[2])).join('')
	];
	
	if (history && history.length > 0) {
		parts.push(history.join(''));
	}
	
	return parts.join(':');
}

/** Cached decision result for deduplication */
interface CachedDecision {
	state: CellState01;
	colorHex?: string;
	colorStatus?: CellColorStatus;
}

export class NlcaOrchestrator {
	private cfg: NlcaOrchestratorConfig;
	private effectiveConcurrency: number;
	private callCount = 0;
	private costStats: NlcaCostStats = {
		totalCost: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		callCount: 0
	};
	private debugLog: DebugLogEntry[] = [];
	private maxDebugLogSize = 500; // Keep last 500 entries
	private debugEnabled = true;
	
	// Generation-scoped deduplication cache
	private dedupeCache: Map<string, CachedDecision> = new Map();
	private dedupeCacheGeneration: number = -1;
	private dedupeStats = { hits: 0, misses: 0 };

	constructor(cfg: NlcaOrchestratorConfig) {
		this.cfg = cfg;
		this.effectiveConcurrency = Math.max(1, cfg.maxConcurrency);
		console.log(`[NLCA] Orchestrator initialized with model: ${cfg.model.model}`);
	}

	updateConfig(partial: Partial<NlcaOrchestratorConfig>) {
		this.cfg = { ...this.cfg, ...partial };
		if (partial.apiKey || partial.model || partial.cellTimeoutMs) {
			console.log(`[NLCA] Orchestrator config updated, model: ${this.cfg.model.model}`);
		}
		if (typeof partial.maxConcurrency === 'number' && Number.isFinite(partial.maxConcurrency)) {
			this.effectiveConcurrency = Math.max(1, Math.floor(partial.maxConcurrency));
		}
	}

	/**
	 * Calculate optimal chunk size based on current model and configuration.
	 * @param wantColor Whether color output is enabled
	 * @param neighborhoodSize Size of neighborhood (8 for Moore, 4 for vonNeumann, 24 for extendedMoore)
	 * @returns Optimal number of cells per chunk
	 */
	calculateChunkSize(wantColor: boolean, neighborhoodSize: number = 8): number {
		const estimate = calculateOptimalChunkSize(
			this.cfg.model.model,
			this.cfg.compressPayload === true,
			wantColor,
			this.cfg.memoryWindow ?? 0,
			neighborhoodSize
		);
		
		console.log(
			`[NLCA] Chunk size calculation: model=${this.cfg.model.model}, ` +
				`contextWindow=${estimate.modelContextWindow}, ` +
				`inputPerCell=${estimate.estimatedInputTokensPerCell}, ` +
				`outputPerCell=${estimate.estimatedOutputTokensPerCell}, ` +
				`maxCellsPerChunk=${estimate.maxCellsPerChunk}`
		);
		
		return estimate.maxCellsPerChunk;
	}

	/** Get total LLM calls made */
	getCallCount(): number {
		return this.callCount;
	}

	/** Get deduplication statistics */
	getDedupeStats(): { hits: number; misses: number; cacheSize: number } {
		return { ...this.dedupeStats, cacheSize: this.dedupeCache.size };
	}

	/** Reset deduplication cache (call at start of each generation) */
	private resetDedupeCache(generation: number): void {
		if (this.dedupeCacheGeneration !== generation) {
			this.dedupeCache.clear();
			this.dedupeCacheGeneration = generation;
			this.dedupeStats = { hits: 0, misses: 0 };
		}
	}

	/** Look up a cached decision by context hash */
	private getDedupedDecision(hash: string): CachedDecision | undefined {
		if (!this.cfg.deduplicateRequests) return undefined;
		const cached = this.dedupeCache.get(hash);
		if (cached) {
			this.dedupeStats.hits++;
		}
		return cached;
	}

	/** Store a decision in the deduplication cache */
	private cacheDedupedDecision(hash: string, decision: CachedDecision): void {
		if (!this.cfg.deduplicateRequests) return;
		this.dedupeCache.set(hash, decision);
		this.dedupeStats.misses++;
	}

	/** Reset call counter and cost stats */
	resetCallCount(): void {
		this.callCount = 0;
		this.costStats = {
			totalCost: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			callCount: 0
		};
	}

	/** Get accumulated cost statistics */
	getCostStats(): NlcaCostStats {
		return { ...this.costStats };
	}

	/** Get debug log entries */
	getDebugLog(): DebugLogEntry[] {
		return [...this.debugLog];
	}

	/** Clear debug log */
	clearDebugLog(): void {
		this.debugLog = [];
	}

	/** Enable/disable debug logging */
	setDebugEnabled(enabled: boolean): void {
		this.debugEnabled = enabled;
	}

	/** Check if debug logging is enabled */
	isDebugEnabled(): boolean {
		return this.debugEnabled;
	}

	private pushDebug(agent: CellAgent, req: NlcaCellRequest, raw: string, latencyMs: number, success: boolean): void {
		if (!this.debugEnabled) return;

		const userPrompt = buildCellUserPrompt(req);
		const systemPrompt = agent.getHistory().find((m) => m.role === 'system')?.content || '';
		const fullPrompt = systemPrompt ? `[SYSTEM PROMPT]\n${systemPrompt}\n\n[USER PROMPT]\n${userPrompt}` : userPrompt;

		const entry: DebugLogEntry = {
			timestamp: Date.now(),
			cellId: agent.cellId,
			x: agent.x,
			y: agent.y,
			generation: req.generation,
			input: userPrompt,
			fullPrompt,
			output: raw,
			latencyMs,
			success
		};
		this.debugLog.push(entry);
		if (this.debugLog.length > this.maxDebugLogSize) {
			this.debugLog = this.debugLog.slice(-this.maxDebugLogSize);
		}
	}

	private pushFrameDebug(entry: {
		generation: number;
		width: number;
		height: number;
		cellCount: number;
		latencyMs: number;
		usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
		ok: boolean;
		message: string;
	}): void {
		if (!this.debugEnabled) return;
		const usageText =
			entry.usage && (entry.usage.prompt_tokens || entry.usage.completion_tokens)
				? `usage: ${entry.usage.prompt_tokens ?? 0} in / ${entry.usage.completion_tokens ?? 0} out`
				: 'usage: —';

		const fullPrompt = [
			'[FRAME-BATCHED MODE]',
			`grid: ${entry.width}x${entry.height}`,
			`generation: ${entry.generation}`,
			`cells: ${entry.cellCount}`,
			usageText,
			'',
			entry.message
		].join('\n');

		const debug: DebugLogEntry = {
			timestamp: Date.now(),
			cellId: -1,
			x: -1,
			y: -1,
			generation: entry.generation,
			input: `[FRAME] ${entry.width}x${entry.height} gen ${entry.generation} (${entry.cellCount} cells)`,
			fullPrompt,
			output: entry.ok ? 'OK' : 'FAIL',
			latencyMs: entry.latencyMs,
			success: entry.ok
		};
		this.debugLog.push(debug);
		if (this.debugLog.length > this.maxDebugLogSize) {
			this.debugLog = this.debugLog.slice(-this.maxDebugLogSize);
		}
	}

	/**
	 * Execute a batch of cells via the server proxy.
	 * The proxy fans out to OpenRouter with concurrency + retries.
	 */
	async decideCellsBatch(items: Array<{ agent: CellAgent; req: NlcaCellRequest }>, promptConfig?: PromptConfig): Promise<Map<number, CellDecisionResult>> {
		const byCellId = new Map<number, CellDecisionResult>();

		const cells = items.map(({ agent, req }) => {
			this.callCount++;

			if (!agent.hasSystemPrompt()) {
				const systemPrompt = buildCellSystemPrompt(agent.cellId, agent.x, agent.y, req.width, req.height, promptConfig);
				agent.addMessage({ role: 'system', content: systemPrompt });
			}

			const userPrompt = buildCellUserPrompt(req);
			agent.addMessage({ role: 'user', content: userPrompt });

			return { cellId: agent.cellId, messages: agent.getHistory() };
		});

		let proxyResults: ProxyResult[] = [];
		let proxyError: string | null = null;
		const t0 = performance.now();

		try {
			const res = await fetch(`${base}/api/nlca/decide`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					apiKey: this.cfg.apiKey,
					model: this.cfg.model.model,
					temperature: this.cfg.model.temperature,
					maxOutputTokens: this.cfg.model.maxOutputTokens,
					timeoutMs: this.cfg.cellTimeoutMs,
					maxConcurrency: this.effectiveConcurrency,
					cells
				})
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw new Error(text || `NLCA proxy failed (${res.status})`);
			}
			const obj = (await res.json()) as { results?: ProxyResult[]; stats?: { rateLimited?: number; errors?: number } };
			proxyResults = Array.isArray(obj?.results) ? obj.results : [];

			// Adaptive concurrency (AIMD-ish): back off hard on 429s, otherwise ramp slowly up to target.
			const rateLimited = Number(obj?.stats?.rateLimited ?? 0);
			const errors = Number(obj?.stats?.errors ?? 0);
			const target = Math.max(1, Math.floor(this.cfg.maxConcurrency));
			if (Number.isFinite(rateLimited) && rateLimited > 0) {
				this.effectiveConcurrency = Math.max(1, Math.floor(this.effectiveConcurrency * 0.5));
			} else if (Number.isFinite(errors) && errors > 0) {
				this.effectiveConcurrency = Math.max(1, Math.floor(this.effectiveConcurrency * 0.8));
			} else if (this.effectiveConcurrency < target) {
				this.effectiveConcurrency = Math.min(target, this.effectiveConcurrency + 1);
			}
		} catch (e) {
			proxyError = e instanceof Error ? e.message : String(e);
		}

		const byId = new Map<number, ProxyResult>();
		for (const r of proxyResults) byId.set(r.cellId, r);

		for (const { agent, req } of items) {
			const r = byId.get(agent.cellId);
			const latencyMs = typeof r?.latencyMs === 'number' && Number.isFinite(r.latencyMs) ? r.latencyMs : performance.now() - t0;

			let raw = '';
			let success = false;
			let state: CellState01 = req.self;
			let confidence: number | undefined;
			let colorHex: string | undefined;
			let colorStatus: CellColorStatus | undefined;
			let inputTokens: number | undefined;
			let outputTokens: number | undefined;

			if (proxyError) {
				raw = `ERROR: ${proxyError}`;
			} else if (r?.ok) {
				raw = typeof r.content === 'string' ? r.content : '';

				const usage = r.usage;
				if (usage) {
					inputTokens = usage.prompt_tokens;
					outputTokens = usage.completion_tokens;
					this.costStats.totalInputTokens += inputTokens ?? 0;
					this.costStats.totalOutputTokens += outputTokens ?? 0;
					this.costStats.callCount++;
				}

				const parsed = parseCellResponse(raw);
				if (parsed) {
					state = parsed.state;
					confidence = parsed.confidence;
					if (promptConfig?.cellColorHexEnabled) {
						colorHex = parsed.colorHex;
						colorStatus = parsed.colorStatus ?? 'missing';
					}
					success = true;
				} else {
					console.warn(`[NLCA] Cell ${agent.cellId} (${agent.x},${agent.y}): Failed to parse response: ${raw}`);
				}
			} else {
				const errText = r?.error ? String(r.error) : r?.status ? `HTTP ${r.status}` : 'Unknown error';
				raw = typeof r?.content === 'string' && r.content ? r.content : `ERROR: ${errText}`;
			}

			agent.addMessage({ role: 'assistant', content: raw || `{\"state\":${state}}` });
			this.pushDebug(agent, req, raw, latencyMs, success);

			byCellId.set(agent.cellId, {
				state,
				confidence,
				colorHex,
				colorStatus,
				latencyMs,
				raw,
				success,
				inputTokens,
				outputTokens
			});
		}

		return byCellId;
	}

	/** Back-compat: single cell decision, proxied. */
	async decideCell(agent: CellAgent, req: NlcaCellRequest, promptConfig?: PromptConfig): Promise<CellDecisionResult> {
		const map = await this.decideCellsBatch([{ agent, req }], promptConfig);
		return map.get(agent.cellId) ?? { state: req.self, latencyMs: 0, raw: 'ERROR: missing result', success: false };
	}

	/**
	 * Decide an entire frame in (ideally) one upstream OpenRouter call.
	 * The server enforces structured outputs to return decisions for every provided cell.
	 * 
	 * When deduplication is enabled, cells with identical contexts may share decisions
	 * across chunks within the same generation.
	 */
	async decideFrame(
		args: {
			width: number;
			height: number;
			generation: number;
			cells: Array<{
				cellId: number;
				x: number;
				y: number;
				self: CellState01;
				neighbors: Array<[number, number, CellState01]>;
				history?: CellState01[];
			}>;
		},
		promptConfig: PromptConfig
	): Promise<{ results: Map<number, CellDecisionResult>; frameLatencyMs: number; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null }> {
		const wantColor = promptConfig?.cellColorHexEnabled === true;
		const t0 = performance.now();
		
		// Reset deduplication cache if generation changed
		this.resetDedupeCache(args.generation);
		
		// Check for cached decisions (deduplication within generation)
		const out = new Map<number, CellDecisionResult>();
		const cellsToProcess: typeof args.cells = [];
		const cellHashes = new Map<number, string>(); // cellId -> hash
		
		if (this.cfg.deduplicateRequests) {
			for (const cell of args.cells) {
				const hash = hashCellContext(cell.self, cell.neighbors, cell.history);
				cellHashes.set(cell.cellId, hash);
				
				const cached = this.getDedupedDecision(hash);
				if (cached) {
					// Use cached decision
					out.set(cell.cellId, {
						state: cached.state,
						colorHex: cached.colorHex,
						colorStatus: cached.colorStatus,
						latencyMs: 0, // Instant from cache
						raw: '[CACHED]',
						success: true
					});
				} else {
					cellsToProcess.push(cell);
				}
			}
			
			// If all cells were cached, return immediately
			if (cellsToProcess.length === 0) {
				const frameLatencyMs = performance.now() - t0;
				console.log(`[NLCA] Frame fully cached: ${args.cells.length} cells, ${this.dedupeStats.hits} cache hits`);
				return { results: out, frameLatencyMs, usage: null };
			}
			
			// Log cache utilization
			if (out.size > 0) {
				console.log(
					`[NLCA] Deduplication: ${out.size}/${args.cells.length} cells from cache, ` +
						`${cellsToProcess.length} cells to process`
				);
			}
		} else {
			// No deduplication - process all cells
			cellsToProcess.push(...args.cells);
		}
		let res: Response;
		try {
			res = await fetch(`${base}/api/nlca/decideFrame`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					apiKey: this.cfg.apiKey,
					model: this.cfg.model.model,
					temperature: this.cfg.model.temperature,
					timeoutMs: this.cfg.cellTimeoutMs,
					// Frame calls need a much larger output cap than per-cell calls (900 decisions).
					maxOutputTokens: Math.max(8192, this.cfg.model.maxOutputTokens),
					width: args.width,
					height: args.height,
					generation: args.generation,
					cells: cellsToProcess.map((c) => ({
						cellId: c.cellId,
						x: c.x,
						y: c.y,
						self: c.self,
						neighborhood: c.neighbors,
						history: c.history
					})),
					promptConfig: {
						taskDescription: promptConfig.taskDescription,
						useAdvancedMode: promptConfig.useAdvancedMode,
						advancedTemplate: promptConfig.advancedTemplate,
						cellColorHexEnabled: wantColor,
						compressPayload: this.cfg.compressPayload === true
					}
				})
			});
		} catch (e) {
			const latencyMs = performance.now() - t0;
			const msg = e instanceof Error ? e.message : String(e);
			this.pushFrameDebug({
				generation: args.generation,
				width: args.width,
				height: args.height,
				cellCount: args.cells.length,
				latencyMs,
				ok: false,
				message: `Network error: ${msg}`
			});
			throw e;
		}

		if (!res.ok) {
			const latencyMs = performance.now() - t0;
			const text = await res.text().catch(() => '');
			this.pushFrameDebug({
				generation: args.generation,
				width: args.width,
				height: args.height,
				cellCount: args.cells.length,
				latencyMs,
				ok: false,
				message: text || `HTTP ${res.status}`
			});
			throw new Error(text || `NLCA decideFrame failed (${res.status})`);
		}

		const data = (await res.json()) as {
			decisions: FrameDecision[];
			latencyMs: number;
			usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
		};

		const decisions = Array.isArray(data?.decisions) ? data.decisions : [];
		const frameLatencyMs = Number.isFinite(data?.latencyMs) ? Number(data.latencyMs) : performance.now() - t0;

		// Process API results and add to out map (which may already have cached results)
		for (const d of decisions) {
			const cellId = Number((d as { cellId?: unknown }).cellId ?? NaN);
			if (!Number.isFinite(cellId)) continue;
			const state: CellState01 = Number((d as { state?: unknown }).state ?? 0) === 1 ? 1 : 0;
			let colorHex: string | undefined;
			let colorStatus: CellColorStatus | undefined;

			if (wantColor) {
				const rawColor = typeof (d as { color?: unknown }).color === 'string' ? String((d as { color: string }).color) : '';
				const normalized = rawColor ? rawColor.trim().toUpperCase() : '';
				if (/^#[0-9A-F]{6}$/.test(normalized)) {
					colorHex = normalized;
					colorStatus = 'valid';
				} else {
					colorStatus = 'invalid';
				}
			}

			out.set(cellId, {
				state,
				colorHex,
				colorStatus,
				latencyMs: frameLatencyMs,
				raw: JSON.stringify(d),
				success: true
			});
			
			// Cache the decision for deduplication
			if (this.cfg.deduplicateRequests) {
				const hash = cellHashes.get(cellId);
				if (hash) {
					this.cacheDedupedDecision(hash, { state, colorHex, colorStatus });
				}
			}
		}

		// Accounting: count only cells that were actually processed (not cached)
		this.callCount += cellsToProcess.length;
		this.costStats.callCount += cellsToProcess.length;

		const usage = data?.usage ?? null;
		if (usage) {
			this.costStats.totalInputTokens += usage.prompt_tokens ?? 0;
			this.costStats.totalOutputTokens += usage.completion_tokens ?? 0;
		}

		const cachedCount = args.cells.length - cellsToProcess.length;
		this.pushFrameDebug({
			generation: args.generation,
			width: args.width,
			height: args.height,
			cellCount: args.cells.length,
			latencyMs: frameLatencyMs,
			usage,
			ok: true,
			message: `Returned ${out.size}/${args.cells.length} decisions${wantColor ? ' (color mode)' : ''}${cachedCount > 0 ? ` (${cachedCount} cached)` : ''}.`
		});

		return { results: out, frameLatencyMs, usage };
	}
}

