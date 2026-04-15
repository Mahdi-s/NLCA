<script lang="ts">
	import type { Experiment } from '$lib/nlca/experimentManager.svelte.js';

	interface Props {
		experiments: Experiment[];
		activeId: string | null;
		onselect: (id: string) => void;
		onnew: () => void;
		onpause: (id: string) => void;
		onresume: (id: string) => void;
		ondelete: (id: string) => void;
	}

	let { experiments, activeId, onselect, onnew, onpause, onresume, ondelete }: Props = $props();

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
			case 'running': return 'var(--color-success, #22c55e)';
			case 'paused': return 'var(--color-warning, #eab308)';
			case 'completed': return 'var(--color-info, #3b82f6)';
			case 'error': return 'var(--color-error, #ef4444)';
			default: return 'var(--color-muted, #6b7280)';
		}
	}
</script>

<div class="experiment-tabs">
	{#each experiments as exp (exp.id)}
		<button
			class="tab"
			class:active={exp.id === activeId}
			onclick={() => onselect(exp.id)}
			title={`${exp.label}\n${exp.config.model}\n${exp.progress.current}/${exp.progress.target} frames`}
		>
			<span class="status-icon" style="color: {statusColor(exp.status)}">{statusIcon(exp.status)}</span>
			<span class="tab-label">{exp.label}</span>
			<span class="tab-progress">{exp.progress.current}/{exp.progress.target}</span>
			<div class="tab-actions">
				{#if exp.status === 'running'}
					<button class="tab-action" onclick={(e) => { e.stopPropagation(); onpause(exp.id); }} title="Pause">⏸</button>
				{:else if exp.status === 'paused'}
					<button class="tab-action" onclick={(e) => { e.stopPropagation(); onresume(exp.id); }} title="Resume">▶</button>
				{/if}
				<button class="tab-action delete" onclick={(e) => { e.stopPropagation(); ondelete(exp.id); }} title="Delete">×</button>
			</div>
		</button>
	{/each}
	<button class="tab new-tab" onclick={onnew} title="New Experiment">
		+ New
	</button>
</div>

<style>
	.experiment-tabs {
		display: flex;
		gap: 2px;
		padding: 4px 8px;
		background: var(--color-surface-dark, #111);
		overflow-x: auto;
		scrollbar-width: thin;
		border-bottom: 1px solid var(--color-border, #333);
	}

	.tab {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		background: var(--color-surface, #1a1a1a);
		border: 1px solid var(--color-border, #333);
		border-bottom: none;
		border-radius: 6px 6px 0 0;
		color: var(--color-text-muted, #999);
		cursor: pointer;
		font-size: 12px;
		white-space: nowrap;
		transition: background 0.15s, color 0.15s;
	}

	.tab:hover {
		background: var(--color-surface-hover, #252525);
		color: var(--color-text, #eee);
	}

	.tab.active {
		background: var(--color-surface-active, #222);
		color: var(--color-text, #eee);
		border-color: var(--color-primary, #6366f1);
	}

	.status-icon { font-size: 10px; }

	.tab-label {
		max-width: 180px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tab-progress {
		color: var(--color-text-muted, #666);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
	}

	.tab-actions {
		display: flex;
		gap: 2px;
		margin-left: 4px;
	}

	.tab-action {
		background: none;
		border: none;
		color: var(--color-text-muted, #999);
		cursor: pointer;
		font-size: 12px;
		padding: 0 2px;
		border-radius: 3px;
	}

	.tab-action:hover {
		color: var(--color-text, #eee);
		background: var(--color-surface-hover, #333);
	}

	.tab-action.delete:hover { color: var(--color-error, #ef4444); }

	.new-tab {
		border-style: dashed;
		color: var(--color-text-muted, #666);
		font-weight: 500;
	}

	.new-tab:hover {
		color: var(--color-primary, #6366f1);
		border-color: var(--color-primary, #6366f1);
	}
</style>
