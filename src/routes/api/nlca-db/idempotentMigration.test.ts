import { describe, expect, test } from 'vitest';
import { isIdempotentMigrationError } from './idempotentMigration.js';

describe('isIdempotentMigrationError', () => {
	test('matches "duplicate column name" — ALTER TABLE ADD COLUMN retry', () => {
		expect(
			isIdempotentMigrationError('SqliteError: duplicate column name: total_cost')
		).toBe(true);
	});

	test('matches "table X already exists" — CREATE TABLE without IF NOT EXISTS', () => {
		expect(isIdempotentMigrationError('SqliteError: table nlca_runs already exists')).toBe(true);
	});

	test('matches "index X already exists" — CREATE INDEX retry', () => {
		expect(
			isIdempotentMigrationError('SqliteError: index idx_nlca_frames_run_gen already exists')
		).toBe(true);
	});

	test('does NOT match UNIQUE constraint failures (those are real data errors)', () => {
		expect(
			isIdempotentMigrationError('SqliteError: UNIQUE constraint failed: experiments.id')
		).toBe(false);
	});

	test('does NOT match syntax errors', () => {
		expect(isIdempotentMigrationError('SqliteError: near "FOO": syntax error')).toBe(false);
	});

	test('does NOT match other runtime errors', () => {
		expect(isIdempotentMigrationError('SqliteError: no such table: whatever')).toBe(false);
		expect(isIdempotentMigrationError('')).toBe(false);
	});
});
