/**
 * nlcaStore — module-level singleton that owns all NLCA session state.
 *
 * Pattern matches simulation.svelte.ts and modalManager.svelte.ts — import the
 * accessor, get the same instance everywhere. Replaces the
 * new-ExperimentManager-inside-a-component pattern.
 */

import { ExperimentManager } from '$lib/nlca/experimentManager.svelte.js';

let instance: ExperimentManager | null = null;

export function getNlcaStore(): ExperimentManager {
    if (!instance) instance = new ExperimentManager();
    return instance;
}

/** Test-only: reset the singleton between tests. Do not call from app code. */
export function __resetNlcaStoreForTests(): void {
    instance = null;
}
