<script lang="ts">
	import { onMount } from 'svelte';
	import { draggable } from '$lib/utils/draggable.js';
	import { bringToFront, setModalPosition, getModalState } from '$lib/stores/modalManager.svelte.js';
	import type { ApiProvider, NlcaNeighborhood } from '$lib/nlca/types.js';
	import { getNlcaSettingsState } from '$lib/stores/nlcaSettings.svelte.js';

	// Fallback when the SambaNova /v1/models endpoint is unreachable.
	const SAMBANOVA_FALLBACK = ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct', 'Meta-Llama-3.1-405B-Instruct'];

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();
	const modalState = $derived(getModalState('nlcaSettings'));
	const nlcaSettings = getNlcaSettingsState();

	// NLCA settings
	let apiProvider = $state<ApiProvider>('openrouter');
	let model = $state('openai/gpt-4o-mini');
	let neighborhood = $state<NlcaNeighborhood>('moore');
	let gridWidth = $state(10);
	let gridHeight = $state(10);
	let memoryWindow = $state(3);
	let targetFrames = $state(50);

	// API settings
	let apiKey = $state('');
	let sambaNovaApiKey = $state('');
	let maxConcurrency = $state(50);
	let batchSize = $state(200);

	// Model lists — fetched per provider
	let openRouterModels = $state<Array<{ id: string; name: string; context_length?: number }>>([]);
	let sambaNovaModels = $state<Array<{ id: string; name: string }>>(
		SAMBANOVA_FALLBACK.map((id) => ({ id, name: id }))
	);
	let modelsLoading = $state(false);
	let modelsError = $state(false);

	// Combobox state
	let searchQuery = $state('');
	let dropdownOpen = $state(false);
	let highlightIdx = $state(-1);
	let dropdownEl = $state<HTMLElement | null>(null);

	const MAX_VISIBLE = 150;

	const filteredModels = $derived.by(() => {
		const q = searchQuery.toLowerCase().trim();
		const list = q
			? providerModels.filter(
					(m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
				)
			: providerModels;
		return list.slice(0, MAX_VISIBLE);
	});

	onMount(async () => {
		apiProvider = nlcaSettings.apiProvider;
		apiKey = nlcaSettings.apiKey;
		sambaNovaApiKey = nlcaSettings.sambaNovaApiKey;
		model = nlcaSettings.model;
		searchQuery = model;
		maxConcurrency = nlcaSettings.maxConcurrency;
		batchSize = nlcaSettings.batchSize;
		memoryWindow = nlcaSettings.memoryWindow;
		neighborhood = nlcaSettings.neighborhood;
		gridWidth = nlcaSettings.gridWidth;
		gridHeight = nlcaSettings.gridHeight;
		targetFrames = nlcaSettings.targetFrames;

		await loadModelsForProvider(apiProvider);
	});

	async function loadModelsForProvider(provider: ApiProvider) {
		modelsLoading = true;
		modelsError = false;
		try {
			const headers: Record<string, string> = {};
			const keyForProvider =
				provider === 'sambanova' ? nlcaSettings.sambaNovaApiKey : nlcaSettings.apiKey;
			if (keyForProvider) headers['Authorization'] = `Bearer ${keyForProvider}`;
			const url = provider === 'sambanova' ? '/api/nlca-models?provider=sambanova' : '/api/nlca-models';
			const res = await fetch(url, { headers });
			const data = await res.json();
			const rows = ((data.data ?? []) as Array<{ id: string; name: string; context_length?: number }>)
				.filter((m) => m.id)
				.map((m) => ({ id: m.id, name: m.name ?? m.id, context_length: m.context_length }))
				.sort((a, b) => a.id.localeCompare(b.id));
			if (provider === 'sambanova') {
				sambaNovaModels = rows.length > 0 ? rows : SAMBANOVA_FALLBACK.map((id) => ({ id, name: id }));
			} else {
				openRouterModels = rows;
			}
		} catch {
			modelsError = true;
		} finally {
			modelsLoading = false;
		}
	}

	// Computed list for combobox — depends on selected provider
	const providerModels = $derived(
		apiProvider === 'sambanova' ? sambaNovaModels : openRouterModels
	);

	function switchProvider(next: ApiProvider) {
		if (next === apiProvider) return;
		apiProvider = next;
		if (next === 'sambanova' && model.includes('/')) {
			model = SAMBANOVA_FALLBACK[0]!;
			searchQuery = model;
		} else if (next === 'openrouter' && !model.includes('/')) {
			model = 'openai/gpt-4o-mini';
			searchQuery = model;
		}
		// Fetch the appropriate live list for the newly-selected provider.
		void loadModelsForProvider(next);
	}

	function handleInputFocus() {
		dropdownOpen = true;
		highlightIdx = -1;
	}

	function handleInputInput() {
		dropdownOpen = true;
		highlightIdx = 0;
	}

	function selectModel(m: { id: string }) {
		model = m.id;
		searchQuery = m.id;
		dropdownOpen = false;
		highlightIdx = -1;
	}

	function handleInputBlur() {
		// Use a short delay so onmousedown on options fires before blur closes the list.
		setTimeout(() => {
			if (!dropdownOpen) return;
			dropdownOpen = false;
			// If the user typed something not from the list, treat it as a custom model ID.
			const trimmed = searchQuery.trim();
			if (trimmed) model = trimmed;
			else searchQuery = model;
		}, 150);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!dropdownOpen) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				dropdownOpen = true;
				highlightIdx = 0;
				e.preventDefault();
			}
			return;
		}
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				highlightIdx = Math.min(highlightIdx + 1, filteredModels.length - 1);
				scrollHighlightIntoView();
				break;
			case 'ArrowUp':
				e.preventDefault();
				highlightIdx = Math.max(highlightIdx - 1, -1);
				scrollHighlightIntoView();
				break;
			case 'Enter':
				e.preventDefault();
				if (highlightIdx >= 0 && filteredModels[highlightIdx]) {
					selectModel(filteredModels[highlightIdx]!);
				} else {
					const trimmed = searchQuery.trim();
					if (trimmed) {
						model = trimmed;
						searchQuery = trimmed;
					}
					dropdownOpen = false;
				}
				break;
			case 'Escape':
				dropdownOpen = false;
				searchQuery = model;
				highlightIdx = -1;
				break;
		}
	}

	function scrollHighlightIntoView() {
		if (!dropdownEl) return;
		const el = dropdownEl.children[highlightIdx] as HTMLElement | undefined;
		el?.scrollIntoView({ block: 'nearest' });
	}

	function handleModalClick() {
		bringToFront('nlcaSettings');
	}
	function handleDragEnd(position: { x: number; y: number }) {
		setModalPosition('nlcaSettings', position);
	}
	function save() {
		nlcaSettings.apiProvider = apiProvider;
		nlcaSettings.apiKey = apiKey;
		nlcaSettings.sambaNovaApiKey = sambaNovaApiKey;
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
			<!-- Provider toggle -->
			<div class="provider-switch" role="tablist" aria-label="Inference provider">
				<button
					class="provider-btn"
					class:active={apiProvider === 'openrouter'}
					role="tab"
					aria-selected={apiProvider === 'openrouter'}
					onclick={() => switchProvider('openrouter')}
				>
					<span class="provider-name">OpenRouter</span>
					<span class="provider-sub">Any model · conversational rules</span>
				</button>
				<button
					class="provider-btn"
					class:active={apiProvider === 'sambanova'}
					role="tab"
					aria-selected={apiProvider === 'sambanova'}
					onclick={() => switchProvider('sambanova')}
				>
					<span class="provider-name">SambaNova Hyperscale</span>
					<span class="provider-sub">Up to 1M cells · dedup + batch</span>
				</button>
			</div>

			<!-- NLCA section -->
			<div class="section-label">Experiment</div>

			<!-- Model combobox -->
			<div class="field">
				<span class="field-label">
					Model
					{#if modelsLoading}
						<span class="badge loading">loading…</span>
					{:else if modelsError}
						<span class="badge error">offline — type manually</span>
					{:else if apiProvider === 'sambanova'}
						<span class="badge">{sambaNovaModels.length} SambaNova</span>
					{:else if openRouterModels.length > 0}
						<span class="badge">{openRouterModels.length} OpenRouter</span>
					{/if}
				</span>

				<div class="combobox" class:open={dropdownOpen}>
					<div class="combobox-input-row">
						<input
							type="text"
							class="combobox-input"
							bind:value={searchQuery}
							placeholder={dropdownOpen ? 'Search models…' : (model || 'e.g. openai/gpt-4o-mini')}
							autocomplete="off"
							spellcheck={false}
							role="combobox"
							aria-label="Select model"
							aria-expanded={dropdownOpen}
							aria-autocomplete="list"
							aria-controls="model-combobox-listbox"
							onfocus={handleInputFocus}
							oninput={handleInputInput}
							onblur={handleInputBlur}
							onkeydown={handleKeydown}
						/>
						<button
							class="combobox-chevron"
							tabindex="-1"
							aria-label="Toggle model list"
							onmousedown={(e) => {
								e.preventDefault();
								if (dropdownOpen) {
									dropdownOpen = false;
									searchQuery = model;
								} else {
									dropdownOpen = true;
								}
							}}
						>
							<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
								<path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
							</svg>
						</button>
					</div>

					{#if dropdownOpen}
						<div class="combobox-dropdown" bind:this={dropdownEl} id="model-combobox-listbox" role="listbox">
							{#if filteredModels.length === 0}
								<div class="combobox-empty">
									{openRouterModels.length === 0
										? 'No models loaded — type a model ID manually'
										: `No match for "${searchQuery}"`}
								</div>
							{:else}
								{#each filteredModels as m, i (m.id)}
									<div
										class="combobox-option"
										class:highlighted={i === highlightIdx}
										class:selected={m.id === model}
										role="option"
										tabindex="-1"
										aria-selected={m.id === model}
										onmousedown={() => selectModel(m)}
										onmousemove={() => { highlightIdx = i; }}
									>
										<span class="opt-id">{m.id}</span>
										{#if m.name && m.name !== m.id}
											<span class="opt-name">{m.name}</span>
										{/if}
									</div>
								{/each}
								{#if openRouterModels.length > MAX_VISIBLE && filteredModels.length === MAX_VISIBLE}
									<div class="combobox-more">Type to filter — showing {MAX_VISIBLE} of {openRouterModels.length}</div>
								{/if}
							{/if}
						</div>
					{/if}
				</div>
			</div>

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
			<div class="section-label" style="margin-top: 4px;">API Keys</div>

			<label class:active-key={apiProvider === 'openrouter'}>
				<span>
					OpenRouter API Key
					{#if apiProvider === 'openrouter'}<span class="badge active">active</span>{/if}
				</span>
				<input type="password" bind:value={apiKey} placeholder="sk-or-..." />
			</label>

			<label class:active-key={apiProvider === 'sambanova'}>
				<span>
					SambaNova API Key
					{#if apiProvider === 'sambanova'}<span class="badge active">active</span>{/if}
				</span>
				<input type="password" bind:value={sambaNovaApiKey} placeholder="SambaNova key..." />
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
		/* Allow combobox dropdown to overflow */
		overflow: visible;
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
	label > span,
	.field-label {
		font-size: 12px;
		color: var(--ui-text);
	}
	.field {
		display: grid;
		gap: 5px;
	}
	.field-label {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.badge {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 20px;
		background: rgba(255 255 255 / 0.07);
		color: var(--ui-text);
	}
	.badge.loading {
		color: var(--ui-text);
		opacity: 0.6;
	}
	.badge.error {
		color: #e88;
		background: rgba(255 80 80 / 0.1);
	}
	.badge.active {
		background: var(--ui-accent, #a0c4ff);
		color: #000;
		font-weight: 600;
	}

	/* ---- Provider switch ---- */
	.provider-switch {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
		padding: 4px;
		border-radius: 12px;
		background: rgba(255 255 255 / 0.04);
		border: 1px solid var(--ui-border);
	}
	.provider-btn {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 8px 10px;
		border-radius: 9px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--ui-text);
		cursor: pointer;
		text-align: left;
		transition: background 0.12s, color 0.12s, border-color 0.12s;
	}
	.provider-btn:hover {
		background: rgba(255 255 255 / 0.05);
		color: var(--ui-text-hover);
	}
	.provider-btn.active {
		background: var(--ui-bg-hover);
		color: var(--ui-text-hover);
		border-color: var(--ui-border-hover);
	}
	.provider-name {
		font-size: 12px;
		font-weight: 600;
	}
	.provider-sub {
		font-size: 10px;
		opacity: 0.6;
	}

	label.active-key span {
		color: var(--ui-text-hover);
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
		box-sizing: border-box;
	}

	/* ---- Combobox ---- */
	.combobox {
		position: relative;
	}
	.combobox-input-row {
		display: flex;
		align-items: center;
		border-radius: 10px;
		border: 1px solid var(--ui-border);
		background: var(--ui-input-bg);
		transition: border-color 0.15s;
		overflow: hidden;
	}
	.combobox.open .combobox-input-row {
		border-color: var(--ui-border-hover, rgba(255 255 255 / 0.25));
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
	}
	.combobox-input {
		flex: 1;
		border: none !important;
		background: transparent !important;
		border-radius: 0 !important;
		padding: 8px 6px 8px 10px !important;
		min-width: 0;
		outline: none;
	}
	.combobox-chevron {
		flex-shrink: 0;
		width: 30px;
		height: 36px;
		border: none;
		background: transparent;
		color: var(--ui-text);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: color 0.15s, transform 0.15s;
	}
	.combobox.open .combobox-chevron {
		transform: rotate(180deg);
		color: var(--ui-text-hover);
	}
	.combobox-dropdown {
		position: absolute;
		left: 0;
		right: 0;
		top: 100%;
		z-index: 9999;
		background: var(--ui-bg);
		border: 1px solid var(--ui-border-hover, rgba(255 255 255 / 0.18));
		border-top: none;
		border-bottom-left-radius: 10px;
		border-bottom-right-radius: 10px;
		max-height: 240px;
		overflow-y: auto;
		backdrop-filter: blur(18px);
		overscroll-behavior: contain;
	}
	.combobox-option {
		padding: 7px 10px;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 1px;
		border-bottom: 1px solid rgba(255 255 255 / 0.04);
		transition: background 0.08s;
	}
	.combobox-option:last-child {
		border-bottom: none;
	}
	.combobox-option.highlighted {
		background: rgba(255 255 255 / 0.08);
	}
	.combobox-option.selected .opt-id {
		color: var(--ui-accent, #a0c4ff);
	}
	.opt-id {
		font-size: 12px;
		font-family: 'SF Mono', 'Fira Code', monospace;
		color: var(--ui-text-hover);
		line-height: 1.3;
	}
	.opt-name {
		font-size: 10px;
		color: var(--ui-text);
		line-height: 1.3;
	}
	.combobox-empty,
	.combobox-more {
		padding: 10px;
		font-size: 11px;
		color: var(--ui-text);
		text-align: center;
		opacity: 0.7;
	}
	.combobox-more {
		border-top: 1px solid var(--ui-border);
		background: rgba(255 255 255 / 0.03);
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
