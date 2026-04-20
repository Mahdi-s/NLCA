import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// Workspace packages export TS entrypoints (./src/index.ts). For SSR dev,
	// we must ensure Vite bundles/transpiles them instead of Node trying to load
	// raw `.ts` (which causes ERR_UNKNOWN_FILE_EXTENSION).
	ssr: {
		noExternal: ['@games-of-life/core', '@games-of-life/webgpu', '@games-of-life/svelte', '@games-of-life/audio'],
		external: ['@sqlite.org/sqlite-wasm', 'better-sqlite3']
	},
	resolve: {
		// Prefer browser exports; keep `development` so esm-env picks its
		// `./true.js` branch (→ dev=true via $app/environment). Without this,
		// esm-env falls through to its dev-fallback, which reads
		// globalThis.process.env.NODE_ENV — undefined in the browser — and
		// returns undefined. That makes $app/environment's `dev` falsy even
		// under `npm run dev`, routing SQLite-backed persistence to the
		// browser sqlite-wasm loader instead of the dev-only ServerDbHandle
		// HTTP API. Browser sqlite-wasm init hangs indefinitely when OPFS
		// isn't available, so the whole experiment index load blocks forever.
		conditions: ['browser', 'development', 'import', 'module', 'default']
	},
	server: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp'
		},
		fs: {
			// Allow importing workspace packages from /packages during local dev.
			// Without this, Vite may block requests as "outside of Vite serving allow list".
			allow: [path.resolve(__dirname, 'packages'), path.resolve(__dirname)]
		}
	},
	preview: {
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp'
		}
	},
	optimizeDeps: {
		exclude: ['@sqlite.org/sqlite-wasm']
	},
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts']
	}
});
