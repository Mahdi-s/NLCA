# NLCA Experiment Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the NLCA page from a single-run interface into a multi-experiment hub where users can launch, monitor, pause/resume, and switch between parallel experiments, each with its own SQLite DB and full config snapshot.

**Architecture:** An `ExperimentManager` Svelte 5 reactive service owns N independent `Experiment` instances, each containing its own `NlcaStepper`, `NlcaFrameBuffer`, and `NlcaTape` (per-experiment SQLite DB). The UI adds a tab bar for switching experiments and replaces the flat settings modal with a grouped "New Experiment" creation modal. A master index DB tracks all experiment files.

**Tech Stack:** SvelteKit, Svelte 5 runes, SQLite3 (OPFS), TypeScript

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/nlca/types.ts` | Modify | Add `ExperimentConfig`, `ExperimentStatus`, `ExperimentMeta` types |
| `src/lib/nlca/tape.ts` | Modify | Accept custom DB path, add `config_json` column, add `ExperimentIndex` class |
| `src/lib/nlca/experimentManager.svelte.ts` | Create | Reactive manager owning N experiments with lifecycle methods |
| `src/lib/components/NlcaExperimentTabs.svelte` | Create | Tab bar with status indicators and "+ New" button |
| `src/lib/components/NlcaNewExperimentModal.svelte` | Create | Grouped config modal replacing flat settings modal |
| `src/lib/components/MainAppNlca.svelte` | Modify | Wire ExperimentManager, tab bar, new modal |
| `src/lib/components/Canvas.svelte` | Modify | Accept experiment binding instead of singleton stepper |
| `src/lib/components/ControlsNlca.svelte` | Modify | Bind to active experiment's state |
| `src/lib/components/NlcaTimeline.svelte` | Modify | Bind to active experiment's tape/buffer |
| `src/lib/stores/nlcaSettings.svelte.ts` | Modify | Keep for global defaults (API key); per-experiment config via ExperimentConfig |

---

### Task 1: Add Experiment Types to `types.ts`

**Files:**
- Modify: `src/lib/nlca/types.ts`

- [ ] **Step 1: Add ExperimentConfig and related types**

Append to `src/lib/nlca/types.ts`:

```typescript
/** Complete configuration snapshot for a single experiment */
export interface ExperimentConfig {
	// Model & Provider
	apiKey: string;
	model: string;
	temperature: number;
	maxOutputTokens: number;

	// Simulation Parameters
	gridWidth: number;
	gridHeight: number;
	neighborhood: NlcaNeighborhood;
	cellColorEnabled: boolean;

	// Prompt & Task
	taskDescription: string;
	promptPresetId?: string;
	useAdvancedMode: boolean;
	advancedTemplate?: string;

	// LLM / Technical Parameters
	memoryWindow: number;
	maxConcurrency: number;
	batchSize: number;
	frameBatched: boolean;
	frameStreamed: boolean;
	cellTimeoutMs: number;
	compressPayload: boolean;
	deduplicateRequests: boolean;

	// Run Configuration
	targetFrames: number;
}

export type ExperimentStatus = 'running' | 'paused' | 'completed' | 'error';

/** Lightweight metadata stored in the master index DB */
export interface ExperimentMeta {
	id: string;
	label: string;
	dbFilename: string;
	config: ExperimentConfig;
	status: ExperimentStatus;
	createdAt: number;
	updatedAt: number;
	frameCount: number;
	errorMessage?: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to new types (existing errors may exist).

- [ ] **Step 3: Commit**

```bash
git add src/lib/nlca/types.ts
git commit -m "feat(nlca): add ExperimentConfig, ExperimentStatus, ExperimentMeta types"
```

---

### Task 2: Modify `NlcaTape` to accept custom DB path + add `ExperimentIndex`

**Files:**
- Modify: `src/lib/nlca/tape.ts`

- [ ] **Step 1: Add custom DB path to NlcaTape constructor**

Modify the `NlcaTape` class to accept an optional DB path:

```typescript
export class NlcaTape {
	private db: any | null = null;
	private ready = false;
	private dbPath: string;

	constructor(dbPath: string = '/nlca.sqlite3') {
		this.dbPath = dbPath;
	}

	async init(): Promise<void> {
		if (this.ready) return;

		await ensureSqlite();
		if (!getSqlite3 || !isCrossOriginIsolated) {
			throw new Error('SQLite module not available');
		}

		const sqlite3 = await getSqlite3();
		try {
			if (isCrossOriginIsolated() && 'opfs' in sqlite3 && sqlite3.oo1?.OpfsDb) {
				this.db = new sqlite3.oo1.OpfsDb(this.dbPath);
			} else {
				this.db = new sqlite3.oo1.DB(this.dbPath, 'ct');
			}
		} catch {
			this.db = new sqlite3.oo1.DB(this.dbPath, 'ct');
		}

		this.migrate();
		this.ready = true;
	}
	// ... rest unchanged
}
```

- [ ] **Step 2: Add `config_json` column to migration**

In the `migrate()` method, add the column to `nlca_runs`:

```typescript
private migrate(): void {
	if (!this.db) return;

	this.db.exec(
		[
			`CREATE TABLE IF NOT EXISTS nlca_runs (`,
			`  run_id TEXT PRIMARY KEY,`,
			`  created_at INTEGER NOT NULL,`,
			`  width INTEGER NOT NULL,`,
			`  height INTEGER NOT NULL,`,
			`  neighborhood TEXT NOT NULL,`,
			`  model TEXT NOT NULL,`,
			`  max_concurrency INTEGER NOT NULL,`,
			`  seed TEXT,`,
			`  notes TEXT,`,
			`  config_json TEXT`,
			`);`,
			`CREATE TABLE IF NOT EXISTS nlca_frames (`,
			`  run_id TEXT NOT NULL,`,
			`  generation INTEGER NOT NULL,`,
			`  created_at INTEGER NOT NULL,`,
			`  state_bits BLOB NOT NULL,`,
			`  metrics BLOB,`,
			`  PRIMARY KEY (run_id, generation)`,
			`);`,
			`CREATE INDEX IF NOT EXISTS idx_nlca_frames_run_gen ON nlca_frames(run_id, generation);`
		].join('\n')
	);

	// Add config_json column if upgrading from older schema
	try {
		this.db.exec(`ALTER TABLE nlca_runs ADD COLUMN config_json TEXT`);
	} catch {
		// Column already exists — ignore
	}
}
```

- [ ] **Step 3: Update `startRun` to accept and store config_json**

```typescript
async startRun(cfg: Omit<NlcaRunConfig, 'createdAt'> & { createdAt?: number; configJson?: string }): Promise<string> {
	await this.init();
	const runId = cfg.runId;
	const createdAt = cfg.createdAt ?? Date.now();
	console.log(`[NLCA] Starting run ${runId}: ${cfg.width}x${cfg.height}, model: ${cfg.model}, concurrency: ${cfg.maxConcurrency}`);
	this.db.exec({
		sql: `INSERT OR REPLACE INTO nlca_runs(run_id, created_at, width, height, neighborhood, model, max_concurrency, seed, notes, config_json)
		      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		bind: [
			runId,
			createdAt,
			cfg.width,
			cfg.height,
			cfg.neighborhood,
			cfg.model,
			cfg.maxConcurrency,
			cfg.seed ?? null,
			cfg.notes ?? null,
			cfg.configJson ?? null
		]
	});
	return runId;
}
```

- [ ] **Step 4: Create `ExperimentIndex` class in the same file**

Append to `src/lib/nlca/tape.ts`:

```typescript
import type { ExperimentMeta, ExperimentConfig } from './types.js';

