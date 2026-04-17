<script lang="ts">
	import type { Experiment } from '$lib/nlca/experimentManager.svelte.js';

	interface Props {
		experiment: Experiment | null;
		onViewPrompt: () => void;
	}

	let { experiment, onViewPrompt }: Props = $props();

	function statusLabel(status: Experiment['status']): string {
		switch (status) {
			case 'running': return 'Running';
			case 'paused': return 'Paused';
			case 'completed': return 'Completed';
			case 'error': return 'Error';
			default: return 'Ready';
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
</script>

<div class="hud">
	<div class="top-row">
		<span class="pill">NLCA</span>
		{#if experiment}
			<span class="label" title={experiment.label}>{experiment.label}</span>
			<span class="status" style="color: {statusColor(experiment.status)}">● {statusLabel(experiment.status)}</span>
		{:else}
			<span class="muted">No experiment — press Play to start</span>
		{/if}
	</div>

	{#if experiment}
		<div class="info-row">
			<span><span class="k">Grid</span> <span class="v">{experiment.config.gridWidth}×{experiment.config.gridHeight}</span></span>
			<span class="dot">·</span>
			<span><span class="k">Nbhd</span> <span class="v">{experiment.config.neighborhood}</span></span>
			<span class="dot">·</span>
			<span><span class="k">Run</span> <span class="v mono">{experiment.id.slice(0, 8)}</span></span>
			<span class="dot">·</span>
			<span><span class="k">Stored</span> <span class="v">{experiment.progress.current}/{experiment.progress.target}</span></span>
			<span class="dot">·</span>
			<span><span class="k">Cost</span> <span class="v cost">${experiment.totalCost.toFixed(4)}</span></span>
			{#if experiment.lastLatencyMs != null}
				<span class="dot">·</span>
				<span><span class="k">Latency</span> <span class="v">{Math.round(experiment.lastLatencyMs)}ms</span></span>
			{/if}
		</div>

		<div class="action-row">
			<button class="link-btn" onclick={onViewPrompt}>View Prompt</button>
			{#if experiment.errorMessage}
				<span class="err">{experiment.errorMessage}</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.hud {
		position: fixed;
		top: 12px;
		left: 12px;
		background: var(--ui-bg, rgba(12, 12, 18, 0.85));
		border: 1px solid var(--ui-border, rgba(255, 255, 255, 0.08));
		border-radius: 12px;
		backdrop-filter: blur(18px);
		-webkit-backdrop-filter: blur(18px);
		padding: 10px 14px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 12px;
		color: var(--ui-text-hover, #fff);
		z-index: 50;
		max-width: calc(100vw - 336px);
	}

	.top-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.pill {
		background: var(--ui-accent, #2dd4bf);
		color: #000;
		font-weight: 700;
		font-size: 10px;
		letter-spacing: 0.1em;
		padding: 2px 8px;
		border-radius: 999px;
	}

	.label {
		font-weight: 500;
		color: var(--ui-text-hover, #fff);
	}

	.status {
		font-size: 11px;
		margin-left: auto;
	}

	.muted {
		color: var(--ui-text, #888);
		font-size: 11px;
	}

	.info-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		font-size: 11px;
	}

	.info-row .k {
		color: var(--ui-text, #888);
		margin-right: 3px;
	}

	.info-row .v {
		color: var(--ui-text-hover, #fff);
		font-variant-numeric: tabular-nums;
	}

	.info-row .mono {
		font-family: 'SF Mono', 'Fira Code', monospace;
	}

	.info-row .cost {
		color: #22c55e;
	}

	.dot {
		color: var(--ui-text, #888);
		opacity: 0.5;
	}

	.action-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.link-btn {
		background: none;
		border: none;
		color: var(--ui-accent, #2dd4bf);
		font-size: 11px;
		cursor: pointer;
		padding: 0;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.link-btn:hover {
		filter: brightness(1.2);
	}

	.err {
		color: #ef4444;
		font-size: 11px;
	}
</style>
