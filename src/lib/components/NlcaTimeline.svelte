<script lang="ts">
	import { getSimulationState } from '$lib/stores/simulation.svelte.js';
	import type { BufferedFrame, BufferStatus } from '$lib/nlca/frameBuffer.js';

	interface Props {
		/** Current generation being displayed */
		currentGeneration: number;
		/** All buffered frames */
		bufferedFrames: readonly BufferedFrame[];
		/** Buffer status */
		bufferStatus: BufferStatus | null;
		/** Whether a batch run is active */
		batchRunActive: boolean;
		/** Target generations for batch run */
		batchRunTarget: number;
		/** Completed generations in batch run */
		batchRunCompleted: number;
		/** Callback when user clicks a frame */
		onSeek?: (generation: number) => void;
	}

	let {
		currentGeneration,
		bufferedFrames,
		bufferStatus,
		batchRunActive,
		batchRunTarget,
		batchRunCompleted,
		onSeek
	}: Props = $props();

	const simState = getSimulationState();

	// Calculate the range of frames to display
	const displayRange = $derived.by(() => {
		const startGen = 0;
		const endGen = batchRunActive 
			? Math.max(currentGeneration, batchRunTarget)
			: Math.max(currentGeneration, currentGeneration + 10);
		return { start: startGen, end: endGen };
	});

	// Generate frame markers
	const frameMarkers = $derived.by(() => {
		const markers: Array<{
			generation: number;
			status: 'computed' | 'buffered' | 'computing' | 'pending' | 'current';
			isInteractive: boolean;
		}> = [];

		const { start, end } = displayRange;
		const bufferedGens = new Set(bufferedFrames.map(f => f.generation));
		const computingGen = bufferStatus?.computingGeneration ?? null;

		for (let gen = start; gen <= end; gen++) {
			let status: 'computed' | 'buffered' | 'computing' | 'pending' | 'current';
			
			if (gen === currentGeneration) {
				status = 'current';
			} else if (gen < currentGeneration) {
				status = 'computed';
			} else if (bufferedGens.has(gen)) {
				status = 'buffered';
			} else if (gen === computingGen) {
				status = 'computing';
			} else {
				status = 'pending';
			}

			markers.push({
				generation: gen,
				status,
				isInteractive: status === 'computed' || status === 'buffered'
			});
		}

		return markers;
	});

	// Progress percentage for the computing indicator
	const computingProgress = $derived(bufferStatus?.computingProgress ?? 0);

	function handleFrameClick(marker: typeof frameMarkers[0]) {
		if (marker.isInteractive && onSeek) {
			onSeek(marker.generation);
		}
	}
</script>

<div class="timeline-container">
	<div class="timeline-header">
		<span class="label">Frame</span>
		<span class="current-gen">{currentGeneration}</span>
		{#if batchRunActive}
			<span class="batch-info">
				{batchRunCompleted}/{batchRunTarget}
			</span>
		{/if}
	</div>

	<div class="timeline-track">
		<div class="frames-container">
			{#each frameMarkers as marker (marker.generation)}
				<button
					class="frame-marker"
					class:computed={marker.status === 'computed'}
					class:buffered={marker.status === 'buffered'}
					class:computing={marker.status === 'computing'}
					class:pending={marker.status === 'pending'}
					class:current={marker.status === 'current'}
					class:interactive={marker.isInteractive}
					disabled={!marker.isInteractive}
					onclick={() => handleFrameClick(marker)}
					data-gen={marker.generation}
					aria-label="Generation {marker.generation}"
				>
					{#if marker.status === 'computing'}
						<div class="computing-progress" style="width: {computingProgress * 100}%"></div>
					{/if}
				</button>
			{/each}
		</div>
	</div>

	{#if bufferStatus}
		<div class="buffer-info">
			<span class="buffer-label">Buffer:</span>
			<div class="buffer-mini-bar">
				<div 
					class="buffer-mini-fill" 
					style="width: {(bufferStatus.bufferedCount / bufferStatus.targetBufferSize) * 100}%"
				></div>
			</div>
			<span class="buffer-count">{bufferStatus.bufferedCount}</span>
		</div>
	{/if}
</div>

<style>
	.timeline-container {
		display: grid;
		gap: 8px;
		padding: 10px 12px;
		background: var(--ui-bg);
		border: 1px solid var(--ui-border);
		border-radius: 12px;
		backdrop-filter: blur(12px);
		min-width: 200px;
	}

	.timeline-header {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.8rem;
	}

	.label {
		color: var(--ui-text);
	}

	.current-gen {
		font-weight: 600;
		color: var(--ui-accent);
		font-family: 'SF Mono', 'Fira Code', monospace;
	}

	.batch-info {
		margin-left: auto;
		color: var(--ui-text);
		font-size: 0.75rem;
	}

	.timeline-track {
		overflow-x: auto;
		padding: 4px 0;
		scrollbar-width: thin;
		scrollbar-color: var(--ui-border) transparent;
	}

	.timeline-track::-webkit-scrollbar {
		height: 6px;
	}

	.timeline-track::-webkit-scrollbar-track {
		background: transparent;
	}

	.timeline-track::-webkit-scrollbar-thumb {
		background: var(--ui-border);
		border-radius: 3px;
	}

	.frames-container {
		display: flex;
		gap: 3px;
		min-width: min-content;
	}

	.frame-marker {
		width: 8px;
		height: 24px;
		border-radius: 3px;
		border: none;
		cursor: default;
		position: relative;
		overflow: hidden;
		transition: transform 0.1s, background 0.15s;
		flex-shrink: 0;
	}

	.frame-marker.computed {
		background: rgba(100, 200, 100, 0.4);
	}

	.frame-marker.buffered {
		background: rgba(100, 200, 100, 0.6);
	}

	.frame-marker.computing {
		background: rgba(255, 180, 100, 0.3);
	}

	.frame-marker.pending {
		background: rgba(255, 255, 255, 0.1);
	}

	.frame-marker.current {
		background: var(--ui-accent);
		transform: scaleY(1.2);
	}

	.frame-marker.interactive {
		cursor: pointer;
	}

	.frame-marker.interactive:hover {
		transform: scaleY(1.3);
		background: var(--ui-accent);
	}

	.computing-progress {
		position: absolute;
		bottom: 0;
		left: 0;
		height: 100%;
		background: rgba(255, 180, 100, 0.6);
		transition: width 0.1s;
	}

	.buffer-info {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.7rem;
	}

	.buffer-label {
		color: var(--ui-text);
	}

	.buffer-mini-bar {
		flex: 1;
		height: 4px;
		background: rgba(255, 255, 255, 0.1);
		border-radius: 2px;
		overflow: hidden;
	}

	.buffer-mini-fill {
		height: 100%;
		background: rgba(100, 200, 100, 0.5);
		transition: width 0.1s;
	}

	.buffer-count {
		color: var(--ui-text);
		font-family: 'SF Mono', 'Fira Code', monospace;
		min-width: 20px;
		text-align: right;
	}
</style>

