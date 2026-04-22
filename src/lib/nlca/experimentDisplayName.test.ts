import { describe, expect, test } from 'vitest';
import { experimentDisplayName } from './experimentDisplayName.js';
import type { ExperimentConfig } from './types.js';

function mkConfig(overrides: Partial<ExperimentConfig> = {}): ExperimentConfig {
	return {
		apiProvider: 'openrouter',
		apiKey: '',
		sambaNovaApiKey: '',
		model: 'openai/gpt-4o-mini',
		temperature: 0,
		maxOutputTokens: 64,
		gridWidth: 10,
		gridHeight: 10,
		neighborhood: 'moore',
		cellColorEnabled: false,
		taskDescription: '',
		useAdvancedMode: false,
		memoryWindow: 0,
		maxConcurrency: 50,
		batchSize: 200,
		frameBatched: true,
		frameStreamed: true,
		cellTimeoutMs: 30_000,
		compressPayload: false,
		deduplicateRequests: false,
		targetFrames: 50,
		...overrides
	};
}

function mkExp(overrides: { id?: string; label?: string; config?: Partial<ExperimentConfig> } = {}) {
	return {
		id: overrides.id ?? 'exp-123456',
		label: overrides.label ?? '',
		config: mkConfig(overrides.config)
	};
}

describe('experimentDisplayName', () => {
	test('returns the preset name when promptPresetId matches a known preset', () => {
		const exp = mkExp({ config: { promptPresetId: 'face-robot' } });
		expect(experimentDisplayName(exp)).toBe('Face: Robot');
	});

	test('prefers the preset name over the stored label (so loaded experiments with old [SN]-prefixed labels still render cleanly)', () => {
		const exp = mkExp({
			label: '[SN] Together with your neighbors, paint a… · Llama-4-Maverick-17B-128E-Instruct · 50×50',
			config: { promptPresetId: 'face-baby', taskDescription: 'Together with your neighbors, paint a close-up portrait of a smiling baby.' }
		});
		expect(experimentDisplayName(exp)).toBe('Face: Baby');
	});

	test('falls back to the task description (truncated) when there is no preset', () => {
		const exp = mkExp({
			config: { taskDescription: 'A custom task written freehand by the user.' }
		});
		expect(experimentDisplayName(exp)).toBe('A custom task written freehand by the user.');
	});

	test('truncates long task descriptions with an ellipsis', () => {
		const longTask = 'A'.repeat(120);
		const exp = mkExp({ config: { taskDescription: longTask } });
		const out = experimentDisplayName(exp);
		expect(out.length).toBeLessThanOrEqual(60);
		expect(out.endsWith('…')).toBe(true);
	});

	test('uses only the first line of a multi-line task description', () => {
		const exp = mkExp({
			config: {
				taskDescription:
					'You are painting whatever\nHere is a bunch of additional context\nMore context below.'
			}
		});
		expect(experimentDisplayName(exp)).toBe('You are painting whatever');
	});

	test('falls back to the stored label when neither preset nor task is usable', () => {
		const exp = mkExp({ label: 'My Custom Label', config: { taskDescription: '' } });
		expect(experimentDisplayName(exp)).toBe('My Custom Label');
	});

	test('returns Exp <short-id> when nothing else is available', () => {
		const exp = mkExp({ id: 'abcdef-12345', label: '', config: { taskDescription: '' } });
		expect(experimentDisplayName(exp)).toBe('Exp abcdef');
	});

	test('ignores an unknown promptPresetId and uses the fallback chain', () => {
		const exp = mkExp({
			label: 'Kept Label',
			config: { promptPresetId: 'preset-that-was-deleted', taskDescription: 'task text' }
		});
		// Prefer stored label over the bare task when the preset lookup fails AND
		// the label looks human-curated (not an auto [SN]/[OR] prefix).
		expect(experimentDisplayName(exp)).toBe('Kept Label');
	});
});
