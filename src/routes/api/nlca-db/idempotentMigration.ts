/**
 * Detect SQLite errors that come from idempotent schema migrations —
 * the client re-issues `ALTER TABLE ADD COLUMN` / `CREATE TABLE` on every
 * init so that older DBs catch up to the current schema. When the column
 * or table already exists the migration is a no-op, but SQLite still
 * throws. These errors aren't real failures; treating them as a 500 just
 * pollutes the server log and the browser devtools network tab.
 */
export function isIdempotentMigrationError(message: string): boolean {
	if (!message) return false;
	return (
		/duplicate column name/i.test(message) ||
		/table .* already exists/i.test(message) ||
		/index .* already exists/i.test(message)
	);
}
