<script lang="ts">
	import { onMount } from 'svelte';
	import { draggable } from '$lib/utils/draggable.js';
	import { bringToFront, setModalPosition, getModalState } from '$lib/stores/modalManager.svelte.js';
	import { getSimulationState } from '$lib/stores/simulation.svelte.js';

	interface Props {
		onclose: () => void;
		/** Current buffer status (passed from Canvas) */
		bufferStatus?: {
			bufferedCount: number;
			hasMinBuffer: boolean;
			isComputing: boolean;
			computingGeneration: number | null;
			computingProgress: number;
			avgFrameTimeMs: number;
			targetBufferSize: number;
			minBufferSize: number;
		} | null;
		/** Whether a batch run is active */
		batchRunActive: boolean;
		/** Target generations for current batch run */
		batchRunTarget: number;
		/** Completed generations in current batch run */
		batchRunCompleted: number;
		/** Start batch run callback */
		onStartBatchRun: (generations: number) => void;
		/** Cancel batch run callback */
		onCancelBatchRun: () => void;
		/** Estimate time callback */
		estimateTime: (generations: number) => number;
	}

	let { 
		onclose,
		bufferStatus = null,
		batchRunActive,
		batchRunTarget,
		batchRunCompleted,
		onStartBatchRun,
		onCancelBatchRun,
		estimateTime
	}: Props = $props();

	const modalState = $derived(getModalState('nlcaBatchRun'));
	const simState = getSimulationState();

	// Form state
	let targetGenerations = $state(10);

	// Computed time estimate
	const timeEstimate = $derived.by(() => {
		const ms = estimateTime(targetGenerations);
		return formatTime(ms);
	});

	// Progress percentage
	const progressPercent = $derived.by(() => {
		if (!batchRunActive || batchRunTarget === 0) return 0;
		return (batchRunCompleted / batchRunTarget) * 100;
	});

	// Cells per second (for display)
	const cellsPerSec = $derived.by(() => {
		if (!bufferStatus || bufferStatus.avgFrameTimeMs === 0) return null;
		const cellCount = simState.gridWidth * simState.gridHeight;
		return Math.round((cellCount / bufferStatus.avgFrameTimeMs) * 1000);
	});

	function formatTime(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		const mins = Math.floor(ms / 60000);
		const secs = Math.round((ms % 60000) / 1000);
		return `${mins}m ${secs}s`;
	}

	function handleModalClick() {
		bringToFront('nlcaBatchRun');
	}

	function handleDragEnd(position: { x: number; y: number }) {
		setModalPosition('nlcaBatchRun', position);
	}

	function handleStart() {
		if (targetGenerations > 0) {
			onStartBatchRun(targetGenerations);
		}
	}

	function handleCancel() {
		onCancelBatchRun();
	}

	// Presets for quick selection
	const presets = [5, 10, 25, 50, 100];
</script>

