// Dynamic import to avoid SSR issues - only loads in browser
let sqlite3Promise: Promise<any> | null = null;

export function isCrossOriginIsolated(): boolean {
	// OPFS-backed worker mode requires COOP/COEP (crossOriginIsolated).
	return typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
}

export async function getSqlite3(): Promise<any> {
	if (typeof window === 'undefined') {
		throw new Error('SQLite can only be initialized in the browser');
	}
	if (!sqlite3Promise) {
		// Use main export - Vite will resolve to browser version via resolve.conditions
		const sqlite3InitModule = (await import('@sqlite.org/sqlite-wasm')).default;
		sqlite3Promise = sqlite3InitModule({
			print: () => {},
			printErr: (...args: unknown[]) => console.error('[sqlite]', ...args)
		});
	}
	return sqlite3Promise;
}


