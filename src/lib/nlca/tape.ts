import { dev } from '$app/environment';
import type { NlcaCellMetricsFrame, NlcaRunConfig, ExperimentMeta, ExperimentConfig } from './types.js';

// ---------------------------------------------------------------------------
// DbHandle abstraction — synchronous sqlite-wasm vs. HTTP-proxied server DB
// ---------------------------------------------------------------------------

type SqlValue = string | number | null | Uint8Array;

interface DbHandle {
	exec(sql: string): Promise<void>;
	run(sql: string, bind: SqlValue[]): Promise<void>;
	all(sql: string, bind?: SqlValue[]): Promise<SqlValue[][]>;
	get(sql: string, bind?: SqlValue[]): Promise<SqlValue[] | null>;
}

/** Wraps the synchronous sqlite-wasm OO1 DB in the async DbHandle interface. */
class BrowserDbHandle implements DbHandle {
	constructor(private db: any) {}

	async exec(sql: string): Promise<void> {
		this.db.exec(sql);
	}
	async run(sql: string, bind: SqlValue[]): Promise<void> {
		this.db.exec({ sql, bind });
	}
	async all(sql: string, bind?: SqlValue[]): Promise<SqlValue[][]> {
		const stmt = this.db.prepare(sql);
		try {
			if (bind?.length) stmt.bind(bind);
			const rows: SqlValue[][] = [];
			while (stmt.step()) rows.push(stmt.get([]) as SqlValue[]);
			return rows;
		} finally {
			stmt.finalize();
		}
	}
	async get(sql: string, bind?: SqlValue[]): Promise<SqlValue[] | null> {
		const stmt = this.db.prepare(sql);
		try {
			if (bind?.length) stmt.bind(bind);
			if (!stmt.step()) return null;
			return stmt.get([]) as SqlValue[];
		} finally {
			stmt.finalize();
		}
	}
}

type RawValue = string | number | null | { __b64: string };

function encodeBindValue(v: SqlValue): RawValue {
	if (v instanceof Uint8Array) {
		let bin = '';
		for (let i = 0; i < v.length; i++) bin += String.fromCharCode(v[i]);
		return { __b64: btoa(bin) };
	}
	return v;
}

function decodeResultValue(v: RawValue): SqlValue {
	if (v && typeof v === 'object' && '__b64' in v) {
		const bin = atob(v.__b64);
		const arr = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
		return arr;
	}
	return v as SqlValue;
}

/** Proxies all DB operations to the /api/nlca-db SvelteKit server route (dev only). */
class ServerDbHandle implements DbHandle {
	constructor(private dbPath: string) {}

	private async call(op: string, extra?: object): Promise<any> {
		const res = await fetch('/api/nlca-db', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ dbPath: this.dbPath, op, ...extra })
		});
		if (!res.ok) throw new Error(`[nlca-db] ${op} ${this.dbPath}: ${await res.text()}`);
		return res.json();
	}

	async fileExists(): Promise<boolean> {
		try {
			const { exists } = await this.call('exists');
			return Boolean(exists);
		} catch {
			return false;
		}
	}

	async exec(sql: string): Promise<void> {
		await this.call('exec', { sql });
	}
	async run(sql: string, bind: SqlValue[]): Promise<void> {
		await this.call('run', { sql, bind: bind.map(encodeBindValue) });
	}
	async all(sql: string, bind?: SqlValue[]): Promise<SqlValue[][]> {
		const { rows } = await this.call('all', { sql, bind: (bind ?? []).map(encodeBindValue) });
		return (rows as RawValue[][]).map((r) => r.map(decodeResultValue));
	}
	async get(sql: string, bind?: SqlValue[]): Promise<SqlValue[] | null> {
		const { row } = await this.call('get', { sql, bind: (bind ?? []).map(encodeBindValue) });
		return row ? (row as RawValue[]).map(decodeResultValue) : null;
	}
}

// ---------------------------------------------------------------------------
// Lazy import of browser-side sqlite (SSR-safe)
// ---------------------------------------------------------------------------
let _getSqlite3: (() => Promise<any>) | null = null;
let _isCrossOriginIsolated: (() => boolean) | null = null;

async function ensureSqlite() {
	if (!_getSqlite3 || !_isCrossOriginIsolated) {
		const m = await import('./sqlite.js');
		_getSqlite3 = m.getSqlite3;
		_isCrossOriginIsolated = m.isCrossOriginIsolated;
	}
}

async function makeBrowserHandle(dbPath: string): Promise<BrowserDbHandle> {
	await ensureSqlite();
	const sqlite3 = await _getSqlite3!();
	let rawDb: any;
	try {
		if (_isCrossOriginIsolated!() && 'opfs' in sqlite3 && sqlite3.oo1?.OpfsDb) {
			rawDb = new sqlite3.oo1.OpfsDb(dbPath);
		} else {
			rawDb = new sqlite3.oo1.DB(dbPath, 'ct');
		}
	} catch {
		rawDb = new sqlite3.oo1.DB(dbPath, 'ct');
	}
	return new BrowserDbHandle(rawDb);
}