/**
 * Master index DB that tracks all experiment SQLite files.
 * Lives at /nlca-index.sqlite3
 */
export class ExperimentIndex {
	private db: any | null = null;
	private ready = false;

	async init(): Promise<void> {
		if (this.ready) return;

		await ensureSqlite();
		if (!getSqlite3 || !isCrossOriginIsolated) {
			throw new Error('SQLite module not available');
		}

		const sqlite3 = await getSqlite3();
		try {
			if (isCrossOriginIsolated() && 'opfs' in sqlite3 && sqlite3.oo1?.OpfsDb) {
				this.db = new sqlite3.oo1.OpfsDb('/nlca-index.sqlite3');
			} else {
				this.db = new sqlite3.oo1.DB('/nlca-index.sqlite3', 'ct');
			}
		} catch {
			this.db = new sqlite3.oo1.DB('/nlca-index.sqlite3', 'ct');
		}

		this.db.exec(`CREATE TABLE IF NOT EXISTS experiments (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			db_filename TEXT NOT NULL,
			config_json TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'paused',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			frame_count INTEGER NOT NULL DEFAULT 0,
			error_message TEXT
		)`);

		this.ready = true;
	}

	async register(meta: ExperimentMeta): Promise<void> {
		await this.init();
		this.db.exec({
			sql: `INSERT OR REPLACE INTO experiments(id, label, db_filename, config_json, status, created_at, updated_at, frame_count, error_message)
			      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			bind: [
				meta.id,
				meta.label,
				meta.dbFilename,
				JSON.stringify(meta.config),
				meta.status,
				meta.createdAt,
				meta.updatedAt,
				meta.frameCount,
				meta.errorMessage ?? null
			]
		});
	}

	async updateStatus(id: string, status: ExperimentMeta['status'], frameCount?: number, errorMessage?: string): Promise<void> {
		await this.init();
		const now = Date.now();
		if (frameCount !== undefined) {
			this.db.exec({
				sql: `UPDATE experiments SET status = ?, updated_at = ?, frame_count = ?, error_message = ? WHERE id = ?`,
				bind: [status, now, frameCount, errorMessage ?? null, id]
			});
		} else {
			this.db.exec({
				sql: `UPDATE experiments SET status = ?, updated_at = ?, error_message = ? WHERE id = ?`,
				bind: [status, now, errorMessage ?? null, id]
			});
		}
	}

	async list(): Promise<ExperimentMeta[]> {
		await this.init();
		const experiments: ExperimentMeta[] = [];
		const stmt = this.db.prepare(
			`SELECT id, label, db_filename, config_json, status, created_at, updated_at, frame_count, error_message
			 FROM experiments ORDER BY created_at DESC`
		);
		try {
			while (stmt.step()) {
				const row = stmt.get([]) as any[];
				experiments.push({
					id: String(row[0]),
					label: String(row[1]),
					dbFilename: String(row[2]),
					config: JSON.parse(String(row[3])),
					status: row[4] as ExperimentMeta['status'],
					createdAt: Number(row[5]),
					updatedAt: Number(row[6]),
					frameCount: Number(row[7]),
					errorMessage: row[8] ? String(row[8]) : undefined
				});
			}
		} finally {
			stmt.finalize();
		}
		return experiments;
	}

	async delete(id: string): Promise<void> {
		await this.init();
		this.db.exec({ sql: `DELETE FROM experiments WHERE id = ?`, bind: [id] });
	}

	async get(id: string): Promise<ExperimentMeta | null> {
		await this.init();
		const stmt = this.db.prepare(
			`SELECT id, label, db_filename, config_json, status, created_at, updated_at, frame_count, error_message
			 FROM experiments WHERE id = ?`
		);
		try {
			stmt.bind([id]);
			if (!stmt.step()) return null;
			const row = stmt.get([]) as any[];
			return {
				id: String(row[0]),
				label: String(row[1]),
				dbFilename: String(row[2]),
				config: JSON.parse(String(row[3])),
				status: row[4] as ExperimentMeta['status'],
				createdAt: Number(row[5]),
				updatedAt: Number(row[6]),
				frameCount: Number(row[7]),
				errorMessage: row[8] ? String(row[8]) : undefined
			};
		} finally {
			stmt.finalize();
		}
	}
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`

- [ ] **Step 6: Commit**

```bash
git add src/lib/nlca/tape.ts
git commit -m "feat(nlca): parameterize NlcaTape DB path, add ExperimentIndex for master registry"
```

---

### Task 3: Create `ExperimentManager` service

**Files:**
- Create: `src/lib/nlca/experimentManager.svelte.ts`

- [ ] **Step 1: Create the ExperimentManager**

```typescript
/**
 * ExperimentManager — owns N independent NLCA experiments.
 * Each experiment has its own NlcaStepper, NlcaTape, NlcaFrameBuffer, and CellAgentManager.
 * Svelte 5 reactive state via $state runes.
 */

import { NlcaTape, ExperimentIndex } from './tape.js';
import { NlcaStepper } from './stepper.js';
import { NlcaFrameBuffer, type BufferStatus, type BufferedFrame } from './frameBuffer.js';
import { CellAgentManager } from './cellAgentManager.js';
import type {
	ExperimentConfig,
	ExperimentStatus,
	ExperimentMeta,
	NlcaOrchestratorConfig,
	NlcaNeighborhood
} from './types.js';
import type { PromptConfig } from './prompt.js';

export interface Experiment {
	id: string;
	label: string;
	config: ExperimentConfig;
	status: ExperimentStatus;
	stepper: NlcaStepper | null;
	tape: NlcaTape;
	frameBuffer: NlcaFrameBuffer | null;
	agentManager: CellAgentManager | null;
	progress: { current: number; target: number };
	createdAt: number;
	dbFilename: string;
	errorMessage?: string;
	/** Current grid state for Canvas rendering */
	currentGrid: Uint32Array | null;
	/** Current generation being displayed */
	currentGeneration: number;
	/** Buffer status for timeline */
	bufferStatus: BufferStatus | null;
}

function generateDbFilename(config: ExperimentConfig): string {
	const ts = Date.now();
	const modelSlug = config.model.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 30);
	return `/nlca-${ts}-${modelSlug}-${config.gridWidth}x${config.gridHeight}.sqlite3`;
}

function generateLabel(config: ExperimentConfig, index: number): string {
	const modelShort = config.model.split('/').pop() ?? config.model;
	return `Exp ${index} · ${modelShort} · ${config.gridWidth}×${config.gridHeight}`;
}

function buildOrchestratorConfig(config: ExperimentConfig): NlcaOrchestratorConfig {
	return {
		apiKey: config.apiKey,
		model: {
			model: config.model,
			temperature: config.temperature,
			maxOutputTokens: config.maxOutputTokens
		},
		maxConcurrency: config.maxConcurrency,
		batchSize: config.batchSize,
		frameBatched: config.frameBatched,
		frameStreamed: config.frameStreamed,
		memoryWindow: config.memoryWindow,
		cellTimeoutMs: config.cellTimeoutMs,
		compressPayload: config.compressPayload,
		deduplicateRequests: config.deduplicateRequests
	};
}

function buildPromptConfig(config: ExperimentConfig): PromptConfig {
	return {
		taskDescription: config.taskDescription,
		useAdvancedMode: config.useAdvancedMode,
		advancedTemplate: config.advancedTemplate,
		cellColorHexEnabled: config.cellColorEnabled
	};
}

export class ExperimentManager {
	/** All experiments keyed by id */
	experiments = $state<Map<string, Experiment>>(new Map());
	/** Currently active (displayed) experiment id */
	activeId = $state<string | null>(null);
	/** Counter for auto-labeling */
	private experimentCounter = 0;
	/** Master index DB */
	private index: ExperimentIndex;
	/** Track active computation loops */
	private computeAbortControllers = new Map<string, AbortController>();

	constructor() {
		this.index = new ExperimentIndex();
	}

	get active(): Experiment | null {
		if (!this.activeId) return null;
		return this.experiments.get(this.activeId) ?? null;
	}

	get experimentList(): Experiment[] {
		return Array.from(this.experiments.values());
	}

	/**
	 * Load experiment list from master index on page load.
	 * Does NOT start computation — experiments load as 'paused'.
	 */
	async loadFromIndex(): Promise<void> {
		await this.index.init();
		const metas = await this.index.list();
		for (const meta of metas) {
			if (this.experiments.has(meta.id)) continue;
			const tape = new NlcaTape(meta.dbFilename);
			await tape.init();
			const exp: Experiment = {
				id: meta.id,
				label: meta.label,
				config: meta.config,
				status: meta.status === 'running' ? 'paused' : meta.status, // Don't auto-resume on reload
				stepper: null,
				tape,
				frameBuffer: null,
				agentManager: null,
				progress: { current: meta.frameCount, target: meta.config.targetFrames },
				createdAt: meta.createdAt,
				dbFilename: meta.dbFilename,
				errorMessage: meta.errorMessage,
				currentGrid: null,
				currentGeneration: 0,
				bufferStatus: null
			};
			this.experiments.set(meta.id, exp);
			this.experimentCounter++;
		}
	}

	/**
	 * Create a new experiment and optionally start it immediately.
	 */
	async createExperiment(config: ExperimentConfig, autoStart = true): Promise<string> {
		const id = crypto.randomUUID();
		this.experimentCounter++;
		const label = generateLabel(config, this.experimentCounter);
		const dbFilename = generateDbFilename(config);

		const tape = new NlcaTape(dbFilename);
		await tape.init();

		const exp: Experiment = {
			id,
			label,
			config,
			status: 'paused',
			stepper: null,
			tape,
			frameBuffer: null,
			agentManager: null,
			progress: { current: 0, target: config.targetFrames },
			createdAt: Date.now(),
			dbFilename,
			currentGrid: null,
			currentGeneration: 0,
			bufferStatus: null
		};

		this.experiments.set(id, exp);
		this.activeId = id;

		// Register in master index
		await this.index.init();
		await this.index.register({
			id,
			label,
			dbFilename,
			config,
			status: 'paused',
			createdAt: exp.createdAt,
			updatedAt: exp.createdAt,
			frameCount: 0
		});

		if (autoStart) {
			await this.startExperiment(id);
		}

		return id;
	}

	/**
	 * Initialize stepper/buffer and begin computing frames for an experiment.
	 */
	async startExperiment(id: string): Promise<void> {
		const exp = this.experiments.get(id);
		if (!exp) throw new Error(`Experiment ${id} not found`);

		const orchestratorConfig = buildOrchestratorConfig(exp.config);
		const agentManager = new CellAgentManager();
		const stepper = new NlcaStepper(
			{
				runId: id,
				neighborhood: exp.config.neighborhood,
				boundary: 'wrap',
				orchestrator: orchestratorConfig
			},
			agentManager
		);

		// Start run in tape
		await exp.tape.startRun({
			runId: id,
			width: exp.config.gridWidth,
			height: exp.config.gridHeight,
			neighborhood: exp.config.neighborhood,
			model: exp.config.model,
			maxConcurrency: exp.config.maxConcurrency,
			configJson: JSON.stringify(exp.config)
		});

		exp.stepper = stepper;
		exp.agentManager = agentManager;
		exp.status = 'running';

		await this.index.updateStatus(id, 'running');

		// Initialize grid if no existing state
		if (!exp.currentGrid) {
			const totalCells = exp.config.gridWidth * exp.config.gridHeight;
			exp.currentGrid = new Uint32Array(totalCells);
			// Random initialization (50% density)
			for (let i = 0; i < totalCells; i++) {
				exp.currentGrid[i] = Math.random() < 0.5 ? 1 : 0;
			}
		}

		// Start computation loop
		this.startComputeLoop(id);
	}

	private startComputeLoop(id: string): void {
		const controller = new AbortController();
		this.computeAbortControllers.set(id, controller);

		const loop = async () => {
			const exp = this.experiments.get(id);
			if (!exp || !exp.stepper || !exp.currentGrid) return;

			while (!controller.signal.aborted && exp.status === 'running' && exp.progress.current < exp.progress.target) {
				try {
					const generation = exp.progress.current + 1;
					const promptConfig = buildPromptConfig(exp.config);

					const result = await exp.stepper.step(
						exp.currentGrid,
						exp.config.gridWidth,
						exp.config.gridHeight,
						generation,
						undefined, // callbacks — will be wired to UI updates
						promptConfig
					);

					if (controller.signal.aborted) break;

					exp.currentGrid = result.next;
					exp.currentGeneration = generation;
					exp.progress = { current: generation, target: exp.progress.target };

					// Store frame to tape
					const { pack01ToBitset, encodeMetrics } = await import('./tape.js');
					await exp.tape.appendFrame({
						runId: id,
						generation,
						createdAt: Date.now(),
						stateBits: pack01ToBitset(result.next),
						metrics: result.metrics ? encodeMetrics(result.metrics) : undefined
					});

					// Update index periodically (every 5 frames)
					if (generation % 5 === 0) {
						await this.index.updateStatus(id, 'running', generation);
					}
				} catch (err) {
					if (controller.signal.aborted) break;
					exp.status = 'error';
					exp.errorMessage = err instanceof Error ? err.message : String(err);
					await this.index.updateStatus(id, 'error', exp.progress.current, exp.errorMessage);
					console.error(`[ExperimentManager] Experiment ${id} error:`, err);
					return;
				}
			}

			// Completed
			if (!controller.signal.aborted && exp.progress.current >= exp.progress.target) {
				exp.status = 'completed';
				await this.index.updateStatus(id, 'completed', exp.progress.current);
			}
		};

		loop();
	}

	async pauseExperiment(id: string): Promise<void> {
		const exp = this.experiments.get(id);
		if (!exp || exp.status !== 'running') return;

		const controller = this.computeAbortControllers.get(id);
		if (controller) {
			controller.abort();
			this.computeAbortControllers.delete(id);
		}

		exp.status = 'paused';
		await this.index.updateStatus(id, 'paused', exp.progress.current);
	}

	async resumeExperiment(id: string): Promise<void> {
		const exp = this.experiments.get(id);
		if (!exp || exp.status !== 'paused') return;

		if (!exp.stepper) {
			await this.startExperiment(id);
		} else {
			exp.status = 'running';
			await this.index.updateStatus(id, 'running', exp.progress.current);
			this.startComputeLoop(id);
		}
	}

	async deleteExperiment(id: string): Promise<void> {
		const controller = this.computeAbortControllers.get(id);
		if (controller) {
			controller.abort();
			this.computeAbortControllers.delete(id);
		}

		this.experiments.delete(id);
		await this.index.delete(id);

		if (this.activeId === id) {
			const remaining = Array.from(this.experiments.keys());
			this.activeId = remaining.length > 0 ? remaining[0] : null;
		}
	}

	setActive(id: string): void {
		if (this.experiments.has(id)) {
			this.activeId = id;
		}
	}

	/**
	 * Seek to a specific generation for playback (loads from tape).
	 */
	async seekToGeneration(id: string, generation: number): Promise<void> {
		const exp = this.experiments.get(id);
		if (!exp) return;

		const frame = await exp.tape.getFrame(id, generation);
		if (!frame) return;

		const { unpackBitsetTo01 } = await import('./tape.js');
		const totalCells = exp.config.gridWidth * exp.config.gridHeight;
		exp.currentGrid = unpackBitsetTo01(frame.stateBits, totalCells);
		exp.currentGeneration = generation;
	}
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`

- [ ] **Step 3: Commit**

```bash
git add src/lib/nlca/experimentManager.svelte.ts
git commit -m "feat(nlca): create ExperimentManager service for multi-experiment lifecycle"
```

---

### Task 4: Create `NlcaExperimentTabs` component

**Files:**
- Create: `src/lib/components/NlcaExperimentTabs.svelte`

- [ ] **Step 1: Create the tab bar component**

```svelte
<script lang="ts">
	import type { Experiment } from '$lib/nlca/experimentManager.svelte.js';

	interface Props {
		experiments: Experiment[];
		activeId: string | null;
		onselect: (id: string) => void;
		onnew: () => void;
		onpause: (id: string) => void;
		onresume: (id: string) => void;
		ondelete: (id: string) => void;
	}

	let { experiments, activeId, onselect, onnew, onpause, onresume, ondelete }: Props = $props();

	function statusIcon(status: Experiment['status']): string {
		switch (status) {
			case 'running': return '●';
			case 'paused': return '⏸';
			case 'completed': return '✓';
			case 'error': return '✗';
			default: return '○';
		}
	}

	function statusColor(status: Experiment['status']): string {
		switch (status) {
			case 'running': return 'var(--color-success, #22c55e)';
			case 'paused': return 'var(--color-warning, #eab308)';
			case 'completed': return 'var(--color-info, #3b82f6)';
			case 'error': return 'var(--color-error, #ef4444)';
			default: return 'var(--color-muted, #6b7280)';
		}
	}
</script>

<div class="experiment-tabs">
	{#each experiments as exp (exp.id)}
		<button
			class="tab"
			class:active={exp.id === activeId}
			onclick={() => onselect(exp.id)}
			title={`${exp.label}\n${exp.config.model}\n${exp.progress.current}/${exp.progress.target} frames`}
		>
			<span class="status-icon" style="color: {statusColor(exp.status)}">{statusIcon(exp.status)}</span>
			<span class="tab-label">{exp.label}</span>
			<span class="tab-progress">{exp.progress.current}/{exp.progress.target}</span>
			<div class="tab-actions">
				{#if exp.status === 'running'}
					<button class="tab-action" onclick|stopPropagation={() => onpause(exp.id)} title="Pause">⏸</button>
				{:else if exp.status === 'paused'}
					<button class="tab-action" onclick|stopPropagation={() => onresume(exp.id)} title="Resume">▶</button>
				{/if}
				<button class="tab-action delete" onclick|stopPropagation={() => ondelete(exp.id)} title="Delete">×</button>
			</div>
		</button>
	{/each}
	<button class="tab new-tab" onclick={onnew} title="New Experiment">
		+ New
	</button>
</div>

<style>
	.experiment-tabs {
		display: flex;
		gap: 2px;
		padding: 4px 8px;
		background: var(--color-surface-dark, #111);
		overflow-x: auto;
		scrollbar-width: thin;
		border-bottom: 1px solid var(--color-border, #333);
	}

	.tab {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		background: var(--color-surface, #1a1a1a);
		border: 1px solid var(--color-border, #333);
		border-bottom: none;
		border-radius: 6px 6px 0 0;
		color: var(--color-text-muted, #999);
		cursor: pointer;
		font-size: 12px;
		white-space: nowrap;
		transition: background 0.15s, color 0.15s;
	}

	.tab:hover {
		background: var(--color-surface-hover, #252525);
		color: var(--color-text, #eee);
	}

	.tab.active {
		background: var(--color-surface-active, #222);
		color: var(--color-text, #eee);
		border-color: var(--color-primary, #6366f1);
	}

	.status-icon {
		font-size: 10px;
	}

	.tab-label {
		max-width: 180px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tab-progress {
		color: var(--color-text-muted, #666);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
	}

	.tab-actions {
		display: flex;
		gap: 2px;
		margin-left: 4px;
	}

	.tab-action {
		background: none;
		border: none;
		color: var(--color-text-muted, #999);
		cursor: pointer;
		font-size: 12px;
		padding: 0 2px;
		border-radius: 3px;
	}

	.tab-action:hover {
		color: var(--color-text, #eee);
		background: var(--color-surface-hover, #333);
	}

	.tab-action.delete:hover {
		color: var(--color-error, #ef4444);
	}

	.new-tab {
		border-style: dashed;
		color: var(--color-text-muted, #666);
		font-weight: 500;
	}

	.new-tab:hover {
		color: var(--color-primary, #6366f1);
		border-color: var(--color-primary, #6366f1);
	}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/components/NlcaExperimentTabs.svelte
git commit -m "feat(nlca): add NlcaExperimentTabs component with status indicators"
```

---

### Task 5: Create `NlcaNewExperimentModal` with grouped sections

**Files:**
- Create: `src/lib/components/NlcaNewExperimentModal.svelte`

- [ ] **Step 1: Create the grouped modal**

```svelte
<script lang="ts">
	import type { ExperimentConfig, NlcaNeighborhood } from '$lib/nlca/types.js';
	import { PROMPT_PRESETS, type PromptPreset } from '$lib/stores/nlcaPrompt.svelte.js';
	import { getNlcaSettingsState } from '$lib/stores/nlcaSettings.svelte.js';
	import { draggable } from '$lib/actions/draggable.js';

	interface Props {
		onlaunch: (config: ExperimentConfig) => void;
		onclose: () => void;
	}

	let { onlaunch, onclose }: Props = $props();

	// Load defaults from global settings
	const defaults = getNlcaSettingsState();

	// Section 1: Model & Provider
	let model = $state(defaults.model);
	let apiKey = $state(defaults.apiKey);
	let temperature = $state(0.7);
	let maxOutputTokens = $state(8192);

	// Section 2: Simulation Parameters
	let gridWidth = $state(defaults.gridWidth);
	let gridHeight = $state(defaults.gridHeight);
	let neighborhood = $state<NlcaNeighborhood>(defaults.neighborhood);
	let cellColorEnabled = $state(false);

	// Section 3: Prompt & Task
	let selectedPresetId = $state<string>('filled-square');
	let taskDescription = $state(PROMPT_PRESETS[0]?.task ?? '');
	let useAdvancedMode = $state(false);
	let advancedTemplate = $state('');

	// Section 4: LLM / Technical Parameters
	let memoryWindow = $state(defaults.memoryWindow);
	let maxConcurrency = $state(defaults.maxConcurrency);
	let batchSize = $state(defaults.batchSize);
	let frameBatched = $state(defaults.frameBatched);
	let frameStreamed = $state(defaults.frameStreamed);
	let cellTimeoutMs = $state(30000);
	let compressPayload = $state(false);
	let deduplicateRequests = $state(false);

	// Section 5: Run Configuration
	let targetFrames = $state(50);
	let experimentLabel = $state('');

	// Group presets by category
	const presetsByCategory = $derived(() => {
		const grouped = new Map<string, PromptPreset[]>();
		for (const p of PROMPT_PRESETS) {
			const list = grouped.get(p.category) ?? [];
			list.push(p);
			grouped.set(p.category, list);
		}
		return grouped;
	});

	function onPresetChange(presetId: string) {
		selectedPresetId = presetId;
		const preset = PROMPT_PRESETS.find((p) => p.id === presetId);
		if (preset) {
			taskDescription = preset.task;
		}
	}

	function handleLaunch() {
		const config: ExperimentConfig = {
			apiKey,
			model,
			temperature,
			maxOutputTokens,
			gridWidth,
			gridHeight,
			neighborhood,
			cellColorEnabled,
			taskDescription,
			promptPresetId: selectedPresetId,
			useAdvancedMode,
			advancedTemplate: useAdvancedMode ? advancedTemplate : undefined,
			memoryWindow,
			maxConcurrency,
			batchSize,
			frameBatched,
			frameStreamed,
			cellTimeoutMs,
			compressPayload,
			deduplicateRequests,
			targetFrames
		};
		onlaunch(config);
	}

	// Common model presets
	const modelPresets = [
		'openai/gpt-4o-mini',
		'openai/gpt-4o',
		'anthropic/claude-3.5-sonnet',
		'anthropic/claude-3-haiku',
		'google/gemma-3-27b-it',
		'meta-llama/llama-3.1-70b-instruct',
		'mistralai/mistral-small-3.1-24b-instruct'
	];

	let position = $state({ x: 100, y: 50 });
	let activeSection = $state(0);
	const sections = ['Model & Provider', 'Simulation', 'Prompt & Task', 'Technical', 'Run Config'];
</script>

<div class="modal-overlay" onclick={onclose}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="modal"
		onclick|stopPropagation={() => {}}
		use:draggable={{ position, onMove: (p) => (position = p) }}
		style="left: {position.x}px; top: {position.y}px"
	>
		<div class="modal-header">
			<h2>New Experiment</h2>
			<button class="close-btn" onclick={onclose}>×</button>
		</div>

		<div class="section-tabs">
			{#each sections as section, i}
				<button
					class="section-tab"
					class:active={activeSection === i}
					onclick={() => (activeSection = i)}
				>
					{section}
				</button>
			{/each}
		</div>

		<div class="modal-body">
			{#if activeSection === 0}
				<!-- Section 1: Model & Provider -->
				<div class="section">
					<label class="field">
						<span>OpenRouter API Key</span>
						<input type="password" bind:value={apiKey} placeholder="sk-or-..." />
					</label>
					<label class="field">
						<span>Model</span>
						<input type="text" bind:value={model} placeholder="provider/model-name" />
						<div class="preset-chips">
							{#each modelPresets as mp}
								<button
									class="chip"
									class:selected={model === mp}
									onclick={() => (model = mp)}
								>
									{mp.split('/').pop()}
								</button>
							{/each}
						</div>
					</label>
					<div class="field-row">
						<label class="field">
							<span>Temperature</span>
							<input type="number" bind:value={temperature} min={0} max={2} step={0.1} />
						</label>
						<label class="field">
							<span>Max Output Tokens</span>
							<input type="number" bind:value={maxOutputTokens} min={256} max={65536} step={256} />
						</label>
					</div>
				</div>

			{:else if activeSection === 1}
				<!-- Section 2: Simulation Parameters -->
				<div class="section">
					<div class="field-row">
						<label class="field">
							<span>Grid Width</span>
							<input type="number" bind:value={gridWidth} min={8} max={512} />
						</label>
						<label class="field">
							<span>Grid Height</span>
							<input type="number" bind:value={gridHeight} min={8} max={512} />
						</label>
					</div>
					<label class="field">
						<span>Neighborhood</span>
						<select bind:value={neighborhood}>
							<option value="moore">Moore (8 neighbors)</option>
							<option value="vonNeumann">Von Neumann (4 neighbors)</option>
							<option value="extendedMoore">Extended Moore (24 neighbors)</option>
						</select>
					</label>
					<label class="field checkbox-field">
						<input type="checkbox" bind:checked={cellColorEnabled} />
						<span>Enable cell color output</span>
					</label>
				</div>

			{:else if activeSection === 2}
				<!-- Section 3: Prompt & Task -->
				<div class="section">
					<label class="field">
						<span>Preset</span>
						<select value={selectedPresetId} onchange={(e) => onPresetChange(e.currentTarget.value)}>
							{#each PROMPT_PRESETS as preset}
								<option value={preset.id}>{preset.name} — {preset.description}</option>
							{/each}
						</select>
					</label>
					<label class="field">
						<span>Task Description</span>
						<textarea bind:value={taskDescription} rows={6} placeholder="Describe the task for cells..." />
					</label>
					<label class="field checkbox-field">
						<input type="checkbox" bind:checked={useAdvancedMode} />
						<span>Advanced template mode</span>
					</label>
					{#if useAdvancedMode}
						<label class="field">
							<span>Custom Template</span>
							<textarea bind:value={advancedTemplate} rows={8} placeholder="Custom prompt template..." />
						</label>
					{/if}
				</div>

			{:else if activeSection === 3}
				<!-- Section 4: LLM / Technical Parameters -->
				<div class="section">
					<label class="field">
						<span>Memory Window (frames)</span>
						<input type="number" bind:value={memoryWindow} min={0} max={16} />
					</label>
					<div class="field-row">
						<label class="field">
							<span>Max Concurrency</span>
							<input type="number" bind:value={maxConcurrency} min={1} max={200} />
						</label>
						<label class="field">
							<span>Batch Size</span>
							<input type="number" bind:value={batchSize} min={1} max={2000} />
						</label>
					</div>
					<label class="field checkbox-field">
						<input type="checkbox" bind:checked={frameBatched} />
						<span>Frame-batched mode</span>
					</label>
					<label class="field checkbox-field">
						<input type="checkbox" bind:checked={frameStreamed} disabled={!frameBatched} />
						<span>Stream frame updates (SSE)</span>
					</label>
					<label class="field">
						<span>Cell Timeout (ms)</span>
						<input type="number" bind:value={cellTimeoutMs} min={5000} max={120000} step={1000} />
					</label>
					<div class="field-row">
						<label class="field checkbox-field">
							<input type="checkbox" bind:checked={compressPayload} />
							<span>Compress payload</span>
						</label>
						<label class="field checkbox-field">
							<input type="checkbox" bind:checked={deduplicateRequests} />
							<span>Deduplicate requests</span>
						</label>
					</div>
				</div>

			{:else if activeSection === 4}
				<!-- Section 5: Run Configuration -->
				<div class="section">
					<label class="field">
						<span>Target Frames</span>
						<input type="number" bind:value={targetFrames} min={1} max={10000} />
						<div class="preset-chips">
							{#each [10, 25, 50, 100, 250, 500] as n}
								<button
									class="chip"
									class:selected={targetFrames === n}
									onclick={() => (targetFrames = n)}
								>
									{n}
								</button>
							{/each}
						</div>
					</label>
					<label class="field">
						<span>Experiment Label (optional)</span>
						<input type="text" bind:value={experimentLabel} placeholder="Auto-generated if empty" />
					</label>
				</div>
			{/if}
		</div>

		<div class="modal-footer">
			<button class="btn secondary" onclick={onclose}>Cancel</button>
			<button class="btn primary" onclick={handleLaunch} disabled={!apiKey || !model || !taskDescription}>
				🚀 Launch Experiment
			</button>
		</div>
	</div>
</div>

<style>
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 1000;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: 5vh;
	}

	.modal {
		position: fixed;
		background: var(--color-surface, #1a1a1a);
		border: 1px solid var(--color-border, #333);
		border-radius: 12px;
		width: 520px;
		max-height: 80vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px 20px;
		border-bottom: 1px solid var(--color-border, #333);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--color-text, #eee);
	}

	.close-btn {
		background: none;
		border: none;
		color: var(--color-text-muted, #999);
		font-size: 20px;
		cursor: pointer;
		padding: 0 4px;
	}

	.section-tabs {
		display: flex;
		gap: 0;
		border-bottom: 1px solid var(--color-border, #333);
		padding: 0 12px;
		overflow-x: auto;
	}

	.section-tab {
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--color-text-muted, #999);
		cursor: pointer;
		font-size: 12px;
		padding: 10px 12px;
		white-space: nowrap;
		transition: color 0.15s, border-color 0.15s;
	}

	.section-tab:hover {
		color: var(--color-text, #eee);
	}

	.section-tab.active {
		color: var(--color-primary, #6366f1);
		border-bottom-color: var(--color-primary, #6366f1);
	}

	.modal-body {
		padding: 16px 20px;
		overflow-y: auto;
		flex: 1;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.field span {
		font-size: 12px;
		color: var(--color-text-muted, #999);
		font-weight: 500;
	}

	.field input[type='text'],
	.field input[type='password'],
	.field input[type='number'],
	.field select,
	.field textarea {
		background: var(--color-surface-dark, #111);
		border: 1px solid var(--color-border, #333);
		border-radius: 6px;
		color: var(--color-text, #eee);
		padding: 8px 10px;
		font-size: 13px;
		font-family: inherit;
	}

	.field textarea {
		resize: vertical;
	}

	.field-row {
		display: flex;
		gap: 12px;
	}

	.field-row .field {
		flex: 1;
	}

	.checkbox-field {
		flex-direction: row;
		align-items: center;
		gap: 8px;
	}

	.checkbox-field input[type='checkbox'] {
		accent-color: var(--color-primary, #6366f1);
	}

	.preset-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 4px;
	}

	.chip {
		background: var(--color-surface-dark, #111);
		border: 1px solid var(--color-border, #333);
		border-radius: 12px;
		color: var(--color-text-muted, #999);
		cursor: pointer;
		font-size: 11px;
		padding: 3px 10px;
		transition: all 0.15s;
	}

	.chip:hover {
		border-color: var(--color-primary, #6366f1);
		color: var(--color-text, #eee);
	}

	.chip.selected {
		background: var(--color-primary, #6366f1);
		border-color: var(--color-primary, #6366f1);
		color: white;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 12px 20px;
		border-top: 1px solid var(--color-border, #333);
	}

	.btn {
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
		font-weight: 500;
		padding: 8px 16px;
		transition: background 0.15s;
	}

	.btn.secondary {
		background: var(--color-surface-dark, #111);
		color: var(--color-text-muted, #999);
	}

	.btn.primary {
		background: var(--color-primary, #6366f1);
		color: white;
	}

	.btn.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn:hover:not(:disabled) {
		filter: brightness(1.15);
	}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/components/NlcaNewExperimentModal.svelte
git commit -m "feat(nlca): add NlcaNewExperimentModal with grouped config sections"
```

---

### Task 6: Wire `ExperimentManager` into `MainAppNlca.svelte`

**Files:**
- Modify: `src/lib/components/MainAppNlca.svelte`

This is the integration task. The current `MainAppNlca.svelte` manages modals and delegates to Canvas. We need to:

1. Instantiate `ExperimentManager` as page-level state
2. Add the tab bar above Canvas
3. Replace `NlcaSettingsModal` with `NlcaNewExperimentModal`
4. Pass active experiment data to Canvas, Controls, and Timeline

- [ ] **Step 1: Read current MainAppNlca.svelte to understand exact structure**

Read the full file before making changes.

- [ ] **Step 2: Add ExperimentManager and tab bar imports**

Add at the top of the `<script>` block:

```typescript
import { ExperimentManager } from '$lib/nlca/experimentManager.svelte.js';
import NlcaExperimentTabs from './NlcaExperimentTabs.svelte';
import NlcaNewExperimentModal from './NlcaNewExperimentModal.svelte';
import type { ExperimentConfig } from '$lib/nlca/types.js';
```

- [ ] **Step 3: Add ExperimentManager state**

Add after existing state declarations:

```typescript
const experimentManager = new ExperimentManager();
let showNewExperimentModal = $state(false);

// Initialize experiment manager on mount
$effect(() => {
	experimentManager.loadFromIndex();
});
```

- [ ] **Step 4: Add experiment lifecycle handlers**

```typescript
function handleLaunchExperiment(config: ExperimentConfig) {
	experimentManager.createExperiment(config);
	showNewExperimentModal = false;
}

function handlePauseExperiment(id: string) {
	experimentManager.pauseExperiment(id);
}

function handleResumeExperiment(id: string) {
	experimentManager.resumeExperiment(id);
}

function handleDeleteExperiment(id: string) {
	experimentManager.deleteExperiment(id);
}
```

- [ ] **Step 5: Add tab bar and new experiment modal to template**

Insert `NlcaExperimentTabs` above the Canvas in the template:

```svelte
<NlcaExperimentTabs
	experiments={experimentManager.experimentList}
	activeId={experimentManager.activeId}
	onselect={(id) => experimentManager.setActive(id)}
	onnew={() => showNewExperimentModal = true}
	onpause={handlePauseExperiment}
	onresume={handleResumeExperiment}
	ondelete={handleDeleteExperiment}
/>
```

Add the new experiment modal (alongside existing modals):

```svelte
{#if showNewExperimentModal}
	<NlcaNewExperimentModal
		onlaunch={handleLaunchExperiment}
		onclose={() => showNewExperimentModal = false}
	/>
{/if}
```

- [ ] **Step 6: Verify the page loads without errors**

Run: `npm run dev` and open the NLCA page. The tab bar should appear (empty), the "+ New" button should open the modal.

- [ ] **Step 7: Commit**

```bash
git add src/lib/components/MainAppNlca.svelte
git commit -m "feat(nlca): integrate ExperimentManager and tab bar into MainAppNlca"
```

---

### Task 7: Connect Canvas to active experiment

**Files:**
- Modify: `src/lib/components/Canvas.svelte`

The Canvas currently creates its own `NlcaStepper`, `NlcaTape`, and `NlcaFrameBuffer` internally. We need to make it capable of receiving these from the active experiment.

- [ ] **Step 1: Read Canvas.svelte to find exact integration points**

Read lines around `ensureNlcaReady` (263-319), `initNlcaFrameBuffer` (393-453), and the animation loop to understand the current binding.

- [ ] **Step 2: Add experiment-aware props**

Add to the component's props/exports:

```typescript
/** When set, Canvas renders this experiment's grid instead of managing its own stepper */
export let activeExperimentGrid: Uint32Array | null = null;
export let activeExperimentWidth: number | null = null;
export let activeExperimentHeight: number | null = null;
```

- [ ] **Step 3: Add reactive rendering of experiment grid**

In the animation/render loop, when `activeExperimentGrid` is set, render it instead of the internal grid:

```typescript
$effect(() => {
	if (activeExperimentGrid && activeExperimentWidth && activeExperimentHeight) {
		// Render the experiment's grid to the WebGPU canvas
		updateGridDisplay(activeExperimentGrid, activeExperimentWidth, activeExperimentHeight);
	}
});
```

The exact implementation depends on how the Canvas currently renders `lastGrid` — this should follow the same pattern but source from the experiment's `currentGrid`.

- [ ] **Step 4: Wire in MainAppNlca**

In `MainAppNlca.svelte`, pass active experiment data to Canvas:

```svelte
<Canvas
	bind:this={canvas}
	activeExperimentGrid={experimentManager.active?.currentGrid ?? null}
	activeExperimentWidth={experimentManager.active?.config.gridWidth ?? null}
	activeExperimentHeight={experimentManager.active?.config.gridHeight ?? null}
/>
```

- [ ] **Step 5: Test rendering**

1. Create a new experiment via the modal
2. Verify the grid renders in the Canvas
3. Verify switching tabs changes the displayed grid

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/Canvas.svelte src/lib/components/MainAppNlca.svelte
git commit -m "feat(nlca): connect Canvas to active experiment grid rendering"
```

---

### Task 8: Wire Controls and Timeline to active experiment

**Files:**
- Modify: `src/lib/components/ControlsNlca.svelte`
- Modify: `src/lib/components/MainAppNlca.svelte`

- [ ] **Step 1: Add experiment-aware props to ControlsNlca**

Add props for the active experiment's pause/resume state:

```typescript
interface Props {
	// ... existing props ...
	experimentActive?: boolean;
	experimentStatus?: 'running' | 'paused' | 'completed' | 'error';
	onexperimentpause?: () => void;
	onexperimentresume?: () => void;
}
```

- [ ] **Step 2: Update play/pause button to use experiment controls**

When `experimentActive` is true, the play/pause button should pause/resume the active experiment instead of the old simulation state:

```svelte
{#if experimentActive}
	<button
		class="control-btn primary"
		onclick={() => experimentStatus === 'running' ? onexperimentpause?.() : onexperimentresume?.()}
		title={experimentStatus === 'running' ? 'Pause experiment' : 'Resume experiment'}
	>
		{experimentStatus === 'running' ? '⏸' : '▶'}
	</button>
{:else}
	<!-- existing play/pause button -->
{/if}
```

- [ ] **Step 3: Wire from MainAppNlca**

```svelte
<ControlsNlca
	experimentActive={!!experimentManager.active}
	experimentStatus={experimentManager.active?.status}
	onexperimentpause={() => experimentManager.active && experimentManager.pauseExperiment(experimentManager.active.id)}
	onexperimentresume={() => experimentManager.active && experimentManager.resumeExperiment(experimentManager.active.id)}
	{...existingProps}
/>
```

- [ ] **Step 4: Wire Timeline to active experiment**

Pass the active experiment's progress to the timeline:

```svelte
<NlcaTimeline
	currentGeneration={experimentManager.active?.currentGeneration ?? 0}
	bufferedFrames={[]}
	bufferStatus={experimentManager.active?.bufferStatus ?? null}
	batchRunActive={experimentManager.active?.status === 'running'}
	batchRunTarget={experimentManager.active?.progress.target ?? 0}
	batchRunCompleted={experimentManager.active?.progress.current ?? 0}
	onSeek={(gen) => experimentManager.active && experimentManager.seekToGeneration(experimentManager.active.id, gen)}
/>
```

- [ ] **Step 5: Test end-to-end**

1. Create an experiment → verify play/pause button works
2. Verify timeline shows progress
3. Pause, switch tab, resume → verify correct experiment is controlled

- [ ] **Step 6: Commit**

```bash
git add src/lib/components/ControlsNlca.svelte src/lib/components/MainAppNlca.svelte src/lib/components/NlcaTimeline.svelte
git commit -m "feat(nlca): wire Controls and Timeline to active experiment state"
```

---

### Task 9: Integration testing and polish

**Files:**
- Modify: various (bug fixes from integration)

- [ ] **Step 1: Verify TypeScript compiles cleanly**

Run: `npx tsc --noEmit --pretty 2>&1 | tail -30`
Fix any type errors.

- [ ] **Step 2: Test: Create 2 parallel experiments**

1. Open NLCA page
2. Click "+ New" → select `openai/gpt-4o-mini`, 10×10, Moore, 10 frames → Launch
3. Click "+ New" → select `google/gemma-3-27b-it`, 15×15, vonNeumann, 10 frames → Launch
4. Verify both tabs show progress indicators updating
5. Switch between tabs — Canvas should show different grids

- [ ] **Step 3: Test: Pause and resume**

1. Pause experiment 1 → verify status icon changes to ⏸
2. Experiment 2 continues computing
3. Resume experiment 1 → verify it picks up where it left off

- [ ] **Step 4: Test: Page reload persistence**

1. Reload the page
2. Verify both experiments appear in the tab bar (from master index)
3. Click an experiment → verify frames load from SQLite for playback
4. Verify OPFS has two separate `.sqlite3` files (check dev tools → Application → Storage)

- [ ] **Step 5: Test: Delete experiment**

1. Delete experiment 2
2. Verify tab disappears
3. Verify active tab switches to experiment 1

- [ ] **Step 6: Clean up old NlcaSettingsModal references**

Keep `NlcaSettingsModal.svelte` for backward compatibility but add a note that it's superseded by `NlcaNewExperimentModal`. Update the settings button in `ControlsNlca` to open the new modal when in experiment mode. The old settings modal can remain accessible for global settings (API key).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(nlca): complete experiment hub integration with parallel execution and persistence"
```

---

## Verification Checklist

1. **Create 2 experiments** with different models → both tabs show, both computing in parallel
2. **Switch tabs** → Canvas shows correct grid for each experiment
3. **Pause/resume** → individual experiment control works
4. **Timeline** → shows correct progress per-experiment
5. **Reload page** → experiments reappear from master index, frames playable from per-experiment SQLite
6. **OPFS files** → two separate `.sqlite3` files with correct naming convention
7. **New Experiment Modal** → all 5 sections render correctly, presets populate, validation works
8. **Delete experiment** → tab removed, active switches, DB entry cleaned up
