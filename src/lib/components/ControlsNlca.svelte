<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { getSimulationState, getUIState, getSimulationRef } from '../stores/simulation.svelte.js';
	import { getModalStates } from '../stores/modalManager.svelte.js';
	import { canUndo, canRedo, undo as historyUndo, redo as historyRedo, subscribeHistory } from '../stores/history.js';
	import NlcaFrameScrubber from './NlcaFrameScrubber.svelte';
	import type { Experiment } from '$lib/nlca/experimentManager.svelte.js';

	interface Props {
		onclear: () => void;
		oninitialize: () => void;
		onstep: () => void;
		onresetview: () => void;
		onrecord: () => void;
		isRecording?: boolean;
		onhelp: () => void;
		onabout: () => void;
		onsettings: () => void;
		onnlcasettings: () => void;
		onnlcaprompt: () => void;
		onnlcabatchrun: () => void;
		showHelp?: boolean;
		showInitialize?: boolean;
		showAbout?: boolean;
		collapsed?: boolean;
		experimentActive?: boolean;
		experimentStatus?: 'running' | 'paused' | 'completed' | 'error';
		activeExperiment?: Experiment | null;
		/** True when a playback animation is actively advancing frames (not paused). */
		playbackActive?: boolean;
		onexperimentpause?: () => void;
		onexperimentresume?: () => void;
		onseek?: (generation: number) => void;
		onseekprev?: () => void;
		onseeknext?: () => void;
		onexperiments?: () => void;
		showExperimentPanel?: boolean;
	}

	let {
		onclear,
		oninitialize,
		onstep,
		onresetview,
		onrecord,
		isRecording = false,
		onhelp,
		onabout,
		onsettings,
		onnlcasettings,
		onnlcaprompt,
		onnlcabatchrun,
		showHelp = false,
		showInitialize = false,
		showAbout = false,
		collapsed = $bindable(false),
		experimentActive = false,
		experimentStatus,
		activeExperiment = null,
		playbackActive = false,
		onexperimentpause,
		onexperimentresume,
		onseek,
		onseekprev,
		onseeknext,
		onexperiments,
		showExperimentPanel = false
	}: Props = $props();

	const simState = getSimulationState();
	const uiState = getUIState();
	const modalStates = $derived(getModalStates());

	let showSpeedSlider = $state(false);
	let isSpeedDragging = $state(false);
	const MAX_SPEED = 1000;

	function clampSpeed(value: number): number {
		if (!Number.isFinite(value)) return 1;
		return Math.max(1, Math.min(MAX_SPEED, Math.round(value)));
	}
	function speedFromKnob(knob: number): number {
		const t = Math.max(0, Math.min(1, knob / MAX_SPEED));
		return clampSpeed(1 + t * t * (MAX_SPEED - 1));
	}
	function knobFromSpeed(speed: number): number {
		const t = Math.sqrt((clampSpeed(speed) - 1) / (MAX_SPEED - 1));
		return Math.round(t * MAX_SPEED);
	}
	let speedKnob = $state(0);
	const derivedSpeedKnob = $derived(knobFromSpeed(simState.speed));

	let historyUndoable = $state(false);
	let historyRedoable = $state(false);
	let unsubscribeHistory: (() => void) | null = null;

	function closeAllPopups() {
		showSpeedSlider = false;
	}

	function toggleSpeed() {
		const wasOpen = showSpeedSlider;
		closeAllPopups();
		showSpeedSlider = !wasOpen;
	}

	function openNlcaSettings() {
		closeAllPopups();
		onnlcasettings();
	}

	function openNlcaPrompt() {
		closeAllPopups();
		onnlcaprompt();
	}

	function openNlcaBatchRun() {
		closeAllPopups();
		onnlcabatchrun();
	}

	function openSettings() {
		closeAllPopups();
		onsettings();
	}

	function openInitialize() {
		closeAllPopups();
		oninitialize();
	}

	function handleHelp() {
		closeAllPopups();
		onhelp();
	}

	function refreshHistoryFlags() {
		historyUndoable = canUndo();
		historyRedoable = canRedo();
	}

	async function handleUndo() {
		const sim = getSimulationRef();
		if (!sim) return;
		const ok = await historyUndo(sim);
		if (ok) refreshHistoryFlags();
	}

	async function handleRedo() {
		const sim = getSimulationRef();
		if (!sim) return;
		const ok = await historyRedo(sim);
		if (ok) refreshHistoryFlags();
	}

	onMount(() => {
		refreshHistoryFlags();
		unsubscribeHistory = subscribeHistory(() => refreshHistoryFlags());
	});

	onDestroy(() => {
		if (unsubscribeHistory) unsubscribeHistory();
	});