// ---------------------------------------------------------------------------
// Utility pack/unpack helpers (exported for use in experimentManager)
// ---------------------------------------------------------------------------

export interface NlcaTapeFrame {
	runId: string;
	generation: number;
	createdAt: number;
	stateBits: Uint8Array;
	metrics?: Uint8Array;
	colorsHex?: Array<string | null>;
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

/**
 * Serialise one NLCA frame to a single-line JSON string suitable for a `.jsonl`
 * tape. Emits only alive cells (state=1) to keep file size bounded — dead cells
 * are implicit from the grid dimensions. Colours and metrics are optional.
 */
export function buildFrameLine(
	generation: number,
	createdAt: number,
	grid01: Uint32Array,
	width: number,
	height: number,
	colorsHex?: Array<string | null> | null,
	metrics?: NlcaCellMetricsFrame | null
): string {
	const cells: Array<[number, number, string | null]> = [];
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = y * width + x;
			if ((grid01[idx] ?? 0) === 0) continue;
			const hex = colorsHex?.[idx] ?? null;
			cells.push([x, y, hex]);
		}
	}
	let metricsSummary: { avgLatencyMs: number; changedCount: number } | undefined;
	if (metrics && metrics.latency8.length > 0) {
		let latSum = 0;
		for (let i = 0; i < metrics.latency8.length; i++) latSum += metrics.latency8[i] ?? 0;
		let changed = 0;
		for (let i = 0; i < metrics.changed01.length; i++) changed += metrics.changed01[i] ?? 0;
		metricsSummary = {
			avgLatencyMs: Math.round((latSum / metrics.latency8.length) * 10),
			changedCount: changed
		};
	}
	const record: {
		generation: number;
		createdAt: number;
		width: number;
		height: number;
		cells: Array<[number, number, string | null]>;
		metrics?: { avgLatencyMs: number; changedCount: number };
	} = { generation, createdAt, width, height, cells };
	if (metricsSummary) record.metrics = metricsSummary;
	return JSON.stringify(record);
}

// ---------------------------------------------------------------------------
// NlcaTape
// ---------------------------------------------------------------------------

export class NlcaTape {
	private db: DbHandle | null = null;
	private ready = false;
	private dbPath: string;

	constructor(dbPath: string = '/nlca.sqlite3') {
		this.dbPath = dbPath;
	}

	async init(): Promise<void> {
		if (this.ready) return;
		this.db = dev ? new ServerDbHandle(this.dbPath) : await makeBrowserHandle(this.dbPath);
		await this.migrate();
		this.ready = true;
	}

	/**
	 * Returns false when running in dev mode and the backing file does not exist
	 * on disk yet.  Calling this before init() lets callers skip creating a phantom
	 * empty database for experiment tapes whose data was never written.
	 */
	async fileExists(): Promise<boolean> {
		if (!dev) return true; // Browser/OPFS — always try to open
		return new ServerDbHandle(this.dbPath).fileExists();
	}

