import type { ApiProvider, NlcaNeighborhood } from '$lib/nlca/types.js';

type SparseContextMode = 'off' | 'skip-dead-interior';

type NlcaSettingsSnapshot = {
	apiProvider: ApiProvider;
	apiKey: string;
	sambaNovaApiKey: string;
	model: string;
	maxConcurrency: number;
	batchSize: number;
	frameBatched: boolean;
	frameStreamed: boolean;
	memoryWindow: number;
	neighborhood: NlcaNeighborhood;
	gridWidth: number;
	gridHeight: number;
	targetFrames: number;
	sparseContextMode: SparseContextMode;
};

const STORAGE_KEYS = {
	apiProvider: 'nlca_api_provider',
	apiKey: 'nlca_openrouter_api_key',
	sambaNovaApiKey: 'nlca_sambanova_api_key',
	model: 'nlca_model',
	maxConcurrency: 'nlca_max_concurrency',
	batchSize: 'nlca_batch_size',
	frameBatched: 'nlca_frame_batched',
	frameStreamed: 'nlca_frame_streamed',
	memoryWindow: 'nlca_memory_window',
	neighborhood: 'nlca_neighborhood',
	gridWidth: 'nlca_grid_width',
	gridHeight: 'nlca_grid_height',
	targetFrames: 'nlca_target_frames',
	sparseContextMode: 'nlca_sparse_context_mode'
} as const;

const SAMBANOVA_DEFAULT_MODEL = 'Meta-Llama-3.3-70B-Instruct';
const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';

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

function parseProvider(value: string | null, fallback: ApiProvider): ApiProvider {
	if (value === 'openrouter' || value === 'sambanova') return value;
	return fallback;
}

function parseSparseMode(value: string | null, fallback: SparseContextMode): SparseContextMode {
	if (value === 'off' || value === 'skip-dead-interior') return value;
	return fallback;
}

let initialized = false;

let apiProvider = $state<ApiProvider>('openrouter');
let apiKey = $state('');
let sambaNovaApiKey = $state('');
let model = $state(OPENROUTER_DEFAULT_MODEL);
let maxConcurrency = $state(50);
let batchSize = $state(200);
let frameBatched = $state(true);
let frameStreamed = $state(true);
let memoryWindow = $state(3);
let neighborhood = $state<NlcaNeighborhood>('moore');
let gridWidth = $state(10);
let gridHeight = $state(10);
let targetFrames = $state(50);
let sparseContextMode = $state<SparseContextMode>('off');

function ensureInitialized() {
	if (initialized) return;
	initialized = true;

	const envApiKey = import.meta.env.VITE_NLCA_OPENROUTER_API_KEY ?? '';
	const envSambaKey = import.meta.env.VITE_NLCA_SAMBANOVA_API_KEY ?? '';
	const envModel = import.meta.env.VITE_NLCA_MODEL ?? OPENROUTER_DEFAULT_MODEL;

	apiKey = envApiKey;
	sambaNovaApiKey = envSambaKey;
	model = envModel;

	apiProvider = parseProvider(safeReadStorage(STORAGE_KEYS.apiProvider), 'openrouter');

	const storedApiKey = safeReadStorage(STORAGE_KEYS.apiKey);
	if (typeof storedApiKey === 'string') apiKey = storedApiKey;

	const storedSambaKey = safeReadStorage(STORAGE_KEYS.sambaNovaApiKey);
	if (typeof storedSambaKey === 'string') sambaNovaApiKey = storedSambaKey;

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
	targetFrames = clampInt(Number(safeReadStorage(STORAGE_KEYS.targetFrames) ?? '50'), 1, 10000, 50);
	sparseContextMode = parseSparseMode(safeReadStorage(STORAGE_KEYS.sparseContextMode), 'off');
}

export function getNlcaSettingsState() {
	ensureInitialized();

	return {
		get apiProvider() {
			return apiProvider;
		},
		set apiProvider(value: ApiProvider) {
			const prev = apiProvider;
			apiProvider = parseProvider(value, 'openrouter');
			safeWriteStorage(STORAGE_KEYS.apiProvider, apiProvider);
			// When switching providers, swap the default model if the current one
			// clearly belongs to the other provider's namespace.
			if (prev !== apiProvider) {
				if (apiProvider === 'sambanova' && model.includes('/')) {
					model = SAMBANOVA_DEFAULT_MODEL;
					safeWriteStorage(STORAGE_KEYS.model, model);
				} else if (apiProvider === 'openrouter' && !model.includes('/')) {
					model = OPENROUTER_DEFAULT_MODEL;
					safeWriteStorage(STORAGE_KEYS.model, model);
				}
			}
		},

		get apiKey() {
			return apiKey;
		},
		set apiKey(value: string) {
			apiKey = value ?? '';
			safeWriteStorage(STORAGE_KEYS.apiKey, apiKey);
		},

		get sambaNovaApiKey() {
			return sambaNovaApiKey;
		},
		set sambaNovaApiKey(value: string) {
			sambaNovaApiKey = value ?? '';
			safeWriteStorage(STORAGE_KEYS.sambaNovaApiKey, sambaNovaApiKey);
		},

		get model() {
			return model;
		},
		set model(value: string) {
			const fallback = apiProvider === 'sambanova' ? SAMBANOVA_DEFAULT_MODEL : OPENROUTER_DEFAULT_MODEL;
			model = (value ?? '').trim() || fallback;
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
			gridWidth = clampInt(value, 8, 2048, 10);
			safeWriteStorage(STORAGE_KEYS.gridWidth, String(gridWidth));
		},

		get gridHeight() {
			return gridHeight;
		},
		set gridHeight(value: number) {
			gridHeight = clampInt(value, 8, 2048, 10);
			safeWriteStorage(STORAGE_KEYS.gridHeight, String(gridHeight));
		},

		get targetFrames() {
			return targetFrames;
		},
		set targetFrames(value: number) {
			targetFrames = clampInt(value, 1, 10000, 50);
			safeWriteStorage(STORAGE_KEYS.targetFrames, String(targetFrames));
		},

		get sparseContextMode() {
			return sparseContextMode;
		},
		set sparseContextMode(value: SparseContextMode) {
			sparseContextMode = parseSparseMode(value, 'off');
			safeWriteStorage(STORAGE_KEYS.sparseContextMode, sparseContextMode);
		},

		toJSON(): NlcaSettingsSnapshot {
			return {
				apiProvider,
				apiKey,
				sambaNovaApiKey,
				model,
				maxConcurrency,
				batchSize,
				frameBatched,
				frameStreamed,
				memoryWindow,
				neighborhood,
				gridWidth,
				gridHeight,
				targetFrames,
				sparseContextMode
			};
		}
	};
}
