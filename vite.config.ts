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
		external: ['@sqlite.org/sqlite-wasm']
	},
	resolve: {
		// Prefer browser exports over Node.js exports
		conditions: ['browser', 'import', 'module', 'default']
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
