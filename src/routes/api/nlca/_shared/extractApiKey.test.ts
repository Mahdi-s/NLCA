import { describe, expect, test, vi } from 'vitest';
import { extractApiKey } from './extractApiKey.js';

function mkRequest(headers: Record<string, string> = {}): Request {
	return new Request('http://test/', { headers });
}

describe('extractApiKey', () => {
	test('reads Bearer token from Authorization header', () => {
		const req = mkRequest({ authorization: 'Bearer sk-or-abc123' });
		expect(extractApiKey(req, null)).toBe('sk-or-abc123');
	});

	test('is case-insensitive on the Bearer prefix', () => {
		const req = mkRequest({ authorization: 'bearer sk-or-abc123' });
		expect(extractApiKey(req, null)).toBe('sk-or-abc123');
	});

	test('trims whitespace around the token', () => {
		const req = mkRequest({ authorization: 'Bearer   sk-or-xyz   ' });
		expect(extractApiKey(req, null)).toBe('sk-or-xyz');
	});

	test('falls back to body apiKey and logs a deprecation warning', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const req = mkRequest();
		const key = extractApiKey(req, { apiKey: 'sk-legacy' });
		expect(key).toBe('sk-legacy');
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	test('prefers header over body when both are present', () => {
		const req = mkRequest({ authorization: 'Bearer sk-header' });
		expect(extractApiKey(req, { apiKey: 'sk-body' })).toBe('sk-header');
	});

	test('returns empty string when neither header nor body has a key', () => {
		expect(extractApiKey(mkRequest(), null)).toBe('');
		expect(extractApiKey(mkRequest(), { apiKey: '' })).toBe('');
	});
});
