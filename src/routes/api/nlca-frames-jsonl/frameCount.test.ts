import { describe, expect, test } from 'vitest';
import { deriveFrameCount } from './frameCount.js';

describe('deriveFrameCount', () => {
	test('prefers meta progress when available', () => {
		expect(
			deriveFrameCount(
				{ progress: { current: 12 } },
				{ generation: 10 }
			)
		).toBe(12);
	});

	test('falls back to latest generation when meta progress is missing', () => {
		expect(deriveFrameCount(null, { generation: 7 })).toBe(7);
		expect(deriveFrameCount({}, { generation: 3 })).toBe(3);
	});

	test('returns 0 when neither meta progress nor latest generation exists', () => {
		expect(deriveFrameCount(null, null)).toBe(0);
		expect(deriveFrameCount({}, null)).toBe(0);
	});
});
