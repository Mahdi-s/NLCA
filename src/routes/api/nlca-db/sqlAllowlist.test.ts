import { describe, expect, test } from 'vitest';
import { rejectIfForbiddenSql } from './sqlAllowlist.js';

describe('rejectIfForbiddenSql — blocks hosted-deadly verbs', () => {
	test('blocks ATTACH DATABASE (the main documented attack)', () => {
		expect(rejectIfForbiddenSql("ATTACH DATABASE '/etc/passwd' AS pw")).toMatch(/ATTACH/);
	});

	test('blocks ATTACH inside a multi-statement exec payload', () => {
		const sql = `
			CREATE TABLE x (id INTEGER);
			ATTACH DATABASE '/tmp/bad.db' AS bad;
		`;
		expect(rejectIfForbiddenSql(sql)).toMatch(/ATTACH/);
	});

	test('blocks DETACH, VACUUM, BACKUP, LOAD_EXTENSION', () => {
		expect(rejectIfForbiddenSql('DETACH DATABASE x')).toMatch(/DETACH/);
		expect(rejectIfForbiddenSql('VACUUM INTO "/tmp/dump.db"')).toMatch(/VACUUM/);
		expect(rejectIfForbiddenSql('BACKUP DATABASE main TO "/tmp/x.db"')).toMatch(/BACKUP/);
		expect(rejectIfForbiddenSql('LOAD_EXTENSION("/tmp/x.so")')).toMatch(/LOAD_EXTENSION/);
	});

	test('blocks arbitrary PRAGMA (e.g. PRAGMA database_list)', () => {
		expect(rejectIfForbiddenSql('PRAGMA database_list')).toMatch(/PRAGMA/);
		expect(rejectIfForbiddenSql('PRAGMA writable_schema = 1')).toMatch(/PRAGMA/);
	});

	test('strips comments before parsing so commented-out attacks are ignored', () => {
		expect(rejectIfForbiddenSql('-- ATTACH\nSELECT 1')).toBeNull();
		expect(rejectIfForbiddenSql('/* ATTACH */\nSELECT 1')).toBeNull();
	});
});

describe('rejectIfForbiddenSql — allows legitimate application SQL', () => {
	test('CREATE TABLE / CREATE INDEX', () => {
		expect(
			rejectIfForbiddenSql('CREATE TABLE IF NOT EXISTS x (id INTEGER PRIMARY KEY)')
		).toBeNull();
		expect(rejectIfForbiddenSql('CREATE INDEX idx_foo ON x(id)')).toBeNull();
	});

	test('ALTER TABLE ADD COLUMN', () => {
		expect(rejectIfForbiddenSql('ALTER TABLE x ADD COLUMN foo TEXT')).toBeNull();
	});

	test('INSERT / SELECT / UPDATE / DELETE', () => {
		expect(rejectIfForbiddenSql('INSERT INTO x (id) VALUES (?)')).toBeNull();
		expect(rejectIfForbiddenSql('SELECT * FROM x WHERE id = ?')).toBeNull();
		expect(rejectIfForbiddenSql('UPDATE x SET foo = ? WHERE id = ?')).toBeNull();
		expect(rejectIfForbiddenSql('DELETE FROM x WHERE id = ?')).toBeNull();
	});

	test('allowlisted PRAGMAs pass (journal_mode, table_info)', () => {
		expect(rejectIfForbiddenSql('PRAGMA journal_mode = WAL')).toBeNull();
		expect(rejectIfForbiddenSql('PRAGMA table_info(nlca_runs)')).toBeNull();
	});

	test('empty / whitespace SQL is fine (exec might pass "")', () => {
		expect(rejectIfForbiddenSql('')).toBeNull();
		expect(rejectIfForbiddenSql('   \n\t  ')).toBeNull();
	});
});

describe('rejectIfForbiddenSql — input hygiene', () => {
	test('rejects non-string input', () => {
		// @ts-expect-error — intentional: guard should catch bad callers
		expect(rejectIfForbiddenSql(null)).toMatch(/string/);
		// @ts-expect-error
		expect(rejectIfForbiddenSql(123)).toMatch(/string/);
	});
});
