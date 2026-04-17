<script lang="ts">
	import { onMount } from 'svelte';
	import { draggable } from '$lib/utils/draggable.js';
	import { bringToFront, setModalPosition, getModalState } from '$lib/stores/modalManager.svelte.js';
	import type { NlcaNeighborhood } from '$lib/nlca/types.js';
	import { getNlcaSettingsState } from '$lib/stores/nlcaSettings.svelte.js';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();
	const modalState = $derived(getModalState('nlcaSettings'));
	const nlcaSettings = getNlcaSettingsState();

	// NLCA settings
	let model = $state('openai/gpt-4o-mini');
	let neighborhood = $state<NlcaNeighborhood>('moore');
	let gridWidth = $state(10);
	let gridHeight = $state(10);
	let memoryWindow = $state(3);
	let targetFrames = $state(50);

	// API settings
	let apiKey = $state('');
	let maxConcurrency = $state(50);
	let batchSize = $state(200);

	// OpenRouter model list
	let openRouterModels = $state<Array<{ id: string; name: string }>>([]);
	let modelsLoading = $state(false);

	onMount(async () => {
		apiKey = nlcaSettings.apiKey;
		model = nlcaSettings.model;
		maxConcurrency = nlcaSettings.maxConcurrency;
		batchSize = nlcaSettings.batchSize;
		memoryWindow = nlcaSettings.memoryWindow;
		neighborhood = nlcaSettings.neighborhood;
		gridWidth = nlcaSettings.gridWidth;
		gridHeight = nlcaSettings.gridHeight;
		targetFrames = nlcaSettings.targetFrames;

		modelsLoading = true;
		try {
			const res = await fetch('https://openrouter.ai/api/v1/models');
			const data = await res.json();
			openRouterModels = ((data.data ?? []) as Array<{ id: string; name: string }>)
				.filter((m) => m.id && m.name)
				.sort((a, b) => a.id.localeCompare(b.id));
		} catch {
			// leave empty — user can still type manually
		} finally {
			modelsLoading = false;
		}
	});

	function handleModalClick() {
		bringToFront('nlcaSettings');
	}
	function handleDragEnd(position: { x: number; y: number }) {
		setModalPosition('nlcaSettings', position);
	}
	function save() {
		nlcaSettings.apiKey = apiKey;
		nlcaSettings.model = model;
		nlcaSettings.maxConcurrency = maxConcurrency;
		nlcaSettings.batchSize = batchSize;
		nlcaSettings.memoryWindow = memoryWindow;
		nlcaSettings.neighborhood = neighborhood;
		nlcaSettings.gridWidth = gridWidth;
		nlcaSettings.gridHeight = gridHeight;
		nlcaSettings.targetFrames = targetFrames;
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
			<!-- NLCA section -->
			<div class="section-label">Experiment</div>

			<label>
				<span>Model {modelsLoading ? '(loading…)' : ''}</span>
				<input
					type="text"
					bind:value={model}
					placeholder="e.g. openai/gpt-4o-mini"
					list="openrouter-models"
				/>
				{#if openRouterModels.length > 0}
					<datalist id="openrouter-models">
						{#each openRouterModels as m (m.id)}
							<option value={m.id}>{m.name}</option>
						{/each}
					</datalist>
				{/if}
			</label>

			<label>
				<span>Neighborhood</span>
				<select bind:value={neighborhood}>
					<option value="moore">Moore (8 neighbors)</option>
					<option value="vonNeumann">Von Neumann (4 neighbors)</option>
					<option value="extendedMoore">Extended Moore (24 neighbors)</option>
				</select>
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

			<div class="row">
				<label>
					<span>Memory window</span>
					<input type="number" min="0" max="16" bind:value={memoryWindow} />
					<small>History frames per cell (0 = stateless)</small>
				</label>
				<label>
					<span>Target frames</span>
					<input type="number" min="1" max="10000" bind:value={targetFrames} />
					<small>Frames to run per experiment</small>
				</label>
			</div>

			<!-- API section -->
			<div class="section-label" style="margin-top: 4px;">API</div>

			<label>
				<span>OpenRouter API Key</span>
				<input type="password" bind:value={apiKey} placeholder="sk-or-..." />
			</label>

			<div class="row">
				<label>
					<span>Max concurrency</span>
					<input type="number" min="1" max="200" bind:value={maxConcurrency} />
					<small>Parallel LLM calls</small>
				</label>
				<label>
					<span>Batch size</span>
					<input type="number" min="1" max="2000" bind:value={batchSize} />
					<small>Cells per request</small>
				</label>
			</div>
		</div>

		<div class="footer">
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
		width: min(480px, calc(100vw - 24px));
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
		gap: 10px;
	}
	.section-label {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--ui-text);
		padding-bottom: 2px;
		border-bottom: 1px solid var(--ui-border);
	}
	label {
		display: grid;
		gap: 5px;
	}
	label > span {
		font-size: 12px;
		color: var(--ui-text);
	}
	small {
		font-size: 10px;
		color: var(--ui-text);
		opacity: 0.7;
	}
	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	input,
	select {
		width: 100%;
		border-radius: 10px;
		border: 1px solid var(--ui-border);
		background: var(--ui-input-bg);
		color: var(--ui-text-hover);
		padding: 8px 10px;
		font-size: 13px;
		font-family: inherit;
	}
	.footer {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		padding: 12px 16px;
		border-top: 1px solid var(--ui-border);
	}
	.btn {
		height: 36px;
		padding: 0 14px;
		border-radius: 10px;
		border: 1px solid var(--ui-border);
		background: var(--btn-bg);
		color: var(--ui-text-hover);
		cursor: pointer;
		font-size: 13px;
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