	private async migrate(): Promise<void> {
		if (!this.db) return;
		await this.db.exec(
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
		try {
			await this.db.exec(`ALTER TABLE nlca_runs ADD COLUMN config_json TEXT`);
		} catch {
			// Column already exists — ignore
		}
		try {
			await this.db.exec(`ALTER TABLE nlca_frames ADD COLUMN colors_json TEXT`);
		} catch {
			// Column already exists — ignore
		}
	}

	async startRun(
		cfg: Omit<NlcaRunConfig, 'createdAt'> & { createdAt?: number; configJson?: string }
	): Promise<string> {
		await this.init();
		const runId = cfg.runId;
		const createdAt = cfg.createdAt ?? Date.now();
		console.log(
			`[NLCA] Starting run ${runId}: ${cfg.width}x${cfg.height}, model: ${cfg.model}, concurrency: ${cfg.maxConcurrency}`
		);
		await this.db!.run(
			`INSERT OR REPLACE INTO nlca_runs(run_id, created_at, width, height, neighborhood, model, max_concurrency, seed, notes, config_json)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
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
		);
		return runId;
	}

	async appendFrame(frame: NlcaTapeFrame): Promise<void> {
		await this.init();
		const colorsJson = frame.colorsHex ? JSON.stringify(frame.colorsHex) : null;
		await this.db!.run(
			`INSERT OR REPLACE INTO nlca_frames(run_id, generation, created_at, state_bits, metrics, colors_json)
			 VALUES(?, ?, ?, ?, ?, ?)`,
			[frame.runId, frame.generation, frame.createdAt, frame.stateBits, frame.metrics ?? null, colorsJson]
		);
	}

	async getFrame(runId: string, generation: number): Promise<NlcaTapeFrame | null> {
		await this.init();
		const row = await this.db!.get(
			`SELECT created_at, state_bits, metrics, colors_json FROM nlca_frames WHERE run_id = ? AND generation = ?`,
			[runId, generation]
		);
		if (!row) return null;
		const createdAt = Number(row[0] ?? 0);
		const stateBits = row[1] as Uint8Array;
		const metrics = row[2] instanceof Uint8Array ? row[2] : undefined;
		let colorsHex: Array<string | null> | undefined;
		if (typeof row[3] === 'string' && row[3]) {
			try {
				colorsHex = JSON.parse(row[3]) as Array<string | null>;
			} catch {
				colorsHex = undefined;
			}
		}
		return { runId, generation, createdAt, stateBits, metrics, colorsHex };
	}

	async getLatestGeneration(runId: string): Promise<number> {
		await this.init();
		const row = await this.db!.get(`SELECT MAX(generation) FROM nlca_frames WHERE run_id = ?`, [
			runId
		]);
		if (!row) return 0;
		const v = row[0];
		return typeof v === 'number' ? v : v ? Number(v) : 0;
	}

	async listRuns(): Promise<NlcaRunConfig[]> {
		await this.init();
		const rows = await this.db!.all(
			`SELECT run_id, created_at, width, height, neighborhood, model, max_concurrency, seed, notes FROM nlca_runs ORDER BY created_at DESC`
		);
		return rows.map((row) => ({
			runId: String(row[0]),
			createdAt: Number(row[1]),
			width: Number(row[2]),
			height: Number(row[3]),
			neighborhood: row[4] as any,
			model: String(row[5]),
			maxConcurrency: Number(row[6]),
			seed: row[7] ? String(row[7]) : undefined,
			notes: row[8] ? String(row[8]) : undefined
		}));
	}

	async deleteRun(runId: string): Promise<void> {
		await this.init();
		await this.db!.run(`DELETE FROM nlca_frames WHERE run_id = ?`, [runId]);
		await this.db!.run(`DELETE FROM nlca_runs WHERE run_id = ?`, [runId]);
	}
}

// ---------------------------------------------------------------------------
// ExperimentIndex
// ---------------------------------------------------------------------------

export class ExperimentIndex {
	private db: DbHandle | null = null;
	private ready = false;

	async init(): Promise<void> {
		if (this.ready) return;
		const path = '/nlca-index.sqlite3';
		this.db = dev ? new ServerDbHandle(path) : await makeBrowserHandle(path);
		await this.db.exec(`CREATE TABLE IF NOT EXISTS experiments (
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
		await this.db!.run(
			`INSERT OR REPLACE INTO experiments(id, label, db_filename, config_json, status, created_at, updated_at, frame_count, error_message)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
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
		);
	}

	async updateStatus(
		id: string,
		status: ExperimentMeta['status'],
		frameCount?: number,
		errorMessage?: string
	): Promise<void> {
		await this.init();
		const now = Date.now();
		if (frameCount !== undefined) {
			await this.db!.run(
				`UPDATE experiments SET status = ?, updated_at = ?, frame_count = ?, error_message = ? WHERE id = ?`,
				[status, now, frameCount, errorMessage ?? null, id]
			);
		} else {
			await this.db!.run(
				`UPDATE experiments SET status = ?, updated_at = ?, error_message = ? WHERE id = ?`,
				[status, now, errorMessage ?? null, id]
			);
		}
	}

	async list(): Promise<ExperimentMeta[]> {
		await this.init();
		const rows = await this.db!.all(
			`SELECT id, label, db_filename, config_json, status, created_at, updated_at, frame_count, error_message
			 FROM experiments ORDER BY created_at DESC`
		);
		return rows.map((row) => ({
			id: String(row[0]),
			label: String(row[1]),
			dbFilename: String(row[2]),
			config: JSON.parse(String(row[3])) as ExperimentConfig,
			status: row[4] as ExperimentMeta['status'],
			createdAt: Number(row[5]),
			updatedAt: Number(row[6]),
			frameCount: Number(row[7]),
			errorMessage: row[8] ? String(row[8]) : undefined
		}));
	}

	async delete(id: string): Promise<void> {
		await this.init();
		await this.db!.run(`DELETE FROM experiments WHERE id = ?`, [id]);
	}

	async get(id: string): Promise<ExperimentMeta | null> {
		await this.init();
		const row = await this.db!.get(
			`SELECT id, label, db_filename, config_json, status, created_at, updated_at, frame_count, error_message
			 FROM experiments WHERE id = ?`,
			[id]
		);
		if (!row) return null;
		return {
			id: String(row[0]),
			label: String(row[1]),
			dbFilename: String(row[2]),
			config: JSON.parse(String(row[3])) as ExperimentConfig,
			status: row[4] as ExperimentMeta['status'],
			createdAt: Number(row[5]),
			updatedAt: Number(row[6]),
			frameCount: Number(row[7]),
			errorMessage: row[8] ? String(row[8]) : undefined
		};
	}
}
