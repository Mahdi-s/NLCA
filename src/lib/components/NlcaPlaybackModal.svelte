<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { draggable } from '$lib/utils/draggable.js';
	import { bringToFront, setModalPosition, getModalState } from '$lib/stores/modalManager.svelte.js';
	import { getSimulationRef, getSimulationState } from '$lib/stores/simulation.svelte.js';
	import { getNlcaSettingsState } from '$lib/stores/nlcaSettings.svelte.js';
	import { NlcaTape, unpackBitsetTo01 } from '$lib/nlca/tape.js';
	import type { NlcaRunConfig } from '$lib/nlca/types.js';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();
	const modalState = $derived(getModalState('nlcaPlayback'));
	const simState = getSimulationState();
	const nlcaSettings = getNlcaSettingsState();

	const tape = new NlcaTape();

	let runs = $state<NlcaRunConfig[]>([]);
	let selectedRunId = $state<string | null>(null);
	let selectedRun = $derived(runs.find((r) => r.runId === selectedRunId) ?? null);

	let latestGen = $state(0);
	let currentGen = $state(0);
	let isPlayingTape = $state(false);
	let playInterval: ReturnType<typeof setInterval> | null = null;
	let status = $state<string | null>(null);
	let playbackFps = $state(10); // Playback speed in frames per second
	let dimensionMismatch = $derived(
		selectedRun !== null &&
		(selectedRun.width !== simState.gridWidth || selectedRun.height !== simState.gridHeight)
	);

	function handleModalClick() {
		bringToFront('nlcaPlayback');
	}
	function handleDragEnd(position: { x: number; y: number }) {
		setModalPosition('nlcaPlayback', position);
	}

	async function refreshRuns() {
		await tape.init();
		runs = await tape.listRuns();
		if (!selectedRunId && runs[0]) selectedRunId = runs[0].runId;
		if (selectedRunId) {
			latestGen = await tape.getLatestGeneration(selectedRunId);
			currentGen = Math.min(currentGen || latestGen, latestGen);
		}
	}

	async function loadFrame(gen: number) {
		if (!selectedRun) return;

		// Guard against dimension mismatch — writing a differently-sized grid into
		// the current WebGPU buffers causes silent corruption or GPU errors.
		if (selectedRun.width !== simState.gridWidth || selectedRun.height !== simState.gridHeight) {
			status = `Canvas is ${simState.gridWidth}×${simState.gridHeight} but this run was recorded at ${selectedRun.width}×${selectedRun.height}. Resize the canvas first.`;
			return;
		}

		const sim = getSimulationRef();
		if (!sim) return;

		status = null;
		const frame = await tape.getFrame(selectedRun.runId, gen);
		if (!frame) {
			status = `No frame found for generation ${gen}`;
			return;
		}

		const nCells = selectedRun.width * selectedRun.height;
		const grid = unpackBitsetTo01(frame.stateBits, nCells);
		sim.setCellData(grid);
		simState.generation = gen;
		simState.aliveCells = sim.countAliveCells();
	}

	/**
	 * Resize the canvas to match the selected run's dimensions, then load the
	 * requested generation. The settings store change triggers a reactive resize
	 * in Canvas.svelte; we wait one Svelte tick for the DOM/store update to
	 * propagate before loading the frame.
	 */
	async function resizeAndLoad(gen: number) {
		if (!selectedRun) return;
		stopTape();
		// Update the settings store — the $effect in Canvas.svelte will call resize().
		nlcaSettings.gridWidth = selectedRun.width;
		nlcaSettings.gridHeight = selectedRun.height;
		// Wait for Svelte to flush the reactive update and the canvas to resize.
		await tick();
		// Give the WebGPU resize one additional async tick to complete.
		await new Promise<void>((r) => setTimeout(r, 50));
		await loadFrame(gen);
	}

	function stopTape() {
		isPlayingTape = false;
		if (playInterval) {
			clearInterval(playInterval);
			playInterval = null;
		}
	}

	function startTape() {
		if (!selectedRunId) return;
		stopTape();
		isPlayingTape = true;
		// Playback speed: use dedicated FPS slider
		const ms = 1000 / Math.max(1, Math.min(60, playbackFps));
		playInterval = setInterval(async () => {
			if (!selectedRunId) return;
			if (currentGen >= latestGen) {
				stopTape();
				return;
			}
			currentGen += 1;
			await loadFrame(currentGen);
		}, ms);
	}
	
	// Step to previous frame
	async function prevFrame() {
		if (currentGen > 0) {
			stopTape();
			currentGen -= 1;
			await loadFrame(currentGen);
		}
	}
	
	// Step to next frame
	async function nextFrame() {
		if (currentGen < latestGen) {
			stopTape();
			currentGen += 1;
			await loadFrame(currentGen);
		}
	}

	onMount(async () => {
		await refreshRuns();
		if (selectedRunId) {
			latestGen = await tape.getLatestGeneration(selectedRunId);
			currentGen = latestGen;
			if (latestGen > 0) await loadFrame(latestGen);
		}
	});

	onDestroy(() => {
		stopTape();
	});
</script>