<div class="modal-backdrop" role="presentation" style="z-index: {modalState.zIndex};">
	<div
		class="modal"
		role="dialog"
		aria-label="Batch Run"
		tabindex="0"
		use:draggable={{ onDragEnd: handleDragEnd }}
		onclick={handleModalClick}
		onkeydown={() => {}}
		style={modalState.position ? `transform: translate(${modalState.position.x}px, ${modalState.position.y}px);` : ''}
	>
		<div class="header">
			<h3>Batch Run</h3>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</div>

		<div class="content">
			{#if !batchRunActive}
				<!-- Configuration Mode -->
				<div class="section">
					<label class="field">
						<span class="label">Target Generations</span>
						<div class="input-row">
							<input 
								type="number" 
								min="1" 
								max="1000" 
								bind:value={targetGenerations}
							/>
							<span class="unit">frames</span>
						</div>
					</label>

					<div class="presets">
						{#each presets as preset (preset)}
							<button 
								class="preset-btn"
								class:active={targetGenerations === preset}
								onclick={() => targetGenerations = preset}
							>
								{preset}
							</button>
						{/each}
					</div>
				</div>

				<div class="section estimate">
					<div class="estimate-row">
						<span class="label">Estimated Time</span>
						<span class="value">{timeEstimate}</span>
					</div>
					<div class="estimate-row muted">
						<span>Grid: {simState.gridWidth}×{simState.gridHeight}</span>
						<span>Cells: {simState.gridWidth * simState.gridHeight}</span>
					</div>
					{#if bufferStatus?.avgFrameTimeMs}
						<div class="estimate-row muted">
							<span>Avg frame time: {formatTime(bufferStatus.avgFrameTimeMs)}</span>
						</div>
					{/if}
				</div>

				<div class="hint">
					<p>
						Frames will be computed ahead and buffered for smooth playback.
						Playback starts automatically after 5 frames are ready.
					</p>
				</div>
			{:else}
				<!-- Progress Mode -->
				<div class="section progress-section">
					<div class="progress-header">
						<span>Computing frame {batchRunCompleted + 1} of {batchRunTarget}</span>
						{#if cellsPerSec}
							<span class="muted">{cellsPerSec} cells/sec</span>
						{/if}
					</div>

					<div class="progress-bar">
						<div class="progress-fill" style="width: {progressPercent}%"></div>
					</div>

					<div class="progress-details">
						<span>{batchRunCompleted} / {batchRunTarget} complete</span>
						<span>{Math.round(progressPercent)}%</span>
					</div>

					{#if bufferStatus}
						<div class="buffer-status">
							<span class="label">Buffer</span>
							<div class="buffer-bar">
								<div 
									class="buffer-fill" 
									style="width: {(bufferStatus.bufferedCount / bufferStatus.targetBufferSize) * 100}%"
								></div>
							</div>
							<span class="buffer-count">{bufferStatus.bufferedCount}/{bufferStatus.targetBufferSize}</span>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<div class="footer">
			{#if !batchRunActive}
				<button class="btn" onclick={onclose}>Cancel</button>
				<button class="btn primary" onclick={handleStart} disabled={targetGenerations < 1}>
					Start Batch Run
				</button>
			{:else}
				<button class="btn" onclick={handleCancel}>
					Stop
				</button>
				<button class="btn primary" onclick={onclose}>
					Run in Background
				</button>
			{/if}
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
		top: 20%;
		transform: translate(-50%, 0);
		width: min(400px, calc(100vw - 24px));
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
	.header h3 {
		margin: 0;
		font-size: 1rem;
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
		padding: 16px;
		display: grid;
		gap: 16px;
	}
	.section {
		display: grid;
		gap: 12px;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.field .label {
		font-size: 0.85rem;
		color: var(--ui-text);
	}
	.input-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.input-row input {
		flex: 1;
		height: 42px;
		padding: 0 12px;
		border-radius: 10px;
		border: 1px solid var(--ui-border);
		background: var(--ui-input-bg);
		color: var(--ui-text-hover);
		font-size: 1rem;
	}
	.input-row input:focus {
		outline: none;
		border-color: var(--ui-accent);
	}
	.input-row .unit {
		color: var(--ui-text);
		font-size: 0.85rem;
	}
	.presets {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.preset-btn {
		padding: 6px 14px;
		border-radius: 8px;
		border: 1px solid var(--ui-border);
		background: var(--btn-bg);
		color: var(--ui-text);
		cursor: pointer;
		font-size: 0.85rem;
	}
	.preset-btn:hover {
		background: rgba(255, 255, 255, 0.08);
	}
	.preset-btn.active {
		background: var(--ui-accent);
		color: #000;
		border-color: transparent;
	}
	.estimate {
		background: rgba(0, 0, 0, 0.2);
		padding: 12px;
		border-radius: 12px;
	}
	.estimate-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.estimate-row .label {
		color: var(--ui-text);
		font-size: 0.85rem;
	}
	.estimate-row .value {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--ui-accent);
	}
	.estimate-row.muted {
		font-size: 0.75rem;
		color: var(--ui-text);
		margin-top: 4px;
	}
	.hint {
		padding: 10px 12px;
		background: rgba(100, 200, 100, 0.08);
		border-radius: 10px;
		font-size: 0.8rem;
		color: var(--ui-text);
		line-height: 1.4;
	}
	.hint p {
		margin: 0;
	}

	/* Progress mode styles */
	.progress-section {
		gap: 14px;
	}
	.progress-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.progress-header .muted {
		font-size: 0.8rem;
		color: var(--ui-text);
	}
	.progress-bar {
		height: 8px;
		background: rgba(255, 255, 255, 0.1);
		border-radius: 4px;
		overflow: hidden;
	}
	.progress-fill {
		height: 100%;
		background: var(--ui-accent);
		border-radius: 4px;
		transition: width 0.2s ease-out;
	}
	.progress-details {
		display: flex;
		justify-content: space-between;
		font-size: 0.85rem;
		color: var(--ui-text);
	}
	.buffer-status {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px;
		background: rgba(0, 0, 0, 0.2);
		border-radius: 10px;
	}
	.buffer-status .label {
		font-size: 0.8rem;
		color: var(--ui-text);
	}
	.buffer-bar {
		flex: 1;
		height: 6px;
		background: rgba(255, 255, 255, 0.1);
		border-radius: 3px;
		overflow: hidden;
	}
	.buffer-fill {
		height: 100%;
		background: rgba(100, 200, 100, 0.6);
		border-radius: 3px;
		transition: width 0.1s;
	}
	.buffer-count {
		font-size: 0.75rem;
		color: var(--ui-text);
		min-width: 45px;
		text-align: right;
	}

	/* Footer */
	.footer {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		padding: 14px 16px;
		border-top: 1px solid var(--ui-border);
	}
	.btn {
		height: 38px;
		padding: 0 16px;
		border-radius: 12px;
		border: 1px solid var(--ui-border);
		background: var(--btn-bg);
		color: var(--ui-text-hover);
		cursor: pointer;
	}
	.btn:hover {
		background: rgba(255, 255, 255, 0.1);
	}
	.btn.primary {
		background: var(--ui-accent);
		color: #000;
		border-color: transparent;
	}
	.btn.primary:hover {
		filter: brightness(1.1);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

