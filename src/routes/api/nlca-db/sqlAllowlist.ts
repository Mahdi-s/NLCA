/**
 * SQL allowlist for the nlca-db proxy. This is a stopgap defense that closes
 * the documented attack vectors (ATTACH DATABASE, DETACH DATABASE, arbitrary
 * PRAGMA) against the client→server raw-SQL transport. It is NOT a substitute
 * for full typed RPC, which remains a follow-up migration.
 *
 * We strip comments, upper-case the statement, and reject forbidden leading
 * verbs. PRAGMA is allowlisted only for read-only introspection statements
 * we know the client legitimately needs.
 */

const FORBIDDEN_LEADING_VERBS = [
	'ATTACH',
	'DETACH',
	'VACUUM',
	'BACKUP',
	'LOAD_EXTENSION',
	'PRAGMA'
] as const;

/** PRAGMA statements the client is allowed to issue. Keep this set tight. */
const ALLOWED_PRAGMAS = new Set([
	'JOURNAL_MODE',
	'TABLE_INFO',
	'FOREIGN_KEYS',
	'INTEGRITY_CHECK'
]);

function stripComments(sql: string): string {
	// Remove /* block */ comments.
	let s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
	// Remove -- line comments.
	s = s.replace(/--[^\n]*/g, ' ');
	return s;
}

function normalize(sql: string): string {
	return stripComments(sql).trim();
}

/**
 * Return null when the SQL is allowed; a rejection reason otherwise.
 * Handles multi-statement `exec` payloads by checking each statement.
 */
export function rejectIfForbiddenSql(sql: string): string | null {
	if (typeof sql !== 'string') return 'sql must be a string';
	const normalized = normalize(sql);
	if (!normalized) return null; // no-op is fine

	// Split on `;` to catch multi-statement exec payloads. This isn't a full
	// parser — string literals containing `;` will falsely trigger extra
	// statements — but since ALL our reject logic is "does this start with
	// a forbidden verb?" the worst-case is a false positive on exotic SQL,
	// which we'd rather take than a false negative.
	const statements = normalized.split(';').map((s) => s.trim()).filter(Boolean);

	for (const stmt of statements) {
		const upper = stmt.toUpperCase();
		for (const verb of FORBIDDEN_LEADING_VERBS) {
			if (upper.startsWith(verb)) {
				if (verb === 'PRAGMA') {
					// PRAGMA <name> (args?) — accept only the allowlisted subset.
					const m = upper.match(/^PRAGMA\s+([A-Z_]+)/);
					const pragma = m?.[1] ?? '';
					if (ALLOWED_PRAGMAS.has(pragma)) continue;
					return `PRAGMA ${pragma || '<empty>'} is not allowed`;
				}
				return `${verb} statements are not allowed via this proxy`;
			}
		}
	}

	return null;
}
