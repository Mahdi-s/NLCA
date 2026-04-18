// Use globalThis to survive Vite HMR module re-evaluation. A module-level variable
// resets to null on hot reload, causing a second sqlite3InitModule() call which fails
// because sqlite3.mjs already deleted globalThis.sqlite3InitModuleState in the first run.
const G = globalThis as typeof globalThis & { __nlcaSqlite3?: Promise<any> };

export function isCrossOriginIsolated(): boolean {
	return typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
}

export function getSqlite3(): Promise<any> {
	if (typeof window === 'undefined') {
		throw new Error('SQLite can only be initialized in the browser');
	}
	if (!G.__nlcaSqlite3) {
		// Assign before awaiting so concurrent callers share the same promise
		// and never call sqlite3InitModule() more than once (second call 404s
		// because globalThis.sqlite3InitModuleState is deleted on first call).
		G.__nlcaSqlite3 = import('@sqlite.org/sqlite-wasm').then((mod) =>
			mod.default({
				print: () => {},
				printErr: (...args: unknown[]) => console.error('[sqlite]', ...args)
			})
		);
	}
	return G.__nlcaSqlite3;
}