<div class="modal-backdrop" role="presentation" style="z-index: {modalState.zIndex};">
	<div
		class="modal"
		role="dialog"
		aria-label="NLCA Playback"
		tabindex="0"
		use:draggable={{ onDragEnd: handleDragEnd }}
		onclick={handleModalClick}
		onkeydown={() => {}}
		style={modalState.position ? `transform: translate(${modalState.position.x}px, ${modalState.position.y}px);` : ''}
	>
		<div class="header">
			<h3>Playback</h3>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</div>
		<div class="content">
			<div class="row">
				<label>
					<span>Run</span>
					<select
						bind:value={selectedRunId}
						onchange={async () => {
							stopTape();
							await refreshRuns();
							if (selectedRunId) {
								latestGen = await tape.getLatestGeneration(selectedRunId);
								currentGen = latestGen;
								if (latestGen > 0) await loadFrame(latestGen);
							}
						}}
					>
						{#each runs as r (r.runId)}
							<option value={r.runId}>
								{new Date(r.createdAt).toLocaleString()} — {r.width}×{r.height} — {r.neighborhood}
							</option>
						{/each}
					</select>
				</label>
				<div class="btn-row">
					<button class="btn" onclick={refreshRuns}>Refresh</button>
					{#if isPlayingTape}
						<button class="btn primary" onclick={stopTape}>Stop</button>
					{:else}
						<button class="btn primary" onclick={startTape} disabled={!selectedRunId || latestGen === 0 || dimensionMismatch}>Play</button>
					{/if}
				</div>
			</div>

		{#if dimensionMismatch && selectedRun}
			<div class="mismatch-banner">
				<span>
					Canvas is {simState.gridWidth}×{simState.gridHeight} — this run was {selectedRun.width}×{selectedRun.height}.
					Playing without resizing will corrupt the WebGPU buffers.
				</span>
				<button class="btn primary" onclick={() => resizeAndLoad(currentGen || latestGen)}>
					Resize to {selectedRun.width}×{selectedRun.height} and Load
				</button>
			</div>
		{/if}

		{#if selectedRun}
			<div class="slider">
					<div class="meta">
						<span>Generation: {currentGen} / {latestGen}</span>
						<div class="step-controls">
							<button class="btn small" onclick={prevFrame} disabled={currentGen <= 0} aria-label="Previous frame">
								◀
							</button>
							<button class="btn small" onclick={nextFrame} disabled={currentGen >= latestGen} aria-label="Next frame">
								▶
							</button>
							<button
								class="btn small"
								onclick={async () => {
									stopTape();
									currentGen = latestGen;
									if (latestGen > 0) await loadFrame(latestGen);
								}}
								disabled={!selectedRunId || latestGen === 0}
							>
								Latest
							</button>
						</div>
					</div>
					<input
						type="range"
						min="0"
						max={latestGen}
						step="1"
						value={currentGen}
						oninput={async (e) => {
							stopTape();
							currentGen = Number((e.currentTarget as HTMLInputElement).value);
							await loadFrame(currentGen);
						}}
					/>
				</div>
				
				<div class="speed-control">
					<label>
						<span>Playback Speed: {playbackFps} fps</span>
						<input
							type="range"
							min="1"
							max="60"
							step="1"
							bind:value={playbackFps}
							onchange={() => {
								// If playing, restart with new speed
								if (isPlayingTape) {
									startTape();
								}
							}}
						/>
					</label>
				</div>
			{:else}
				<p class="muted">No NLCA runs found yet — generate a few frames in the NLCA canvas first.</p>
			{/if}

			{#if status}
				<p class="status">{status}</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.modal-backdrop { position: fixed; inset: 0; }
	.modal {
		position: absolute;
		left: 50%;
		top: 22%;
		transform: translate(-50%, 0);
		width: min(520px, calc(100vw - 24px));
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
	.content { padding: 14px 16px; }
	.row { display: flex; gap: 12px; align-items: end; justify-content: space-between; flex-wrap: wrap; }
	label { display: grid; gap: 6px; min-width: 260px; flex: 1; }
	select {
		width: 100%;
		border-radius: 12px;
		border: 1px solid var(--ui-border);
		background: var(--ui-input-bg);
		color: var(--ui-text-hover);
		padding: 10px 12px;
	}
	.btn-row { display: flex; gap: 10px; }
	.btn {
		height: 38px;
		padding: 0 12px;
		border-radius: 12px;
		border: 1px solid var(--ui-border);
		background: var(--btn-bg);
		color: var(--ui-text-hover);
		cursor: pointer;
	}
	.btn.primary { background: var(--ui-accent); color: #000; border-color: transparent; }
	.btn.small { height: 30px; border-radius: 10px; padding: 0 10px; }
	.btn:disabled { opacity: 0.45; cursor: not-allowed; }

	.slider { margin-top: 14px; display: grid; gap: 10px; }
	.slider input[type='range'] { width: 100%; }
	.meta { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
	.step-controls { display: flex; gap: 6px; }
	.speed-control { margin-top: 14px; }
	.speed-control label { display: grid; gap: 6px; }
	.speed-control input[type='range'] { width: 100%; }
	.muted { color: var(--ui-text); }
	.status { margin-top: 10px; color: var(--ui-text-hover); }
	.mismatch-banner {
		margin-top: 12px;
		padding: 10px 14px;
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--ui-accent) 40%, transparent);
		background: color-mix(in srgb, var(--ui-accent) 10%, transparent);
		display: flex;
		flex-direction: column;
		gap: 10px;
		font-size: 0.875em;
	}
</style>


