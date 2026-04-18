import { json, error, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';

/**
 * Single append-only CSV of every simulation run, written whenever the UI
 * creates, updates, or completes an experiment. Lives at
 * `<repo-root>/experiments/runs.csv` and survives restarts. The Runs panel
 * loads from here when running locally; in a built static deploy the endpoint
 * is unavailable and the UI falls back to in-memory state.
 */

const CSV_DIR = join(process.cwd(), 'experiments');
const CSV_PATH = join(CSV_DIR, 'runs.csv');

const COLUMNS = [
	'id',
	'label',
	'apiProvider',
	'model',
	'gridWidth',
	'gridHeight',
	'neighborhood',
	'cellColorEnabled',
	'taskDescription',
	'memoryWindow',
	'maxConcurrency',
	'batchSize',
	'frameBatched',
	'frameStreamed',
	'compressPayload',
	'deduplicateRequests',
	'targetFrames',
	'status',
	'frameCount',
	'createdAt',
	'updatedAt',
	'dbFilename',
	'errorMessage'
] as const;

type Row = Record<(typeof COLUMNS)[number], string>;

function csvEscape(value: unknown): string {
	const s = value === null || value === undefined ? '' : String(value);
	if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

function parseCsv(text: string): Row[] {
	const rows: string[][] = [];
	let i = 0;
	let field = '';
	let row: string[] = [];
	let inQuotes = false;
	while (i < text.length) {
		const ch = text[i]!;
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			i++;
			continue;
		}
		if (ch === ',') {
			row.push(field);
			field = '';
			i++;
			continue;
		}
		if (ch === '\n' || ch === '\r') {
			if (field.length > 0 || row.length > 0) {
				row.push(field);
				rows.push(row);
				row = [];
				field = '';
			}
			if (ch === '\r' && text[i + 1] === '\n') i += 2;
			else i++;
			continue;
		}
		field += ch;
		i++;
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	if (rows.length === 0) return [];
	const header = rows[0]!;
	return rows.slice(1).map((cols) => {
		const obj: Record<string, string> = {};
		for (let c = 0; c < header.length; c++) obj[header[c]!] = cols[c] ?? '';
		return obj as Row;
	});
}

function ensureDirAndHeader(): void {
	if (!existsSync(CSV_DIR)) mkdirSync(CSV_DIR, { recursive: true });
	if (!existsSync(CSV_PATH)) {
		writeFileSync(CSV_PATH, COLUMNS.join(',') + '\n', 'utf8');
	}
}

function rowToLine(row: Row): string {
	return COLUMNS.map((col) => csvEscape(row[col] ?? '')).join(',') + '\n';
}

function readAllRows(): Row[] {
	if (!existsSync(CSV_PATH)) return [];
	try {
		return parseCsv(readFileSync(CSV_PATH, 'utf8'));
	} catch {
		return [];
	}
}

function writeAllRows(rows: Row[]): void {
	ensureDirAndHeader();
	const body = COLUMNS.join(',') + '\n' + rows.map(rowToLine).join('');
	writeFileSync(CSV_PATH, body, 'utf8');
}

function normaliseIncomingRow(input: Partial<Row>): Row {
	const now = String(Date.now());
	const out = {} as Row;
	for (const col of COLUMNS) out[col] = String(input[col] ?? '');
	if (!out.createdAt) out.createdAt = now;
	if (!out.updatedAt) out.updatedAt = now;
	return out;
}

/** GET — return all rows as JSON. Used by the Runs panel on load. */
export const GET: RequestHandler = async () => {
	if (!dev) throw error(403, 'Runs CSV only available in dev mode');
	return json({ rows: readAllRows() });
};

/**
 * POST — upsert a row (merge by `id`). Body: a partial Row.
 * This is called on experiment create, status change, and final completion.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!dev) throw error(403, 'Runs CSV only available in dev mode');
	let body: Partial<Row>;
	try {
		body = (await request.json()) as Partial<Row>;
	} catch {
		throw error(400, 'Invalid JSON');
	}
	if (!body.id) throw error(400, 'Missing id');

	ensureDirAndHeader();
	const existing = readAllRows();
	const idx = existing.findIndex((r) => r.id === body.id);
	const incoming = normaliseIncomingRow(body);

	if (idx === -1) {
		// New row — append.
		appendFileSync(CSV_PATH, rowToLine(incoming), 'utf8');
	} else {
		// Update: preserve createdAt, bump updatedAt, overlay new fields.
		const merged: Row = { ...existing[idx]!, ...incoming };
		merged.createdAt = existing[idx]!.createdAt || incoming.createdAt;
		merged.updatedAt = String(Date.now());
		existing[idx] = merged;
		writeAllRows(existing);
	}

	return json({ ok: true });
};

/** DELETE — remove a row by id (query param). */
export const DELETE: RequestHandler = async ({ url }) => {
	if (!dev) throw error(403, 'Runs CSV only available in dev mode');
	const id = url.searchParams.get('id');
	if (!id) throw error(400, 'Missing id');
	const rows = readAllRows().filter((r) => r.id !== id);
	writeAllRows(rows);
	return json({ ok: true });
};
