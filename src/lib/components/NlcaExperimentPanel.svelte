<script lang="ts">
	import type { ExperimentManager, Experiment } from '$lib/nlca/experimentManager.svelte.js';
	import type { ExperimentConfig } from '$lib/nlca/types.js';
	import { getNlcaSettingsState } from '$lib/stores/nlcaSettings.svelte.js';
	import { getNlcaPromptState } from '$lib/stores/nlcaPrompt.svelte.js';

	interface Props {
		manager: ExperimentManager;
		open: boolean;
		onclose: () => void;
	}

	let { manager, open, onclose }: Props = $props();

	const nlcaSettings = getNlcaSettingsState();
	const nlcaPrompt = getNlcaPromptState();

	let targetFrames = $state(50);
	let confirmDeleteId = $state<string | null>(null);

	/** Build an ExperimentConfig from the current global settings */
	function configFromCurrentSettings(): ExperimentConfig {
		return {
			apiKey: nlcaSettings.apiKey,
			model: nlcaSettings.model,
			temperature: 0,
			maxOutputTokens: 64,
			gridWidth: nlcaSettings.gridWidth,
			gridHeight: nlcaSettings.gridHeight,
			neighborhood: nlcaSettings.neighborhood,
			cellColorEnabled: nlcaPrompt.cellColorHexEnabled,
			taskDescription: nlcaPrompt.taskDescription,
			promptPresetId: undefined,
			useAdvancedMode: nlcaPrompt.useAdvancedMode,
			advancedTemplate: nlcaPrompt.advancedTemplate,
			memoryWindow: nlcaSettings.memoryWindow,
			maxConcurrency: nlcaSettings.maxConcurrency,
			batchSize: nlcaSettings.batchSize,
			frameBatched: nlcaSettings.frameBatched,
			frameStreamed: nlcaSettings.frameStreamed,
			cellTimeoutMs: 30_000,
			compressPayload: false,
			deduplicateRequests: false,
			targetFrames
		};
	}

	function handleLaunch() {
		if (!nlcaSettings.apiKey) return;
		manager.createExperiment(configFromCurrentSettings());
	}

	function statusIcon(status: Experiment['status']): string {
		switch (status) {
			case 'running': return '●';
			case 'paused': return '⏸';
			case 'completed': return '✓';
			case 'error': return '✗';
			default: return '○';
		}
	}

	function statusColor(status: Experiment['status']): string {
		switch (status) {
			case 'running': return '#22c55e';
			case 'paused': return '#eab308';
			case 'completed': return '#3b82f6';
			case 'error': return '#ef4444';
			default: return '#6b7280';
		}
	}

	function formatTime(ts: number): string {
		const d = new Date(ts);
		return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="panel" class:open onkeydown={() => {}}>
	<div class="panel-header">
		<span class="panel-title">Experiments</span>
		<button class="panel-close" onclick={onclose} aria-label="Close panel">×</button>
	</div>

	<!-- Launch section -->
	<div class="launch-section">
		<div class="launch-info">
			<span class="launch-label">Current config</span>
			<span class="launch-detail">{nlcaSettings.model.split('/').pop()}</span>
			<span class="launch-detail">{nlcaSettings.gridWidth}×{nlcaSettings.gridHeight} · {nlcaSettings.neighborhood}</span>
		</div>
		<div class="launch-row">
			<label class="frames-field">
				<input type="number" bind:value={targetFrames} min={1} max={10000} />
				<span>frames</span>
			</label>
			<button
				class="launch-btn"
				onclick={handleLaunch}
				disabled={!nlcaSettings.apiKey}
				title={!nlcaSettings.apiKey ? 'Set API key in NLCA Settings first' : 'Launch experiment with current settings'}
			>
				Launch
			</button>
		</div>
		{#if !nlcaSettings.apiKey}
			<span class="launch-warn">Set API key in NLCA Settings first</span>
		{/if}
	</div>

	<!-- Experiment list -->
	<div class="experiment-list">
		{#each manager.experimentList as exp (exp.id)}
			<div
				class="exp-card"
				class:active={exp.id === manager.activeId}
				onclick={() => manager.setActive(exp.id)}
				role="button"
				tabindex="0"
				onkeydown={() => {}}
			>
				<div class="exp-top">
					<span class="exp-status" style="color: {statusColor(exp.status)}">{statusIcon(exp.status)}</span>
					<span class="exp-label">{exp.label}</span>
				</div>
				<div class="exp-meta">
					<span>{exp.config.gridWidth}×{exp.config.gridHeight}</span>
					<span>{exp.progress.current}/{exp.progress.target}</span>
					<span>{formatTime(exp.createdAt)}</span>
				</div>
				{#if exp.errorMessage}
					<div class="exp-error">{exp.errorMessage}</div>
				{/if}
				<div class="exp-actions">
					{#if exp.status === 'running'}
						<button class="exp-action-btn" onclick={(e) => { e.stopPropagation(); manager.pauseExperiment(exp.id); }}>Pause</button>
					{:else if exp.status === 'paused'}
						<button class="exp-action-btn" onclick={(e) => { e.stopPropagation(); manager.resumeExperiment(exp.id); }}>Resume</button>
					{/if}
					{#if confirmDeleteId === exp.id}
						<button class="exp-action-btn danger" onclick={(e) => { e.stopPropagation(); manager.deleteExperiment(exp.id); confirmDeleteId = null; }}>Confirm</button>
						<button class="exp-action-btn" onclick={(e) => { e.stopPropagation(); confirmDeleteId = null; }}>Cancel</button>
					{:else}
						<button class="exp-action-btn" onclick={(e) => { e.stopPropagation(); confirmDeleteId = exp.id; }}>Delete</button>
					{/if}
				</div>
			</div>
		{:else}
			<div class="empty-state">
				No experiments yet. Configure your settings, then hit Launch.
			</div>
		{/each}
	</div>
</div>

<style>
	.panel {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: 300px;
		z-index: 101;
		background: rgba(12, 12, 18, 0.85);
		backdrop-filter: blur(18px);
		-webkit-backdrop-filter: blur(18px);
		border-left: 1px solid var(--ui-border, rgba(255, 255, 255, 0.08));
		display: flex;
		flex-direction: column;
		transform: translateX(100%);
		transition: transform 0.25s ease;
		pointer-events: auto;
		font-size: 12px;
		color: var(--ui-text, #888);
	}

	.panel.open {
		transform: translateX(0);
	}

	.panel-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 14px;
		border-bottom: 1px solid var(--ui-border, rgba(255, 255, 255, 0.08));
		flex-shrink: 0;
	}

	.panel-title {
		font-weight: 600;
		font-size: 13px;
		color: var(--ui-text-hover, #fff);
	}

	.panel-close {
		background: none;
		border: none;
		color: var(--ui-text, #888);
		font-size: 18px;
		cursor: pointer;
		padding: 0 4px;
		line-height: 1;
	}

	.panel-close:hover {
		color: var(--ui-text-hover, #fff);
	}

	/* Launch section */
	.launch-section {
		padding: 12px 14px;
		border-bottom: 1px solid var(--ui-border, rgba(255, 255, 255, 0.08));
		display: flex;
		flex-direction: column;
		gap: 8px;
		flex-shrink: 0;
	}

	.launch-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.launch-label {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--ui-text, #888);
	}

	.launch-detail {
		font-size: 12px;
		color: var(--ui-text-hover, #fff);
		font-variant-numeric: tabular-nums;
	}

	.launch-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.frames-field {
		display: flex;
		align-items: center;
		gap: 4px;
		flex: 1;
	}

	.frames-field input {
		width: 60px;
		background: var(--ui-input-bg, rgba(0, 0, 0, 0.3));
		border: 1px solid var(--ui-border, rgba(255, 255, 255, 0.08));
		border-radius: 6px;
		color: var(--ui-text-hover, #fff);
		padding: 6px 8px;
		font-size: 12px;
		font-family: inherit;
	}

	.frames-field span {
		color: var(--ui-text, #888);
		font-size: 11px;
	}

	.launch-btn {
		background: var(--ui-accent, #2dd4bf);
		color: var(--ui-apply-text, #0a0a0f);
		border: none;
		border-radius: 6px;
		padding: 6px 14px;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		transition: filter 0.15s;
	}

	.launch-btn:hover:not(:disabled) {
		filter: brightness(1.15);
	}

	.launch-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.launch-warn {
		font-size: 10px;
		color: #ef4444;
	}

	/* Experiment list */
	.experiment-list {
		flex: 1;
		overflow-y: auto;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		scrollbar-width: thin;
	}

	.exp-card {
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid var(--ui-border, rgba(255, 255, 255, 0.08));
		border-radius: 8px;
		padding: 10px;
		cursor: pointer;
		transition: background 0.15s, border-color 0.15s;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.exp-card:hover {
		background: rgba(255, 255, 255, 0.07);
		border-color: var(--ui-border-hover, rgba(255, 255, 255, 0.15));
	}

	.exp-card.active {
		border-color: var(--ui-accent, #2dd4bf);
		background: rgba(45, 212, 191, 0.06);
	}

	.exp-top {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.exp-status {
		font-size: 10px;
		flex-shrink: 0;
	}

	.exp-label {
		color: var(--ui-text-hover, #fff);
		font-size: 12px;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.exp-meta {
		display: flex;
		gap: 8px;
		font-size: 10px;
		color: var(--ui-text, #888);
		font-variant-numeric: tabular-nums;
	}

	.exp-error {
		font-size: 10px;
		color: #ef4444;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.exp-actions {
		display: flex;
		gap: 4px;
	}

	.exp-action-btn {
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid var(--ui-border, rgba(255, 255, 255, 0.08));
		border-radius: 4px;
		color: var(--ui-text, #888);
		font-size: 10px;
		padding: 3px 8px;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.exp-action-btn:hover {
		background: rgba(255, 255, 255, 0.1);
		color: var(--ui-text-hover, #fff);
	}

	.exp-action-btn.danger {
		color: #ef4444;
		border-color: rgba(239, 68, 68, 0.3);
	}

	.exp-action-btn.danger:hover {
		background: rgba(239, 68, 68, 0.15);
	}

	.empty-state {
		padding: 24px 12px;
		text-align: center;
		color: var(--ui-text, #888);
		font-size: 12px;
		line-height: 1.5;
	}
</style>
