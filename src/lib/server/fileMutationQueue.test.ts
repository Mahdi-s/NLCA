import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { enqueueFileMutation, __resetFileMutationQueueForTests } from './fileMutationQueue.js';

beforeEach(() => {
	__resetFileMutationQueueForTests();
});

afterEach(() => {
	__resetFileMutationQueueForTests();
});

describe('enqueueFileMutation', () => {
	test('serializes mutations for the same file key', async () => {
		const events: string[] = [];

		const first = enqueueFileMutation('runs.csv', async () => {
			events.push('first:start');
			await Promise.resolve();
			events.push('first:end');
		});

		const second = enqueueFileMutation('runs.csv', async () => {
			events.push('second:start');
			events.push('second:end');
		});

		await Promise.all([first, second]);

		expect(events).toEqual([
			'first:start',
			'first:end',
			'second:start',
			'second:end'
		]);
	});

	test('continues processing later mutations after a failure', async () => {
		const events: string[] = [];

		await expect(
			enqueueFileMutation('frames.jsonl', async () => {
				events.push('first:start');
				throw new Error('boom');
			})
		).rejects.toThrow('boom');

		await enqueueFileMutation('frames.jsonl', async () => {
			events.push('second:start');
			events.push('second:end');
		});

		expect(events).toEqual(['first:start', 'second:start', 'second:end']);
	});

	test('allows independent file keys to proceed independently', async () => {
		const events: string[] = [];

		await Promise.all([
			enqueueFileMutation('a.json', async () => {
				events.push('a:start');
				await Promise.resolve();
				events.push('a:end');
			}),
			enqueueFileMutation('b.json', async () => {
				events.push('b:start');
				events.push('b:end');
			})
		]);

		expect(events).toContain('a:start');
		expect(events).toContain('a:end');
		expect(events).toContain('b:start');
		expect(events).toContain('b:end');
	});
});
