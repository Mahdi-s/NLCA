<script lang="ts">
	import type { ExperimentConfig, NlcaNeighborhood } from '$lib/nlca/types.js';
	import { PROMPT_PRESETS } from '$lib/stores/nlcaPrompt.svelte.js';
	import { getNlcaSettingsState } from '$lib/stores/nlcaSettings.svelte.js';

	interface Props {
		onlaunch: (config: ExperimentConfig) => void;
		onclose: () => void;
	}

	let { onlaunch, onclose }: Props = $props();

	const defaults = getNlcaSettingsState();

	// Section 1: Model & Provider
	let model = $state(defaults.model);
	let apiKey = $state(defaults.apiKey);
	let temperature = $state(0.7);
	let maxOutputTokens = $state(8192);

	// Section 2: Simulation Parameters
	let gridWidth = $state(defaults.gridWidth);
	let gridHeight = $state(defaults.gridHeight);
	let neighborhood = $state<NlcaNeighborhood>(defaults.neighborhood);
	let cellColorEnabled = $state(false);

	// Section 3: Prompt & Task
	let selectedPresetId = $state<string>('filled-square');
	let taskDescription = $state(PROMPT_PRESETS[0]?.task ?? '');
	let useAdvancedMode = $state(false);
	let advancedTemplate = $state('');

	// Section 4: LLM / Technical Parameters
	let memoryWindow = $state(defaults.memoryWindow);
	let maxConcurrency = $state(defaults.maxConcurrency);
	let batchSize = $state(defaults.batchSize);
	let frameBatched = $state(defaults.frameBatched);
	let frameStreamed = $state(defaults.frameStreamed);
	let cellTimeoutMs = $state(30000);
	let compressPayload = $state(false);
	let deduplicateRequests = $state(false);

	// Section 5: Run Configuration
	let targetFrames = $state(50);

	let activeSection = $state(0);
	const sections = ['Model & Provider', 'Simulation', 'Prompt & Task', 'Technical', 'Run Config'];

	const modelPresets = [
		'openai/gpt-4o-mini',
		'openai/gpt-4o',
		'anthropic/claude-3.5-sonnet',
		'anthropic/claude-3-haiku',
		'google/gemma-3-27b-it',
		'meta-llama/llama-3.1-70b-instruct',
		'mistralai/mistral-small-3.1-24b-instruct'
	];

	function onPresetChange(presetId: string) {
		selectedPresetId = presetId;
		const preset = PROMPT_PRESETS.find((p) => p.id === presetId);
		if (preset) {
			taskDescription = preset.task;
		}
	}

	function handleLaunch() {
		const config: ExperimentConfig = {
			apiKey,
			model,
			temperature,
			maxOutputTokens,
			gridWidth,
			gridHeight,
			neighborhood,
			cellColorEnabled,
			taskDescription,
			promptPresetId: selectedPresetId,
			useAdvancedMode,
			advancedTemplate: useAdvancedMode ? advancedTemplate : undefined,
			memoryWindow,
			maxConcurrency,
			batchSize,
			frameBatched,
			frameStreamed,
			cellTimeoutMs,
			compressPayload,
			deduplicateRequests,
			targetFrames
		};
		onlaunch(config);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={onclose} onkeydown={() => {}}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
		<div class="modal-header">
			<h2>New Experiment</h2>
			<button class="close-btn" onclick={onclose}>×</button>
		</div>

		<div class="section-tabs">
			{#each sections as section, i}
				<button
					class="section-tab"
					class:active={activeSection === i}
					onclick={() => (activeSection = i)}
				>
					{section}
				</button>
			{/each}
		</div>

		<div class="modal-body">
			{#if activeSection === 0}
				<div class="section">
					<label class="field">
						<span>OpenRouter API Key</span>
						<input type="password" bind:value={apiKey} placeholder="sk-or-..." />
					</label>
					<label class="field">
						<span>Model</span>
						<input type="text" bind:value={model} placeholder="provider/model-name" />
						<div class="preset-chips">
							{#each modelPresets as mp}
								<button class="chip" class:selected={model === mp} onclick={() => (model = mp)}>
									{mp.split('/').pop()}
								</button>
							{/each}
						</div>
					</label>
					<div class="field-row">
						<label class="field">
							<span>Temperature</span>
							<input type="number" bind:value={temperature} min={0} max={2} step={0.1} />
						</label>
						<label class="field">
							<span>Max Output Tokens</span>
							<input type="number" bind:value={maxOutputTokens} min={256} max={65536} step={256} />
						</label>
					</div>
				</div>

			{:else if activeSection === 1}
				<div class="section">
					<div class="field-row">
						<label class="field">
							<span>Grid Width</span>
							<input type="number" bind:value={gridWidth} min={8} max={512} />
						</label>
						<label class="field">
							<span>Grid Height</span>
							<input type="number" bind:value={gridHeight} min={8} max={512} />
						</label>
					</div>
					<label class="field">
						<span>Neighborhood</span>
						<select bind:value={neighborhood}>
							<option value="moore">Moore (8 neighbors)</option>
							<option value="vonNeumann">Von Neumann (4 neighbors)</option>
							<option value="extendedMoore">Extended Moore (24 neighbors)</option>
						</select>
					</label>
					<label class="field checkbox-field">
						<input type="checkbox" bind:checked={cellColorEnabled} />
						<span>Enable cell color output</span>
					</label>
				</div>

			{:else if activeSection === 2}
				<div class="section">
					<label class="field">
						<span>Preset</span>
						<select value={selectedPresetId} onchange={(e) => onPresetChange((e.target as HTMLSelectElement).value)}>
							{#each PROMPT_PRESETS as preset}
								<option value={preset.id}>{preset.name} — {preset.description}</option>
							{/each}
						</select>
					</label>
					<label class="field">
						<span>Task Description</span>
						<textarea bind:value={taskDescription} rows={6} placeholder="Describe the task for cells..." />
					</label>
					<label class="field checkbox-field">
						<input type="checkbox" bind:checked={useAdvancedMode} />
						<span>Advanced template mode</span>
					</label>
					{#if useAdvancedMode}
						<label class="field">
							<span>Custom Template</span>
							<textarea bind:value={advancedTemplate} rows={8} placeholder="Custom prompt template..." />
						</label>
					{/if}
				</div>

			{:else if activeSection === 3}
				<div class="section">
					<label class="field">
						<span>Memory Window (frames)</span>
						<input type="number" bind:value={memoryWindow} min={0} max={16} />
					</label>
					<div class="field-row">
						<label class="field">
							<span>Max Concurrency</span>
							<input type="number" bind:value={maxConcurrency} min={1} max={200} />
						</label>
						<label class="field">
							<span>Batch Size</span>
							<input type="number" bind:value={batchSize} min={1} max={2000} />
						</label>
					</div>
					<label class="field checkbox-field">
						<input type="checkbox" bind:checked={frameBatched} />
						<span>Frame-batched mode</span>
					</label>
					<label class="field checkbox-field">
						<input type="checkbox" bind:checked={frameStreamed} disabled={!frameBatched} />
						<span>Stream frame updates (SSE)</span>
					</label>
					<label class="field">
						<span>Cell Timeout (ms)</span>
						<input type="number" bind:value={cellTimeoutMs} min={5000} max={120000} step={1000} />
					</label>
					<div class="field-row">
						<label class="field checkbox-field">
							<input type="checkbox" bind:checked={compressPayload} />
							<span>Compress payload</span>
						</label>
						<label class="field checkbox-field">
							<input type="checkbox" bind:checked={deduplicateRequests} />
							<span>Deduplicate requests</span>
						</label>
					</div>
				</div>

			{:else if activeSection === 4}
				<div class="section">
					<label class="field">
						<span>Target Frames</span>
						<input type="number" bind:value={targetFrames} min={1} max={10000} />
						<div class="preset-chips">
							{#each [10, 25, 50, 100, 250, 500] as n}
								<button class="chip" class:selected={targetFrames === n} onclick={() => (targetFrames = n)}>
									{n}
								</button>
							{/each}
						</div>
					</label>
				</div>
			{/if}
		</div>

		<div class="modal-footer">
			<button class="btn secondary" onclick={onclose}>Cancel</button>
			<button class="btn primary" onclick={handleLaunch} disabled={!apiKey || !model || !taskDescription}>
				Launch Experiment
			</button>
		</div>
	</div>
</div>

<style>
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 1000;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: 5vh;
	}

	.modal {
		background: var(--color-surface, #1a1a1a);
		border: 1px solid var(--color-border, #333);
		border-radius: 12px;
		width: 520px;
		max-height: 80vh;
		display: flex;
		flex-direction: column;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px 20px;
		border-bottom: 1px solid var(--color-border, #333);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--color-text, #eee);
	}

	.close-btn {
		background: none;
		border: none;
		color: var(--color-text-muted, #999);
		font-size: 20px;
		cursor: pointer;
		padding: 0 4px;
	}

	.section-tabs {
		display: flex;
		gap: 0;
		border-bottom: 1px solid var(--color-border, #333);
		padding: 0 12px;
		overflow-x: auto;
	}

	.section-tab {
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--color-text-muted, #999);
		cursor: pointer;
		font-size: 12px;
		padding: 10px 12px;
		white-space: nowrap;
		transition: color 0.15s, border-color 0.15s;
	}

	.section-tab:hover { color: var(--color-text, #eee); }

	.section-tab.active {
		color: var(--color-primary, #6366f1);
		border-bottom-color: var(--color-primary, #6366f1);
	}

	.modal-body {
		padding: 16px 20px;
		overflow-y: auto;
		flex: 1;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.field span {
		font-size: 12px;
		color: var(--color-text-muted, #999);
		font-weight: 500;
	}

	.field input[type='text'],
	.field input[type='password'],
	.field input[type='number'],
	.field select,
	.field textarea {
		background: var(--color-surface-dark, #111);
		border: 1px solid var(--color-border, #333);
		border-radius: 6px;
		color: var(--color-text, #eee);
		padding: 8px 10px;
		font-size: 13px;
		font-family: inherit;
	}

	.field textarea { resize: vertical; }

	.field-row {
		display: flex;
		gap: 12px;
	}

	.field-row .field { flex: 1; }

	.checkbox-field {
		flex-direction: row;
		align-items: center;
		gap: 8px;
	}

	.checkbox-field input[type='checkbox'] {
		accent-color: var(--color-primary, #6366f1);
	}

	.preset-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 4px;
	}

	.chip {
		background: var(--color-surface-dark, #111);
		border: 1px solid var(--color-border, #333);
		border-radius: 12px;
		color: var(--color-text-muted, #999);
		cursor: pointer;
		font-size: 11px;
		padding: 3px 10px;
		transition: all 0.15s;
	}

	.chip:hover {
		border-color: var(--color-primary, #6366f1);
		color: var(--color-text, #eee);
	}

	.chip.selected {
		background: var(--color-primary, #6366f1);
		border-color: var(--color-primary, #6366f1);
		color: white;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 12px 20px;
		border-top: 1px solid var(--color-border, #333);
	}

	.btn {
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
		font-weight: 500;
		padding: 8px 16px;
		transition: background 0.15s;
	}

	.btn.secondary {
		background: var(--color-surface-dark, #111);
		color: var(--color-text-muted, #999);
	}

	.btn.primary {
		background: var(--color-primary, #6366f1);
		color: white;
	}

	.btn.primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn:hover:not(:disabled) { filter: brightness(1.15); }
</style>
