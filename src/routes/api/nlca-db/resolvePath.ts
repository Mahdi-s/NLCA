import { basename, join, resolve, sep } from 'path';

export const EXPERIMENTS_DIR = resolve(process.cwd(), 'experiments');

/** Experiment SQLite filenames follow this shape. */
const EXPERIMENT_FILE_RE = /^nlca-\d+-(.+)-\d+x\d+\.sqlite3$/;
const INDEX_FILENAME = 'nlca-index.sqlite3';

/**
 * Resolve a client-supplied virtual DB path to a safe on-disk location.
 *
 * Layered defense:
 *  1. `basename()` strips any directory component up-front, so
 *     `"/../../etc/passwd"` collapses to `"passwd"`.
 *  2. Filename must match the index-DB name OR the experiment shape; anything
 *     else is rejected outright (no ambiguous `'unknown'` fallback — that was
 *     the original vulnerability).
 *  3. After `join()`, assert the resolved path is still inside EXPERIMENTS_DIR.
 *     Catches any edge case the first two layers miss.
 */
export function resolveLocalPath(dbPath: string): string {
	if (typeof dbPath !== 'string') {
		throw new Error('Invalid dbPath (not a string)');
	}
	const safeName = basename(dbPath);
	if (!safeName || safeName === '.' || safeName === '..') {
		throw new Error(`Invalid dbPath filename: ${JSON.stringify(dbPath)}`);
	}

	let target: string;
	if (safeName === INDEX_FILENAME) {
		target = join(EXPERIMENTS_DIR, safeName);
	} else {
		const match = safeName.match(EXPERIMENT_FILE_RE);
		if (!match) {
			throw new Error(`dbPath does not match expected shape: ${JSON.stringify(dbPath)}`);
		}
		const modelSlug = match[1]!;
		target = join(EXPERIMENTS_DIR, modelSlug, safeName);
	}

	const resolved = resolve(target);
	if (!resolved.startsWith(EXPERIMENTS_DIR + sep) && resolved !== EXPERIMENTS_DIR) {
		throw new Error(`Resolved path escapes experiments dir: ${resolved}`);
	}
	return resolved;
}