</script>

{#if showSpeedSlider}
	<div class="popup-backdrop" role="presentation" onclick={closeAllPopups} onkeydown={() => {}}></div>
{/if}

<div class="controls" class:collapsed>
	{#if activeExperiment && onseek}
		<div class="scrubber-row">
			<NlcaFrameScrubber
				current={activeExperiment.currentGeneration}
				stored={activeExperiment.progress.current}
				target={activeExperiment.progress.target}
				onSeek={onseek}
			/>
		</div>
	{/if}
	<div class="button-row">
	<div class="button-group" id="tour-playback-group">
		{#if experimentActive}
			{@const showPause = experimentStatus === 'running' || playbackActive}
			<button
				class="control-btn primary"
				onclick={() => (showPause ? onexperimentpause?.() : onexperimentresume?.())}
				data-tooltip={showPause
					? 'Pause (Enter)'
					: activeExperiment && activeExperiment.progress.current > 0
						? 'Play — Replay Frames (Enter)'
						: 'Play / New Experiment (Enter)'}
			>
				{#if showPause}
					<svg viewBox="0 0 24 24" fill="currentColor">
						<rect x="6" y="4" width="4" height="16" rx="1" />
						<rect x="14" y="4" width="4" height="16" rx="1" />
					</svg>
				{:else}
					<svg viewBox="0 0 24 24" fill="currentColor">
						<path d="M8 5.14v14l11-7-11-7z" />
					</svg>
				{/if}
			</button>

			<button
				class="control-btn"
				onclick={onseekprev}
				disabled={experimentStatus === 'running' || !activeExperiment || activeExperiment.currentGeneration <= 1}
				data-tooltip="Previous Frame"
				aria-label="Previous Frame"
			>
				<svg viewBox="0 0 24 24" fill="currentColor">
					<path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
				</svg>
			</button>

			<button
				class="control-btn"
				onclick={onseeknext}
				disabled={experimentStatus === 'running' || !activeExperiment || activeExperiment.currentGeneration >= activeExperiment.progress.current}
				data-tooltip="Next Frame"
				aria-label="Next Frame"
			>
				<svg viewBox="0 0 24 24" fill="currentColor">
					<path d="M6 18l8.5-6L6 6v12zm2-8.14L11.03 12 8 14.14V9.86zM16 6h2v12h-2V6z" />
				</svg>
			</button>
		{:else}
			<button class="control-btn primary" onclick={() => simState.togglePlay()} data-tooltip={simState.isPlaying ? 'Pause (Enter)' : 'Play (Enter)'}>
				{#if simState.isPlaying}
					<svg viewBox="0 0 24 24" fill="currentColor">
						<rect x="6" y="4" width="4" height="16" rx="1" />
						<rect x="14" y="4" width="4" height="16" rx="1" />
					</svg>
				{:else}
					<svg viewBox="0 0 24 24" fill="currentColor">
						<path d="M8 5.14v14l11-7-11-7z" />
					</svg>
				{/if}
			</button>

			<button class="control-btn" onclick={onstep} data-tooltip="Step (S)" disabled={simState.isPlaying} aria-label="Step">
				<svg viewBox="0 0 24 24" fill="currentColor">
					<path d="M6 18l8.5-6L6 6v12zm2-8.14L11.03 12 8 14.14V9.86zM16 6h2v12h-2V6z" />
				</svg>
			</button>
		{/if}

		<div class="control-group">
			<button class="control-btn" onclick={toggleSpeed} data-tooltip="Speed" class:active={showSpeedSlider} aria-label="Speed">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
				</svg>
			</button>
			{#if showSpeedSlider}
				<div class="slider-popup">
					<span>{simState.speed} sps</span>
					<input
						type="range"
						min="0"
						max={MAX_SPEED}
						step="1"
						value={isSpeedDragging ? speedKnob : derivedSpeedKnob}
						onpointerdown={() => {
							isSpeedDragging = true;
							speedKnob = derivedSpeedKnob;
						}}
						onpointerup={() => (isSpeedDragging = false)}
						onchange={(e) => {
							const knob = Number((e.currentTarget as HTMLInputElement).value);
							speedKnob = knob;
							simState.speed = speedFromKnob(knob);
						}}
						oninput={(e) => {
							const knob = Number((e.currentTarget as HTMLInputElement).value);
							speedKnob = knob;
							simState.speed = speedFromKnob(knob);
						}}
					/>
					<input
						type="number"
						min="1"
						max={MAX_SPEED}
						step="1"
						value={simState.speed}
						onchange={(e) => {
							const v = clampSpeed(Number((e.currentTarget as HTMLInputElement).value));
							simState.speed = v;
						}}
						class="speed-number"
						aria-label="Speed (steps per second)"
					/>
				</div>
			{/if}
		</div>
	</div>

	<div class="button-group" id="tour-editing-group">
		<button class="control-btn" class:active={modalStates.nlcaSettings.isOpen} onclick={openNlcaSettings} data-tooltip="NLCA Settings" aria-label="NLCA Settings">
			<svg viewBox="0 0 24 24" fill="currentColor">
				<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 4a7.94 7.94 0 0 0-.16-1.6l2.02-1.57-2-3.46-2.44.99a8.03 8.03 0 0 0-2.77-1.6l-.37-2.6H9.78l-.37 2.6a8.03 8.03 0 0 0-2.77 1.6l-2.44-.99-2 3.46L3.2 10.4A7.94 7.94 0 0 0 3.06 12c0 .54.06 1.06.16 1.6l-2.02 1.57 2 3.46 2.44-.99c.82.68 1.75 1.2 2.77 1.6l.37 2.6h4.44l.37-2.6c1.02-.4 1.95-.92 2.77-1.6l2.44.99 2-3.46-2.02-1.57c.1-.54.16-1.06.16-1.6z" />
			</svg>
		</button>

		<button class="control-btn" class:active={modalStates.nlcaPrompt.isOpen} onclick={openNlcaPrompt} data-tooltip="Prompt" aria-label="Prompt">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
				<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
			</svg>
		</button>

		<button class="control-btn" class:active={modalStates.nlcaBatchRun.isOpen} onclick={openNlcaBatchRun} data-tooltip="Batch Run" aria-label="Batch Run">
			<svg viewBox="0 0 24 24" fill="currentColor">
				<path d="M13 3v18l-10-9 10-9z"/>
				<path d="M13 3v18l10-9-10-9z"/>
			</svg>
		</button>

		<button class="control-btn" class:active={showExperimentPanel} onclick={onexperiments} data-tooltip="Experiments (E)" aria-label="Experiments">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
				<rect x="9" y="3" width="6" height="4" rx="1" />
				<path d="M9 14h6" /><path d="M9 18h6" />
			</svg>
		</button>

		<button class="control-btn" class:active={showInitialize} onclick={openInitialize} data-tooltip="Initialize (I)" aria-label="Initialize">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<rect x="4" y="4" width="16" height="16" rx="2" />
				<circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
				<circle cx="16" cy="8" r="1.5" fill="currentColor" stroke="none" />
				<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
				<circle cx="8" cy="16" r="1.5" fill="currentColor" stroke="none" />
				<circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none" />
			</svg>
		</button>

		<button class="control-btn" onclick={onclear} data-tooltip="Clear Grid (D)" aria-label="Clear">
			<svg viewBox="0 0 24 24" fill="currentColor">
				<path d="M16 3H5a2 2 0 0 0-2 2v11h2V5h11V3zm3 4H9a2 2 0 0 0-2 2v13h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zm0 15H9V9h10v13z" />
			</svg>
		</button>
	</div>

	<div class="button-group">
		<button class="control-btn" onclick={handleUndo} data-tooltip="Undo" disabled={!historyUndoable} aria-label="Undo">
			<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.69 2.81l1.46 1.46A7.94 7.94 0 0 0 20 13c0-4.42-3.58-8-8-8z"/></svg>
		</button>
		<button class="control-btn" onclick={handleRedo} data-tooltip="Redo" disabled={!historyRedoable} aria-label="Redo">
			<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6 0 1.01.25 1.97.69 2.81L5.23 17.27A7.94 7.94 0 0 1 4 13c0-4.42 3.58-8 8-8z"/></svg>
		</button>
		<button class="control-btn" class:active={modalStates.settings.isOpen} onclick={openSettings} data-tooltip="Settings" aria-label="Settings">
			<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.07 7.07 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 1h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 7.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.82 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.4.32.64.22l2.39-.96c.51.4 1.05.71 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.24.1.51.01.64-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/></svg>
		</button>
		<button class="control-btn" class:active={showHelp} onclick={handleHelp} data-tooltip="Help" aria-label="Help">
			<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14a4 4 0 0 0-4 4h2a2 2 0 1 1 2 2c-1.1 0-2 .9-2 2v1h2v-1c0-.55.45-1 1-1a4 4 0 0 0 0-8z"/></svg>
		</button>
		<button class="control-btn" class:active={showAbout} onclick={onabout} data-tooltip="About" aria-label="About">
			<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
		</button>
		<button class="control-btn" onclick={onrecord} data-tooltip={isRecording ? 'Stop Recording' : 'Record Video'} aria-label="Record">
			{#if isRecording}
				<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>
			{:else}
				<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>
			{/if}
		</button>
	</div>
	</div>
</div>

<style>
	/* Reuse the same styling as Controls.svelte by inheriting its CSS variables and layout */
	.controls {
		position: fixed;
		left: 50%;
		bottom: 18px;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		background: var(--toolbar-bg);
		border: 1px solid var(--toolbar-border);
		border-radius: 16px;
		backdrop-filter: blur(18px);
		z-index: 500;
	}

	.controls.collapsed {
		transform: translateX(-50%) translateY(80%);
		opacity: 0.7;
	}

	.scrubber-row {
		padding: 4px 8px 0;
		display: flex;
		align-items: center;
	}

	.button-row {
		display: flex;
		gap: 10px;
	}

	.button-group {
		display: flex;
		gap: 8px;
		padding: 6px;
		background: var(--group-bg);
		border: 1px solid var(--group-border);
		border-radius: 14px;
	}

	.control-btn {
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border-radius: 12px;
		border: 1px solid var(--ui-border);
		background: var(--btn-bg);
		color: var(--ui-text-hover);
		cursor: pointer;
		transition: transform 120ms ease, background 120ms ease, border-color 120ms ease, opacity 120ms ease;
	}
	.control-btn:hover:not(:disabled) {
		background: var(--btn-bg-hover);
		border-color: var(--ui-accent-border);
		transform: translateY(-1px);
	}
	.control-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.control-btn.primary {
		background: var(--ui-accent);
		color: #000;
		border-color: transparent;
	}

	.control-btn svg {
		width: 20px;
		height: 20px;
	}

	.control-group {
		position: relative;
	}

	.slider-popup {
		position: absolute;
		left: 50%;
		transform: translateX(-50%);
		bottom: 56px;
		width: 180px;
		background: var(--ui-bg);
		border: 1px solid var(--ui-border);
		border-radius: 14px;
		padding: 10px;
		color: var(--ui-text-hover);
	}
	.slider-popup input[type='range'] {
		width: 100%;
	}
	.speed-number {
		margin-top: 8px;
		width: 100%;
		border-radius: 10px;
		border: 1px solid var(--ui-border);
		background: var(--ui-input-bg);
		color: var(--ui-text-hover);
		padding: 6px 8px;
	}

	.popup-backdrop {
		position: fixed;
		inset: 0;
		z-index: 400;
	}

	/* Custom tooltips that appear above buttons */
	.control-btn[data-tooltip] {
		position: relative;
	}

	.control-btn[data-tooltip]::after {
		content: attr(data-tooltip);
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		background: rgba(12, 12, 18, 0.95);
		color: #e0e0e0;
		padding: 0.35rem 0.6rem;
		border-radius: 5px;
		font-size: 0.65rem;
		white-space: nowrap;
		opacity: 0;
		visibility: hidden;
		transition: opacity 0.15s, visibility 0.15s;
		pointer-events: none;
		z-index: 600;
		border: 1px solid rgba(255, 255, 255, 0.1);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
	}

	.control-btn[data-tooltip]::before {
		content: '';
		position: absolute;
		bottom: calc(100% + 3px);
		left: 50%;
		transform: translateX(-50%);
		border: 5px solid transparent;
		border-top-color: rgba(12, 12, 18, 0.95);
		opacity: 0;
		visibility: hidden;
		transition: opacity 0.15s, visibility 0.15s;
		pointer-events: none;
		z-index: 601;
	}

	.control-btn[data-tooltip]:hover::after,
	.control-btn[data-tooltip]:hover::before {
		opacity: 1;
		visibility: visible;
	}

	.control-btn[data-tooltip]:disabled::after,
	.control-btn[data-tooltip]:disabled::before {
		display: none;
	}

	@media (max-width: 900px) {
		.controls {
			left: 10px;
			right: 10px;
			transform: none;
		}
		.button-row {
			justify-content: center;
			flex-wrap: wrap;
		}

		/* Hide tooltips on mobile */
		.control-btn[data-tooltip]::after,
		.control-btn[data-tooltip]::before {
			display: none;
		}
	}
</style>


