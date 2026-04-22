import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { resolveLocalPath } from './resolvePath.js';
import { rejectIfForbiddenSql } from './sqlAllowlist.js';
import { isIdempotentMigrationError } from './idempotentMigration.js';

// Keep DB connections open for the lifetime of the dev server process.
const dbs = new Map<string, Database.Database>();

function getDb(dbPath: string): Database.Database {
	// Key the cache by the resolved path — two different virtual dbPath
	// strings that normalize to the same file share one connection.
	const localPath = resolveLocalPath(dbPath);
	if (dbs.has(localPath)) return dbs.get(localPath)!;
	mkdirSync(dirname(localPath), { recursive: true });
	const db = new Database(localPath);
	db.pragma('journal_mode = WAL');
	dbs.set(localPath, db);
	return db;
}

type RawValue = string | number | null | { __b64: string };
type SqlRow = RawValue[];

function decodeValue(v: unknown): Buffer | string | number | null {
	if (v && typeof v === 'object' && '__b64' in v) {
		return Buffer.from((v as { __b64: string }).__b64, 'base64');
	}
	return v as string | number | null;
}

function encodeValue(v: unknown): RawValue {
	if (Buffer.isBuffer(v)) return { __b64: v.toString('base64') };
	return v as RawValue;
}

function encodeRow(row: unknown[]): SqlRow {
	return row.map(encodeValue);
}

export const POST: RequestHandler = async ({ request }) => {
	if (!dev) throw error(403, 'DB proxy only available in dev mode');

	let body: { dbPath: string; op: string; sql?: string; bind?: unknown[] };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}

	const { dbPath, op, sql = '', bind = [] } = body;
	if (!dbPath) throw error(400, 'Missing dbPath');

	// Resolve once and reject any path-traversal attempt up-front.
	let resolvedPath: string;
	try {
		resolvedPath = resolveLocalPath(dbPath);
	} catch (e) {
		throw error(400, `Invalid dbPath: ${e instanceof Error ? e.message : 'unknown'}`);
	}

	// Handle 'exists' before opening the DB (which would create the file).
	if (op === 'exists') {
		return new Response(JSON.stringify({ exists: existsSync(resolvedPath) }), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Stopgap allowlist — rejects ATTACH/DETACH/VACUUM/BACKUP/LOAD_EXTENSION
	// and arbitrary PRAGMAs that a hostile client could use for RCE or
	// exfiltration. Full typed RPC is the longer-term replacement; this
	// gives us hosted-safety today.
	if (op === 'exec' || op === 'run' || op === 'all' || op === 'get') {
		const rejection = rejectIfForbiddenSql(sql);
		if (rejection) throw error(400, `Rejected SQL: ${rejection}`);
	}

	const db = getDb(dbPath);
	const decodedBind = bind.map(decodeValue);

	try {
		switch (op) {
			case 'exec': {
				db.exec(sql);
				return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
			}
			case 'run': {
				db.prepare(sql).run(...decodedBind);
				return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
			}
			case 'all': {
				const rows = (db.prepare(sql).raw(true).all(...decodedBind) as unknown[][]).map(encodeRow);
				return new Response(JSON.stringify({ rows }), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
			case 'get': {
				const row = db.prepare(sql).raw(true).get(...decodedBind) as unknown[] | undefined;
				return new Response(JSON.stringify({ row: row ? encodeRow(row) : null }), {
					headers: { 'Content-Type': 'application/json' }
				});
			}
			default:
				throw error(400, `Unknown op: ${op}`);
		}
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		const msg = String(e);
		// Benign idempotent migration retries — ADD COLUMN for a column that
		// already exists, CREATE TABLE/INDEX without IF NOT EXISTS — are the
		// expected outcome on second and later boots. Return 200 so the server
		// log and browser devtools stay quiet; the client's effect (column
		// exists) is already in place.
		if (isIdempotentMigrationError(msg)) {
			return new Response(JSON.stringify({ skipped: 'already-applied' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		console.error('[nlca-db]', op, dbPath, e);
		throw error(500, msg);
	}
};
