import type { NlcaNeighborhood } from '$lib/nlca/types.js';

type NlcaSettingsSnapshot = {
	apiKey: string;
	model: string;
	maxConcurrency: number;
	batchSize: number;
	frameBatched: boolean;
	frameStreamed: boolean;
	memoryWindow: number;
	neighborhood: NlcaNeighborhood;
	gridWidth: number;
	gridHeight: number;
};

const STORAGE_KEYS = {
	apiKey: 'nlca_openrouter_api_key',
	model: 'nlca_model',
	maxConcurrency: 'nlca_max_concurrency',
	batchSize: 'nlca_batch_size',
	frameBatched: 'nlca_frame_batched',
	frameStreamed: 'nlca_frame_streamed',
	memoryWindow: 'nlca_memory_window',
	neighborhood: 'nlca_neighborhood',
	gridWidth: 'nlca_grid_width',
	gridHeight: 'nlca_grid_height'
} as const;

function safeReadStorage(key: string): string | null {
	if (typeof window === 'undefined') return null;
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeWriteStorage(key: string, value: string): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// ignore
	}
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseBool(value: string | null, fallback: boolean): boolean {
	if (value === null) return fallback;
	return value !== 'false';
}

function parseNeighborhood(value: string | null, fallback: NlcaNeighborhood): NlcaNeighborhood {
	if (value === 'moore' || value === 'vonNeumann' || value === 'extendedMoore') return value;
	return fallback;
}

let initialized = false;

let apiKey = $state('');
let model = $state('openai/gpt-4o-mini');
let maxConcurrency = $state(50);
let batchSize = $state(200);
let frameBatched = $state(true);
let frameStreamed = $state(true);
let memoryWindow = $state(3);
let neighborhood = $state<NlcaNeighborhood>('moore');
let gridWidth = $state(10);
let gridHeight = $state(10);

function ensureInitialized() {
	if (initialized) return;
	initialized = true;

	const envApiKey = import.meta.env.VITE_NLCA_OPENROUTER_API_KEY ?? '';
	const envModel = import.meta.env.VITE_NLCA_MODEL ?? 'openai/gpt-4o-mini';

	apiKey = envApiKey;
	model = envModel;

	const storedApiKey = safeReadStorage(STORAGE_KEYS.apiKey);
	if (typeof storedApiKey === 'string') apiKey = storedApiKey;

	const storedModel = safeReadStorage(STORAGE_KEYS.model);
	if (typeof storedModel === 'string' && storedModel.trim().length > 0) model = storedModel;

	maxConcurrency = clampInt(Number(safeReadStorage(STORAGE_KEYS.maxConcurrency) ?? '50'), 1, 200, 50);
	batchSize = clampInt(Number(safeReadStorage(STORAGE_KEYS.batchSize) ?? '200'), 1, 2000, 200);
	frameBatched = parseBool(safeReadStorage(STORAGE_KEYS.frameBatched), true);
	frameStreamed = parseBool(safeReadStorage(STORAGE_KEYS.frameStreamed), true);
	memoryWindow = clampInt(Number(safeReadStorage(STORAGE_KEYS.memoryWindow) ?? '3'), 0, 16, 3);
	neighborhood = parseNeighborhood(safeReadStorage(STORAGE_KEYS.neighborhood), 'moore');
	gridWidth = clampInt(Number(safeReadStorage(STORAGE_KEYS.gridWidth) ?? '10'), 8, 512, 10);
	gridHeight = clampInt(Number(safeReadStorage(STORAGE_KEYS.gridHeight) ?? '10'), 8, 512, 10);
}

export function getNlcaSettingsState() {
	ensureInitialized();

	return {
		get apiKey() {
			return apiKey;
		},
		set apiKey(value: string) {
			apiKey = value ?? '';
			safeWriteStorage(STORAGE_KEYS.apiKey, apiKey);
		},

		get model() {
			return model;
		},
		set model(value: string) {
			model = (value ?? '').trim() || 'openai/gpt-4o-mini';
			safeWriteStorage(STORAGE_KEYS.model, model);
		},

		get maxConcurrency() {
			return maxConcurrency;
		},
		set maxConcurrency(value: number) {
			maxConcurrency = clampInt(value, 1, 200, 50);
			safeWriteStorage(STORAGE_KEYS.maxConcurrency, String(maxConcurrency));
		},

		get batchSize() {
			return batchSize;
		},
		set batchSize(value: number) {
			batchSize = clampInt(value, 1, 2000, 200);
			safeWriteStorage(STORAGE_KEYS.batchSize, String(batchSize));
		},

		get frameBatched() {
			return frameBatched;
		},
		set frameBatched(value: boolean) {
			frameBatched = !!value;
			safeWriteStorage(STORAGE_KEYS.frameBatched, frameBatched ? 'true' : 'false');
			// Streaming only makes sense in frame-batched mode.
			if (!frameBatched) {
				frameStreamed = false;
				safeWriteStorage(STORAGE_KEYS.frameStreamed, 'false');
			}
		},

		get frameStreamed() {
			return frameStreamed;
		},
		set frameStreamed(value: boolean) {
			frameStreamed = !!value;
			safeWriteStorage(STORAGE_KEYS.frameStreamed, frameStreamed ? 'true' : 'false');
		},

		get memoryWindow() {
			return memoryWindow;
		},
		set memoryWindow(value: number) {
			memoryWindow = clampInt(value, 0, 16, 3);
			safeWriteStorage(STORAGE_KEYS.memoryWindow, String(memoryWindow));
		},

		get neighborhood() {
			return neighborhood;
		},
		set neighborhood(value: NlcaNeighborhood) {
			neighborhood = parseNeighborhood(value, 'moore');
			safeWriteStorage(STORAGE_KEYS.neighborhood, neighborhood);
		},

		get gridWidth() {
			return gridWidth;
		},
		set gridWidth(value: number) {
			gridWidth = clampInt(value, 8, 512, 10);
			safeWriteStorage(STORAGE_KEYS.gridWidth, String(gridWidth));
		},

		get gridHeight() {
			return gridHeight;
		},
		set gridHeight(value: number) {
			gridHeight = clampInt(value, 8, 512, 10);
			safeWriteStorage(STORAGE_KEYS.gridHeight, String(gridHeight));
		},

		toJSON(): NlcaSettingsSnapshot {
			return {
				apiKey,
				model,
				maxConcurrency,
				batchSize,
				frameBatched,
				frameStreamed,
				memoryWindow,
				neighborhood,
				gridWidth,
				gridHeight
			};
		}
	};
}
