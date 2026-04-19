import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// Keep DB connections open for the lifetime of the dev server process.
const dbs = new Map<string, Database.Database>();

/** Map a virtual DB path (e.g. /nlca-{ts}-{slug}-10x10.sqlite3) to a real path on disk. */
function resolveLocalPath(dbPath: string): string {
	const filename = dbPath.replace(/^\/+/, '');

	if (filename === 'nlca-index.sqlite3') {
		return join(process.cwd(), 'experiments', filename);
	}

	// Extract model slug from: nlca-{timestamp}-{model-slug}-{W}x{H}.sqlite3
	const match = filename.match(/^nlca-\d+-(.+)-\d+x\d+\.sqlite3$/);
	const modelSlug = match?.[1] ?? 'unknown';
	return join(process.cwd(), 'experiments', modelSlug, filename);
}

function getDb(dbPath: string): Database.Database {
	if (dbs.has(dbPath)) return dbs.get(dbPath)!;
	const localPath = resolveLocalPath(dbPath);
	mkdirSync(dirname(localPath), { recursive: true });
	const db = new Database(localPath);
	db.pragma('journal_mode = WAL');
	dbs.set(dbPath, db);
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

	// Handle 'exists' before opening the DB (which would create the file).
	if (op === 'exists') {
		const localPath = resolveLocalPath(dbPath);
		return new Response(JSON.stringify({ exists: existsSync(localPath) }), {
			headers: { 'Content-Type': 'application/json' }
		});
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
		console.error('[nlca-db]', op, dbPath, e);
		throw error(500, String(e));
	}
};
