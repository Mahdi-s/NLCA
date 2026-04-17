import type { AgentMessage, NlcaModelConfig } from './types.js';

/**
 * Represents a single cell's agent with conversation history.
 * Each cell maintains its own memory of past decisions across generations.
 */
export class CellAgent {
	readonly cellId: number;
	readonly x: number;
	readonly y: number;
	private history: AgentMessage[] = [];
	private readonly maxHistoryLength: number;

	constructor(cellId: number, x: number, y: number, maxHistoryLength = 20) {
		this.cellId = cellId;
		this.x = x;
		this.y = y;
		this.maxHistoryLength = maxHistoryLength;
	}

	/** Get the conversation history for this agent */
	getHistory(): AgentMessage[] {
		return [...this.history];
	}

	/** Add a message to the agent's history */
	addMessage(message: AgentMessage): void {
		this.history.push(message);
		// Trim history to keep it bounded (keep system prompt + recent exchanges)
		if (this.history.length > this.maxHistoryLength) {
			// Keep first message (system) and last N-1 messages
			const systemMsg = this.history[0];
			const recentMsgs = this.history.slice(-(this.maxHistoryLength - 1));
			if (systemMsg?.role === 'system') {
				this.history = [systemMsg, ...recentMsgs];
			} else {
				this.history = recentMsgs;
			}
		}
	}

	/** Clear all history for this agent */
	clearHistory(): void {
		this.history = [];
	}

	/** Check if agent has been initialized with a system prompt */
	hasSystemPrompt(): boolean {
		return this.history.length > 0 && this.history[0]?.role === 'system';
	}
}

/**
 * Manages a pool of cell agents for the NLCA grid.
 * Each cell gets its own agent with persistent memory.
 */
export class CellAgentManager {
	private agents: Map<number, CellAgent> = new Map();
	private width: number;
	private height: number;
	private maxHistoryLength: number;

	constructor(width: number, height: number, maxHistoryLength = 20) {
		this.width = width;
		this.height = height;
		this.maxHistoryLength = maxHistoryLength;
		console.log(`[NLCA] CellAgentManager initialized: ${width}x${height} grid (${width * height} agents)`);
	}

	/** Get or create an agent for a specific cell */
	getAgent(cellId: number): CellAgent {
		let agent = this.agents.get(cellId);
		if (!agent) {
			const x = cellId % this.width;
			const y = Math.floor(cellId / this.width);
			agent = new CellAgent(cellId, x, y, this.maxHistoryLength);
			this.agents.set(cellId, agent);
		}
		return agent;
	}

	/** Get all agents */
	getAllAgents(): CellAgent[] {
		return Array.from(this.agents.values());
	}

	/** Clear history for all agents */
	clearAllHistory(): void {
		for (const agent of this.agents.values()) {
			agent.clearHistory();
		}
		console.log(`[NLCA] Cleared history for ${this.agents.size} agents`);
	}

	/** Reset the manager with new dimensions */
	reset(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.agents.clear();
		console.log(`[NLCA] CellAgentManager reset: ${width}x${height} grid`);
	}

	/** Get grid dimensions */
	getDimensions(): { width: number; height: number } {
		return { width: this.width, height: this.height };
	}

	/** Get total number of active agents */
	getAgentCount(): number {
		return this.agents.size;
	}

	/** Update max history length for all agents */
	setMaxHistoryLength(length: number): void {
		this.maxHistoryLength = length;
		// Note: existing agents keep their current length setting
		// New agents will use the updated setting
	}
}

