import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Experiment } from './experimentManager.svelte.js';
import * as persistence from './persistence.js';

type FetchArgs = Parameters<typeof fetch>;

describe('persistence.loadAllMeta', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('returns CSV rows when CSV endpoint succeeds', async () => {
        fetchMock.mockImplementation((url: FetchArgs[0]) => {
            const u = String(url);
            if (u.includes('/api/nlca-runs-csv')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        rows: [{ id: 'exp-1', label: 'From CSV', model: 'gpt', gridWidth: '10', gridHeight: '10', neighborhood: 'moore', frameCount: '5', targetFrames: '50', createdAt: '1000', totalCost: '0.01', status: 'paused', dbFilename: '/exp-1.sqlite3' }]
                    })
                } as Response);
            }
            return Promise.resolve({ ok: false } as Response);
        });

        const metas = await persistence.loadAllMeta();
        expect(metas).toHaveLength(1);
        expect(metas[0].id).toBe('exp-1');
        expect(metas[0].label).toBe('From CSV');
    });

    test('returns empty array when CSV endpoint fails', async () => {
        fetchMock.mockResolvedValue({ ok: false } as Response);
        const metas = await persistence.loadAllMeta();
        expect(metas).toEqual([]);
    });
});

describe('persistence.loadFrame', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('returns latest frame from JSONL when no generation given', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                latest: {
                    generation: 7,
                    width: 5,
                    height: 5,
                    grid01: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
                    colorsHex: null
                },
                frameCount: 7
            })
        } as Response);

        const frame = await persistence.loadFrame('exp-1');
        expect(frame).not.toBeNull();
        expect(frame!.generation).toBe(7);
        expect(frame!.width).toBe(5);
        expect(frame!.frameCount).toBe(7);
    });

    test('returns specific frame when generation given', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                frame: { generation: 3, width: 5, height: 5, grid01: new Array(25).fill(0), colorsHex: null },
                frameCount: 10
            })
        } as Response);

        const frame = await persistence.loadFrame('exp-1', 3);
        expect(frame!.generation).toBe(3);
        expect(frame!.frameCount).toBe(10);
    });

    test('returns null when fetch fails', async () => {
        fetchMock.mockResolvedValue({ ok: false } as Response);
        const frame = await persistence.loadFrame('exp-1');
        expect(frame).toBeNull();
    });
});

describe('persistence.syncMeta', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response);
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('posts to both CSV and JSONL endpoints (fire-and-forget)', async () => {
        const exp = {
            id: 'exp-1',
            label: 'Test',
            config: { apiProvider: 'openrouter' as const, model: 'm', gridWidth: 10, gridHeight: 10, neighborhood: 'moore' as const, cellColorEnabled: false, taskDescription: 't', useAdvancedMode: false, memoryWindow: 3, maxConcurrency: 50, batchSize: 200, frameBatched: true, frameStreamed: true, cellTimeoutMs: 30000, compressPayload: false, deduplicateRequests: false, targetFrames: 50, apiKey: '', sambaNovaApiKey: '', temperature: 0, maxOutputTokens: 64 },
            status: 'running' as const,
            progress: { current: 5, target: 50 },
            createdAt: 1000,
            dbFilename: '/exp-1.sqlite3',
            totalCost: 0.01
        } as unknown as Experiment;

        await persistence.syncMeta(exp);

        // Fire-and-forget, but the function should attempt both endpoints
        const urls = (fetchMock.mock.calls as FetchArgs[]).map((call) => String(call[0]));
        expect(urls.some((u: string) => u.includes('/api/nlca-runs-csv'))).toBe(true);
        expect(urls.some((u: string) => u.includes('/api/nlca-frames-jsonl'))).toBe(true);
    });
});
