import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getNlcaStore, __resetNlcaStoreForTests } from './nlcaStore.svelte.js';

describe('nlcaStore hydration', () => {
    beforeEach(() => {
        __resetNlcaStoreForTests();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('setActive fast path — grid already in memory → ready', () => {
        const store = getNlcaStore();
        store.experiments['exp-fast'] = {
            id: 'exp-fast',
            label: 't',
            config: { gridWidth: 5, gridHeight: 5 } as never,
            status: 'paused',
            stepper: null,
            tape: null as never,
            frameBuffer: null,
            agentManager: null,
            progress: { current: 1, target: 10 },
            createdAt: 0,
            dbFilename: '/x.sqlite3',
            currentGrid: new Uint32Array(25),
            currentColorsHex: null,
            currentColorStatus8: null,
            currentGeneration: 1,
            bufferStatus: null,
            totalCost: 0,
            estimatedCost: 0,
            pricingUnknown: true,
            totalCalls: 0,
            lastLatencyMs: null
        };

        store.setActive('exp-fast');
        expect(store.activeId).toBe('exp-fast');
        expect(store.hydration['exp-fast']).toBe('ready');
    });

    test('setActive slow path — missing frame → missing', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false } as Response));
        const store = getNlcaStore();

        store.experiments['exp-slow'] = {
            id: 'exp-slow',
            label: 't',
            config: { gridWidth: 5, gridHeight: 5 } as never,
            status: 'paused',
            stepper: null,
            tape: null as never,
            frameBuffer: null,
            agentManager: null,
            progress: { current: 1, target: 10 },
            createdAt: 0,
            dbFilename: '/x.sqlite3',
            currentGrid: null,
            currentColorsHex: null,
            currentColorStatus8: null,
            currentGeneration: 0,
            bufferStatus: null,
            totalCost: 0,
            estimatedCost: 0,
            pricingUnknown: true,
            totalCalls: 0,
            lastLatencyMs: null
        };

        store.setActive('exp-slow');
        expect(store.hydration['exp-slow']).toBe('loading');

        await new Promise((r) => setTimeout(r, 10));
        expect(store.hydration['exp-slow']).toBe('missing');
    });

    test('setActive supersedes previous hydration when user clicks fast', async () => {
        let resolveFirst: (v: unknown) => void = () => {};
        const firstPromise = new Promise((r) => { resolveFirst = r; });
        const fetchMock = vi.fn()
            .mockReturnValueOnce(firstPromise)
            .mockResolvedValueOnce({ ok: false } as Response);
        vi.stubGlobal('fetch', fetchMock);

        const store = getNlcaStore();
        const mkExp = (id: string) => ({
            id, label: 't', config: { gridWidth: 5, gridHeight: 5 } as never,
            status: 'paused' as const, stepper: null, tape: null as never, frameBuffer: null,
            agentManager: null, progress: { current: 1, target: 10 }, createdAt: 0,
            dbFilename: '/x.sqlite3', currentGrid: null, currentColorsHex: null,
            currentColorStatus8: null, currentGeneration: 0, bufferStatus: null,
            totalCost: 0, estimatedCost: 0, pricingUnknown: true, totalCalls: 0,
            lastLatencyMs: null
        });
        store.experiments['a'] = mkExp('a');
        store.experiments['b'] = mkExp('b');

        store.setActive('a');
        store.setActive('b');
        expect(store.activeId).toBe('b');

        resolveFirst({
            ok: true,
            json: () => Promise.resolve({
                latest: { generation: 1, width: 5, height: 5, grid01: new Array(25).fill(0), colorsHex: null },
                frameCount: 1
            })
        });
        await new Promise((r) => setTimeout(r, 20));

        expect(store.hydration['a']).not.toBe('ready');
    });
});
