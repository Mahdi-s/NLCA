<script lang="ts">
	import { onMount } from 'svelte';
	import { draggable } from '$lib/utils/draggable.js';
	import { bringToFront, setModalPosition, getModalState } from '$lib/stores/modalManager.svelte.js';
	import { getSimulationState } from '$lib/stores/simulation.svelte.js';
	import type { NlcaNeighborhood } from '$lib/nlca/types.js';
	import { getNlcaSettingsState } from '$lib/stores/nlcaSettings.svelte.js';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();
	const modalState = $derived(getModalState('nlcaSettings'));
	const simState = getSimulationState();
	const nlcaSettings = getNlcaSettingsState();

	let apiKey = $state('');
	let model = $state('openai/gpt-4o-mini');
	let maxConcurrency = $state(50);
	let batchSize = $state(200);
	let frameBatched = $state(true);
	let frameStreamed = $state(true);
	let memoryWindow = $state(3);
	let gridWidth = $state(25);
	let gridHeight = $state(25);
	let neighborhood = $state<NlcaNeighborhood>('moore');

	onMount(() => {
		apiKey = nlcaSettings.apiKey;
		model = nlcaSettings.model;
		maxConcurrency = nlcaSettings.maxConcurrency;
		batchSize = nlcaSettings.batchSize;
		frameBatched = nlcaSettings.frameBatched;
		frameStreamed = nlcaSettings.frameStreamed;
		memoryWindow = nlcaSettings.memoryWindow;
		neighborhood = nlcaSettings.neighborhood;

		// Default to 10x10 for NLCA, or current sim dimensions if already set.
		if (simState.gridWidth === 0 || simState.gridHeight === 0) {
			gridWidth = nlcaSettings.gridWidth;
			gridHeight = nlcaSettings.gridHeight;
		} else {
			gridWidth = simState.gridWidth;
			gridHeight = simState.gridHeight;
		}
	});

	function handleModalClick() {
		bringToFront('nlcaSettings');
	}
	function handleDragEnd(position: { x: number; y: number }) {
		setModalPosition('nlcaSettings', position);
	}
	function runBenchmark() {
		window.dispatchEvent(new CustomEvent('nlca-benchmark', { detail: { width: 30, height: 30, frames: 5 } }));
		onclose();
	}
	function save() {
		nlcaSettings.apiKey = apiKey;
		nlcaSettings.model = model;
		nlcaSettings.maxConcurrency = maxConcurrency;
		nlcaSettings.batchSize = batchSize;
		nlcaSettings.frameBatched = frameBatched;
		nlcaSettings.frameStreamed = frameBatched ? frameStreamed : false;
		nlcaSettings.memoryWindow = memoryWindow;
		nlcaSettings.neighborhood = neighborhood;
		nlcaSettings.gridWidth = gridWidth;
		nlcaSettings.gridHeight = gridHeight;

		onclose();
	}
</script>

<div class="modal-backdrop" role="presentation" style="z-index: {modalState.zIndex};">
	<div
		class="modal"
		role="dialog"
		aria-label="NLCA Settings"
		tabindex="0"
		use:draggable={{ onDragEnd: handleDragEnd }}
		onclick={handleModalClick}
		onkeydown={() => {}}
		style={modalState.position ? `transform: translate(${modalState.position.x}px, ${modalState.position.y}px);` : ''}
	>
		<div class="header">
			<h3>NLCA Settings</h3>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</div>

		<div class="content">
			<label>
				<span>OpenRouter API Key</span>
				<input type="password" bind:value={apiKey} placeholder="sk-or-..." />
			</label>
			<label>
				<span>Model</span>
				<input type="text" bind:value={model} />
			</label>
			<label>
				<span>Neighborhood</span>
				<select bind:value={neighborhood}>
					<option value="moore">Moore (8)</option>
					<option value="vonNeumann">Von Neumann (4)</option>
					<option value="extendedMoore">Extended Moore (24)</option>
				</select>
			</label>
			<label>
				<span>Max Concurrency</span>
				<input type="number" min="1" max="200" bind:value={maxConcurrency} />
				<small style="color: var(--ui-text); opacity: 0.7;">Parallel LLM calls (higher = faster but more rate limits)</small>
			</label>
			<label>
				<span>Batch size (cell-mode)</span>
				<input type="number" min="1" max="2000" bind:value={batchSize} />
				<small style="color: var(--ui-text); opacity: 0.7;">Cells per proxy request when frame-batched mode is off</small>
			</label>
			<label>
				<span>Frame-batched mode (one OpenRouter call per frame)</span>
				<input type="checkbox" bind:checked={frameBatched} />
				<small style="color: var(--ui-text); opacity: 0.7;">Fastest for 30×30; uses structured outputs</small>
			</label>
			<label>
				<span>Stream frame updates (SSE)</span>
				<input type="checkbox" bind:checked={frameStreamed} disabled={!frameBatched} />
				<small style="color: var(--ui-text); opacity: 0.7;">Progressive updates while waiting (requires frame-batched mode)</small>
			</label>
			<label>
				<span>Memory window (frame-batched)</span>
				<input type="number" min="0" max="16" bind:value={memoryWindow} />
				<small style="color: var(--ui-text); opacity: 0.7;">Per-cell history length included in prompts (0 = stateless)</small>
			</label>
			<div class="row">
				<label>
					<span>Grid width</span>
					<input type="number" min="8" max="512" bind:value={gridWidth} />
				</label>
				<label>
					<span>Grid height</span>
					<input type="number" min="8" max="512" bind:value={gridHeight} />
				</label>
			</div>
		</div>

		<div class="footer">
			<button class="btn" onclick={runBenchmark}>Benchmark 30×30</button>
			<button class="btn" onclick={onclose}>Cancel</button>
			<button class="btn primary" onclick={save}>Save</button>
		</div>
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
	}
	.modal {
		position: absolute;
		left: 50%;
		top: 18%;
		transform: translate(-50%, 0);
		width: min(520px, calc(100vw - 24px));
		background: var(--ui-bg);
		border: 1px solid var(--ui-border);
		border-radius: 18px;
		backdrop-filter: blur(18px);
		color: var(--ui-text-hover);
	}
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 16px;
		border-bottom: 1px solid var(--ui-border);
	}
	.close {
		width: 34px;
		height: 34px;
		border-radius: 10px;
		border: 1px solid var(--ui-border);
		background: var(--btn-bg);
		color: var(--ui-text-hover);
		cursor: pointer;
	}
	.content {
		padding: 14px 16px;
		display: grid;
		gap: 12px;
	}
	label {
		display: grid;
		gap: 6px;
	}
	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	input {
		width: 100%;
		border-radius: 12px;
		border: 1px solid var(--ui-border);
		background: var(--ui-input-bg);
		color: var(--ui-text-hover);
		padding: 10px 12px;
	}
	select {
		width: 100%;
		border-radius: 12px;
		border: 1px solid var(--ui-border);
		background: var(--ui-input-bg);
		color: var(--ui-text-hover);
		padding: 10px 12px;
	}
	.footer {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		padding: 14px 16px;
		border-top: 1px solid var(--ui-border);
	}
	.btn {
		height: 38px;
		padding: 0 12px;
		border-radius: 12px;
		border: 1px solid var(--ui-border);
		background: var(--btn-bg);
		color: var(--ui-text-hover);
		cursor: pointer;
	}
	.btn.primary {
		background: var(--ui-accent);
		color: #000;
		border-color: transparent;
	}
	@media (max-width: 520px) {
		.row {
			grid-template-columns: 1fr;
		}
	}
</style>
