import type { NlcaCellMetricsFrame, NlcaRunConfig, ExperimentMeta, ExperimentConfig } from './types.js';
// Lazy import to avoid SSR issues - only loaded when getSqlite3 is called
let getSqlite3: (() => Promise<any>) | null = null;
let isCrossOriginIsolated: (() => boolean) | null = null;

async function ensureSqlite() {
	if (!getSqlite3 || !isCrossOriginIsolated) {
		const sqliteModule = await import('./sqlite.js');
		getSqlite3 = sqliteModule.getSqlite3;
		isCrossOriginIsolated = sqliteModule.isCrossOriginIsolated;
	}
}

export interface NlcaTapeFrame {
	runId: string;
	generation: number;
	createdAt: number;
	stateBits: Uint8Array;
	metrics?: Uint8Array;
}

export function pack01ToBitset(grid01: Uint32Array): Uint8Array {
	const n = grid01.length;
	const bytes = new Uint8Array(Math.ceil(n / 8));
	for (let i = 0; i < n; i++) {
		const bit = (grid01[i] ?? 0) === 0 ? 0 : 1;
		if (bit) bytes[i >> 3] |= 1 << (i & 7);
	}
	return bytes;
}

export function unpackBitsetTo01(bits: Uint8Array, nCells: number): Uint32Array {
	const out = new Uint32Array(nCells);
	for (let i = 0; i < nCells; i++) {
		const b = (bits[i >> 3] >> (i & 7)) & 1;
		out[i] = b;
	}
	return out;
}

export function encodeMetrics(metrics: NlcaCellMetricsFrame): Uint8Array {
	// Simple packed layout:
	// [0..n-1] latency8
	// [n..2n-1] changed01
	const n = metrics.latency8.length;
	const out = new Uint8Array(n * 2);
	out.set(metrics.latency8, 0);
	out.set(metrics.changed01, n);
	return out;
}

export function decodeMetrics(metricsBlob: Uint8Array, nCells: number): NlcaCellMetricsFrame | null {
	if (metricsBlob.length !== nCells * 2) return null;
	return {
		latency8: metricsBlob.slice(0, nCells),
		changed01: metricsBlob.slice(nCells, nCells * 2)
	};
}

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
		// Prefer OPFS if available + crossOriginIsolated, otherwise fall back to transient DB.
		try {
			if (isCrossOriginIsolated() && 'opfs' in sqlite3 && sqlite3.oo1?.OpfsDb) {
				this.db = new sqlite3.oo1.OpfsDb(this.dbPath);
			} else {
				this.db = new sqlite3.oo1.DB(this.dbPath, 'ct');
			}
		} catch {
			// Last resort: transient DB.
			this.db = new sqlite3.oo1.DB(this.dbPath, 'ct');
		}

		this.migrate();
		this.ready = true;
	}

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

	async appendFrame(frame: NlcaTapeFrame): Promise<void> {
		await this.init();
		this.db.exec({
			sql: `INSERT OR REPLACE INTO nlca_frames(run_id, generation, created_at, state_bits, metrics)
			      VALUES(?, ?, ?, ?, ?)`,
			bind: [frame.runId, frame.generation, frame.createdAt, frame.stateBits, frame.metrics ?? null]
		});
	}

	async getFrame(runId: string, generation: number): Promise<NlcaTapeFrame | null> {
		await this.init();
		const stmt = this.db.prepare(
			`SELECT created_at, state_bits, metrics FROM nlca_frames WHERE run_id = ? AND generation = ?`
		);
		try {
			stmt.bind([runId, generation]);
			if (!stmt.step()) return null;
			const row = stmt.get([]) as any[];
			const createdAt = Number(row[0] ?? 0);
			const stateBits = row[1] as Uint8Array;
			const metrics = row[2] ? (row[2] as Uint8Array) : undefined;
			return { runId, generation, createdAt, stateBits, metrics };
		} finally {
			stmt.finalize();
		}
	}

	async getLatestGeneration(runId: string): Promise<number> {
		await this.init();
		const stmt = this.db.prepare(`SELECT MAX(generation) FROM nlca_frames WHERE run_id = ?`);
		try {
			stmt.bind([runId]);
			if (!stmt.step()) return 0;
			const v = stmt.get(0) as any;
			return typeof v === 'number' ? v : v ? Number(v) : 0;
		} finally {
			stmt.finalize();
		}
	}

	async listRuns(): Promise<NlcaRunConfig[]> {
		await this.init();
		const runs: NlcaRunConfig[] = [];
		const stmt = this.db.prepare(
			`SELECT run_id, created_at, width, height, neighborhood, model, max_concurrency, seed, notes FROM nlca_runs ORDER BY created_at DESC`
		);
		try {
			while (stmt.step()) {
				const row = stmt.get([]) as any[];
				runs.push({
					runId: String(row[0]),
					createdAt: Number(row[1]),
					width: Number(row[2]),
					height: Number(row[3]),
					neighborhood: row[4],
					model: String(row[5]),
					maxConcurrency: Number(row[6]),
					seed: row[7] ? String(row[7]) : undefined,
					notes: row[8] ? String(row[8]) : undefined
				});
			}
		} finally {
			stmt.finalize();
		}
		return runs;
	}

	async deleteRun(runId: string): Promise<void> {
		await this.init();
		this.db.exec({ sql: `DELETE FROM nlca_frames WHERE run_id = ?`, bind: [runId] });
		this.db.exec({ sql: `DELETE FROM nlca_runs WHERE run_id = ?`, bind: [runId] });
	}
}

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
