<script lang="ts">
	import { draggable } from '$lib/utils/draggable.js';
	import { bringToFront, setModalPosition, getModalState } from '$lib/stores/modalManager.svelte.js';
	import type { Experiment } from '$lib/nlca/experimentManager.svelte.js';

	interface Props {
		experiment: Experiment | null;
		onclose: () => void;
	}

	let { experiment, onclose }: Props = $props();
	const modalState = $derived(getModalState('nlcaPromptViewer'));

	function handleModalClick() {
		bringToFront('nlcaPromptViewer');
	}
	function handleDragEnd(position: { x: number; y: number }) {
		setModalPosition('nlcaPromptViewer', position);
	}
</script>

<div class="modal-backdrop" role="presentation" style="z-index: {modalState.zIndex};">
	<div
		class="modal"
		role="dialog"
		aria-label="Experiment Prompt"
		tabindex="0"
		use:draggable={{ onDragEnd: handleDragEnd }}
		onclick={handleModalClick}
		onkeydown={() => {}}
		style={modalState.position ? `transform: translate(${modalState.position.x}px, ${modalState.position.y}px);` : ''}
	>
		<div class="header">
			<h3>Experiment Prompt {experiment ? `— ${experiment.label}` : ''}</h3>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</div>

		<div class="content">
			{#if !experiment}
				<div class="empty">No experiment selected.</div>
			{:else}
				<div class="section">
					<div class="section-label">Task</div>
					<pre class="readonly-text">{experiment.config.taskDescription || '(empty)'}</pre>
				</div>

				{#if experiment.config.useAdvancedMode && experiment.config.advancedTemplate}
					<div class="section">
						<div class="section-label">Advanced Template</div>
						<pre class="readonly-text">{experiment.config.advancedTemplate}</pre>
					</div>
				{/if}

				<div class="section">
					<div class="section-label">Configuration</div>
					<div class="kv-grid">
						<span class="k">Model</span><span class="v">{experiment.config.model}</span>
						<span class="k">Neighborhood</span><span class="v">{experiment.config.neighborhood}</span>
						<span class="k">Grid</span><span class="v">{experiment.config.gridWidth}×{experiment.config.gridHeight}</span>
						<span class="k">Memory window</span><span class="v">{experiment.config.memoryWindow}</span>
						<span class="k">Cell colors</span><span class="v">{experiment.config.cellColorEnabled ? 'enabled' : 'disabled'}</span>
					</div>
				</div>
			{/if}
		</div>

		<div class="footer">
			<button class="btn" onclick={onclose}>Close</button>
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
		top: 15%;
		transform: translate(-50%, 0);
		width: min(560px, calc(100vw - 24px));
		max-height: 75vh;
		background: var(--ui-bg);
		border: 1px solid var(--ui-border);
		border-radius: 18px;
		backdrop-filter: blur(18px);
		color: var(--ui-text-hover);
		display: flex;
		flex-direction: column;
	}
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 16px;
		border-bottom: 1px solid var(--ui-border);
	}
	.header h3 {
		font-size: 14px;
		font-weight: 600;
		margin: 0;
	}
	.close {
		width: 30px;
		height: 30px;
		border-radius: 8px;
		border: 1px solid var(--ui-border);
		background: var(--btn-bg);
		color: var(--ui-text-hover);
		cursor: pointer;
	}
	.content {
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		overflow-y: auto;
	}
	.section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.section-label {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--ui-text);
	}
	.readonly-text {
		background: var(--ui-input-bg);
		border: 1px solid var(--ui-border);
		border-radius: 10px;
		padding: 10px 12px;
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-word;
		font-family: inherit;
		color: var(--ui-text-hover);
		max-height: 240px;
		overflow-y: auto;
	}
	.kv-grid {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 14px;
		font-size: 12px;
	}
	.kv-grid .k {
		color: var(--ui-text);
	}
	.kv-grid .v {
		color: var(--ui-text-hover);
		font-variant-numeric: tabular-nums;
	}
	.empty {
		color: var(--ui-text);
		font-size: 12px;
		text-align: center;
		padding: 24px;
	}
	.footer {
		display: flex;
		justify-content: flex-end;
		padding: 12px 16px;
		border-top: 1px solid var(--ui-border);
	}
	.btn {
		height: 34px;
		padding: 0 14px;
		border-radius: 10px;
		border: 1px solid var(--ui-border);
		background: var(--btn-bg);
		color: var(--ui-text-hover);
		cursor: pointer;
		font-size: 13px;
	}
</style>
