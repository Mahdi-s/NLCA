<script lang="ts">
	import type { Experiment } from '$lib/nlca/experimentManager.svelte.js';
	import { getNlcaStore } from '$lib/stores/nlcaStore.svelte.js';

	interface Props {
		open: boolean;
		onclose: () => void;
		onNew: () => void;
	}

	let { open, onclose, onNew }: Props = $props();
	const manager = getNlcaStore();

	let confirmDeleteId = $state<string | null>(null);
	let extendId = $state<string | null>(null);
	let extendFrames = $state(10);

	// Reset transient UI state whenever the active experiment changes so stale
	// extend inputs / delete confirms don't bleed across cards.
	$effect(() => {
		void manager.activeId;
		confirmDeleteId = null;
		extendId = null;
	});

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
		<div class="panel-header-actions">
			<button class="panel-new" onclick={onNew} aria-label="New experiment" title="New experiment (clears selection — Press Play to start)">+</button>
			<button class="panel-close" onclick={onclose} aria-label="Close panel">×</button>
		</div>
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
					<span class="provider-tag provider-{exp.config.apiProvider ?? 'openrouter'}">
						{exp.config.apiProvider === 'sambanova' ? 'SambaNova' : 'OpenRouter'}
					</span>
					<span>{exp.config.gridWidth}×{exp.config.gridHeight}</span>
					<span>{exp.progress.current}/{exp.progress.target}</span>
					<span>{formatTime(exp.createdAt)}</span>
				</div>
				<div class="exp-cost" title={
					exp.pricingUnknown && exp.totalCost === 0
						? "No public pricing for this model"
						: exp.status === 'completed'
							? `Final cost from actual usage. Initial projection: $${exp.estimatedCost.toFixed(4)}.`
							: `Live cost from actual usage. Projected full-run cost: $${exp.estimatedCost.toFixed(4)}.`
				}>
					{#if exp.pricingUnknown && exp.totalCost === 0}
						<span class="cost-label">Cost</span> <span class="cost-val muted">—</span>
					{:else if exp.status === 'completed'}
						<span class="cost-label">Cost</span>
						<span class="cost-val final">${exp.totalCost.toFixed(4)}</span>
					{:else}
						<span class="cost-label">Cost</span>
						<span class="cost-val">${exp.totalCost.toFixed(4)}</span>
						{#if exp.estimatedCost > 0}
							<span class="cost-val muted">/ ~${exp.estimatedCost.toFixed(4)}</span>
						{/if}
					{/if}
				</div>
			{#if exp.errorMessage}
				<div class="exp-error">{exp.errorMessage}</div>
			{/if}
			{#if exp.noTapeData}
				<div class="exp-no-data">Frame data unavailable (database file missing)</div>
			{/if}
				<div class="exp-actions">
					{#if exp.status === 'running'}
						<button class="exp-action-btn" onclick={(e) => { e.stopPropagation(); manager.pauseExperiment(exp.id); }}>Pause</button>
					{:else if exp.status === 'paused'}
						<button class="exp-action-btn" onclick={(e) => { e.stopPropagation(); manager.resumeExperiment(exp.id); }}>Resume</button>
					{:else if exp.status === 'completed' || exp.status === 'error'}
						{#if extendId === exp.id}
							<input
								class="extend-input"
								type="number"
								min="1"
								max="500"
								bind:value={extendFrames}
								onclick={(e) => e.stopPropagation()}
							/>
							<button class="exp-action-btn accent" onclick={(e) => {
								e.stopPropagation();
								void manager.extendExperiment(exp.id, extendFrames);
								extendId = null;
							}}>Go</button>
							<button class="exp-action-btn" onclick={(e) => { e.stopPropagation(); extendId = null; }}>✕</button>
						{:else}
							<button class="exp-action-btn" onclick={(e) => {
								e.stopPropagation();
								extendId = exp.id;
								extendFrames = exp.config.targetFrames;
							}}>Extend</button>
						{/if}
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
				No experiments yet. Configure your settings and press Play to start one.
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

	.panel-header-actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.panel-new {
		background: none;
		border: 1px solid var(--ui-border, rgba(255, 255, 255, 0.08));
		color: var(--ui-text, #888);
		font-size: 18px;
		line-height: 1;
		width: 26px;
		height: 26px;
		border-radius: 6px;
		cursor: pointer;
		display: grid;
		place-items: center;
		transition: background 0.15s, color 0.15s;
	}

	.panel-new:hover {
		background: rgba(255, 255, 255, 0.08);
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
		align-items: center;
	}
	.provider-tag {
		font-size: 9px;
		font-weight: 600;
		padding: 1px 5px;
		border-radius: 3px;
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}
	.provider-openrouter {
		background: rgba(96 165 250 / 0.15);
		color: #93c5fd;
	}
	.provider-sambanova {
		background: rgba(251 191 36 / 0.15);
		color: #fcd34d;
	}

	.exp-error {
		font-size: 10px;
		color: #ef4444;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.exp-no-data {
		font-size: 10px;
		color: #f59e0b;
		font-style: italic;
	}

	.exp-cost {
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		color: var(--ui-text, #888);
		display: flex;
		align-items: baseline;
		gap: 4px;
	}
	.exp-cost .cost-label {
		color: var(--ui-text, #888);
	}
	.exp-cost .cost-val {
		color: #22c55e;
	}
	.exp-cost .cost-val.final {
		color: #3b82f6;
	}
	.exp-cost .cost-val.muted {
		color: var(--ui-text, #888);
		font-weight: 400;
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

	.extend-input {
		width: 52px;
		background: rgba(255, 255, 255, 0.07);
		border: 1px solid var(--ui-border, rgba(255, 255, 255, 0.08));
		border-radius: 4px;
		color: var(--ui-text-hover, #fff);
		font-size: 10px;
		padding: 3px 5px;
		font-variant-numeric: tabular-nums;
	}

	.exp-action-btn.accent {
		color: var(--ui-accent, #2dd4bf);
		border-color: rgba(45, 212, 191, 0.3);
	}

	.exp-action-btn.accent:hover {
		background: rgba(45, 212, 191, 0.1);
		color: var(--ui-accent, #2dd4bf);
	}

	.empty-state {
		padding: 24px 12px;
		text-align: center;
		color: var(--ui-text, #888);
		font-size: 12px;
		line-height: 1.5;
	}
</style>
