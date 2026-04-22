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
            viewGrid: null,
            viewGeneration: 0,
            autoFollow: true,
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
            viewGrid: null,
            viewGeneration: 0,
            autoFollow: true,
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
            currentColorStatus8: null, currentGeneration: 0, viewGrid: null, viewGeneration: 0, autoFollow: true, bufferStatus: null,
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

describe('nlcaStore seek race', () => {
    beforeEach(() => {
        __resetNlcaStoreForTests();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test('setViewGeneration supersedes a stale in-flight response', async () => {
        const store = getNlcaStore();

        // Two resolvers we control: the "slow" frame 10 response completes AFTER the
        // "fast" frame 20 response. A naive impl would let frame 10 overwrite frame 20.
        let resolveSlow: (v: unknown) => void = () => {};
        const slowPromise = new Promise((r) => { resolveSlow = r; });
        let resolveFast: (v: unknown) => void = () => {};
        const fastPromise = new Promise((r) => { resolveFast = r; });

        const tape = {
            getFrame: vi.fn()
                .mockReturnValueOnce(slowPromise)
                .mockReturnValueOnce(fastPromise)
        };

        store.experiments['scrub'] = {
            id: 'scrub', label: 't', config: { gridWidth: 5, gridHeight: 5 } as never,
            status: 'paused' as const, stepper: null, tape: tape as never, frameBuffer: null,
            agentManager: null, progress: { current: 100, target: 100 }, createdAt: 0,
            dbFilename: '/x.sqlite3', currentGrid: new Uint32Array(25),
            currentColorsHex: null, currentColorStatus8: null, currentGeneration: 100,
            viewGrid: null, viewGeneration: 0, autoFollow: true, bufferStatus: null,
            totalCost: 0, estimatedCost: 0, pricingUnknown: true,
            totalCalls: 0, lastLatencyMs: null
        };

        // Scrub backward in two rapid pointer moves: 10, then 20.
        const slowCall = store.setViewGeneration('scrub', 10);
        const fastCall = store.setViewGeneration('scrub', 20);

        // Fast resolves first (frame 20). Viewport should jump to 20.
        resolveFast({ stateBits: new Uint8Array(Math.ceil(25 / 8)), colorsHex: null });
        await fastCall;
        expect(store.experiments['scrub'].viewGeneration).toBe(20);

        // Slow resolves later (frame 10). Viewport must NOT regress.
        resolveSlow({ stateBits: new Uint8Array(Math.ceil(25 / 8)), colorsHex: null });
        await slowCall;
        expect(store.experiments['scrub'].viewGeneration).toBe(20);
    });
});

describe('nlcaStore LRU cache', () => {
    beforeEach(() => {
        __resetNlcaStoreForTests();
    });

    test('evicts oldest non-pinned experiment when budget exceeded', () => {
        const store = getNlcaStore();
        const mkExp = (id: string) => ({
            id, label: id, config: { gridWidth: 5, gridHeight: 5 } as never,
            status: 'paused' as const, stepper: null, tape: null as never, frameBuffer: null,
            agentManager: null, progress: { current: 1, target: 10 }, createdAt: 0,
            dbFilename: `/${id}.sqlite3`, currentGrid: new Uint32Array(25),
            currentColorsHex: null, currentColorStatus8: null, currentGeneration: 1, viewGrid: null, viewGeneration: 0, autoFollow: true,
            bufferStatus: null, totalCost: 0, estimatedCost: 0, pricingUnknown: true,
            totalCalls: 0, lastLatencyMs: null
        });

        for (let i = 1; i <= 7; i++) {
            store.experiments[`e${i}`] = mkExp(`e${i}`);
        }

        for (let i = 1; i <= 7; i++) {
            store.setActive(`e${i}`);
        }

        // Active = e7, budget = 5 evictable. e1..e6 all have currentGrid, but only 5 can stay.
        // Oldest-accessed (e1) is evicted.
        expect(store.experiments['e7'].currentGrid).not.toBeNull();
        const evictedCount = [1, 2, 3, 4, 5, 6].filter(
            (i) => store.experiments[`e${i}`].currentGrid === null
        ).length;
        expect(evictedCount).toBe(1);
        expect(store.experiments['e1'].currentGrid).toBeNull();
    });

    test('disposes the evicted experiment stepper so its internal buffers are released', () => {
        const store = getNlcaStore();
        const disposeSpies: Record<string, ReturnType<typeof vi.fn>> = {};
        const mkExp = (id: string) => {
            disposeSpies[id] = vi.fn();
            const mockStepper = { dispose: disposeSpies[id], isDisposed: false } as never;
            return {
                id, label: id, config: { gridWidth: 5, gridHeight: 5 } as never,
                status: 'paused' as const, stepper: mockStepper, tape: null as never, frameBuffer: null,
                agentManager: null, progress: { current: 1, target: 10 }, createdAt: 0,
                dbFilename: `/${id}.sqlite3`, currentGrid: new Uint32Array(25),
                currentColorsHex: null, currentColorStatus8: null, currentGeneration: 1, viewGrid: null, viewGeneration: 0, autoFollow: true,
                bufferStatus: null, totalCost: 0, estimatedCost: 0, pricingUnknown: true,
                totalCalls: 0, lastLatencyMs: null
            };
        };

        for (let i = 1; i <= 7; i++) {
            store.experiments[`e${i}`] = mkExp(`e${i}`);
        }

        for (let i = 1; i <= 7; i++) {
            store.setActive(`e${i}`);
        }

        // e1 should be the LRU victim — its stepper was disposed and nulled.
        expect(disposeSpies['e1']).toHaveBeenCalledTimes(1);
        expect(store.experiments['e1'].stepper).toBeNull();
        // e7 (active) keeps its stepper.
        expect(store.experiments['e7'].stepper).not.toBeNull();
        expect(disposeSpies['e7']).not.toHaveBeenCalled();
    });

    test('never evicts running experiments even if past budget', () => {
        const store = getNlcaStore();
        const mkRunning = (id: string) => ({
            id, label: id, config: { gridWidth: 5, gridHeight: 5 } as never,
            status: 'running' as const, stepper: null, tape: null as never, frameBuffer: null,
            agentManager: null, progress: { current: 1, target: 10 }, createdAt: 0,
            dbFilename: `/${id}.sqlite3`, currentGrid: new Uint32Array(25),
            currentColorsHex: null, currentColorStatus8: null, currentGeneration: 1, viewGrid: null, viewGeneration: 0, autoFollow: true,
            bufferStatus: null, totalCost: 0, estimatedCost: 0, pricingUnknown: true,
            totalCalls: 0, lastLatencyMs: null
        });

        for (let i = 1; i <= 8; i++) {
            store.experiments[`r${i}`] = mkRunning(`r${i}`);
            store.setActive(`r${i}`);
        }

        // All running → all pinned → none evicted.
        for (let i = 1; i <= 8; i++) {
            expect(store.experiments[`r${i}`].currentGrid).not.toBeNull();
        }
    });
});
