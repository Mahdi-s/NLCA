<script lang="ts">
	import { onMount } from 'svelte';
	import Canvas from '$lib/components/Canvas.svelte';
	import ControlsNlca from '$lib/components/ControlsNlca.svelte';
	import Settings from '$lib/components/Settings.svelte';
	import HelpOverlay from '$lib/components/HelpOverlay.svelte';
	import AboutModal from '$lib/components/AboutModal.svelte';
	import ClickHint from '$lib/components/ClickHint.svelte';
	import InfoOverlay from '$lib/components/InfoOverlay.svelte';
	import InitializeModal from '$lib/components/InitializeModal.svelte';
	import NlcaSettingsModal from '$lib/components/NlcaSettingsModal.svelte';
	import NlcaPromptModal from '$lib/components/NlcaPromptModal.svelte';
	import NlcaBatchRunModal from '$lib/components/NlcaBatchRunModal.svelte';
	import NlcaPromptViewer from '$lib/components/NlcaPromptViewer.svelte';
	import NlcaHUD from '$lib/components/NlcaHUD.svelte';
	import NlcaExperimentPanel from './NlcaExperimentPanel.svelte';
	import { getNlcaStore } from '$lib/stores/nlcaStore.svelte.js';
	import { getNlcaSettingsState } from '$lib/stores/nlcaSettings.svelte.js';
	import { getNlcaPromptState } from '$lib/stores/nlcaPrompt.svelte.js';
	import type { ExperimentConfig } from '$lib/nlca/types.js';

	import { getSimulationState, getUIState, type GridScale } from '$lib/stores/simulation.svelte.js';
	import { getModalStates, toggleModal, closeModal } from '$lib/stores/modalManager.svelte.js';
	import type { BufferStatus } from '$lib/nlca/frameBuffer.js';

	const simState = getSimulationState();
	const uiState = getUIState();
	const nlcaSettings = getNlcaSettingsState();
	const nlcaPrompt = getNlcaPromptState();

	const modalStates = $derived(getModalStates());
	const showHelp = $derived(modalStates.help.isOpen);
	const showInitialize = $derived(modalStates.initialize.isOpen);
	const showAbout = $derived(modalStates.about.isOpen);
	const showSettings = $derived(modalStates.settings.isOpen);
	const showNlcaSettings = $derived(modalStates.nlcaSettings.isOpen);
	const showNlcaPrompt = $derived(modalStates.nlcaPrompt.isOpen);
	const showNlcaPromptViewer = $derived(modalStates.nlcaPromptViewer.isOpen);
	const showNlcaBatchRun = $derived(modalStates.nlcaBatchRun.isOpen);

	// Batch run state (passed from Canvas)
	let nlcaBufferStatus = $state<BufferStatus | null>(null);
	let nlcaBatchRunTarget = $state(0);
	let nlcaBatchRunCompleted = $state(0);

	// Experiment Manager
	const experimentManager = getNlcaStore();
	let showExperimentPanel = $state(false);
	/** Hide the HUD (top-left info box) and the Controls toolbar for a clean
	 * canvas view. Toggled with R so users can grab an uncluttered screenshot
	 * or recording without the UI chrome in the way. */
	let chromeHidden = $state(false);

	// Load experiments from index on mount
	$effect(() => {
		experimentManager.loadFromIndex();
	});

	// Keep session API keys on the manager in sync with current settings so
	// extendExperiment can use them when loaded experiments have blank keys.
	$effect(() => {
		experimentManager.sessionApiKey = nlcaSettings.apiKey;
		experimentManager.sessionSambaNovaApiKey = nlcaSettings.sambaNovaApiKey;
	});

	let canvas: Canvas;

	// Push active experiment's grid to Canvas whenever it changes. Also clear the
	// canvas whenever the active experiment is switched to one that hasn't
	// loaded its grid yet (either because a rehydrate is in flight or the tape
	// is missing) — otherwise the previously-active experiment's pixels ghost
	// through and the user can't tell the switch actually landed.
	//
	// During playback we step out of the way entirely: the playback loop drives
	// the canvas directly via animateTransition(), and we don't want to snap
	// the final frame in mid-animation.
	let lastRenderedExpId: string | null = null;
	let lastRenderedGeneration: number = -1;
	$effect(() => {
		if (!canvas) return;
		if (experimentManager.playback) return;
		const active = experimentManager.active;
		const id = active?.id ?? null;
		const gen = active?.currentGeneration ?? -1;
		const gridPresent = active?.currentGrid != null;

		if (!active) {
			if (lastRenderedExpId !== null) {
				lastRenderedExpId = null;
				lastRenderedGeneration = -1;
			}
			return;
		}

		if (!gridPresent) {
			if (lastRenderedExpId !== id) {
				canvas.clearExperimentGrid(active.config.gridWidth, active.config.gridHeight);
				lastRenderedExpId = id;
				lastRenderedGeneration = -1;
			}
			return;
		}

		canvas.setExperimentGrid(
			active.currentGrid!,
			active.config.gridWidth,
			active.config.gridHeight,
			active.currentColorsHex,
			active.currentColorStatus8
		);
		lastRenderedExpId = id;
		lastRenderedGeneration = gen;
	});

	/** Map the user's speed knob (steps-per-second, 1..MAX_SPEED) to a per-frame
	 * playback duration. Slower speeds get more time to stagger; faster speeds
	 * compress the stagger window but still leave enough for the fade. */
	function playbackFrameMs(): number {
		const sps = Math.max(1, Math.min(1000, simState.speed));
		return Math.max(280, Math.min(2400, Math.round(1500 / Math.sqrt(sps))));
	}

	function runPlayback() {
		const active = experimentManager.active;
		if (!active || !canvas) return;
		void experimentManager.startPlayback(
			active.id,
			(cur, next, curC, nextC, w, h, ms) =>
				canvas.animateTransition(cur, next, curC, nextC, w, h, ms),
			playbackFrameMs,
			() => canvas?.cancelPlaybackAnimation?.()
		);
	}

	function configFromCurrentSettings(): ExperimentConfig {
		const provider = nlcaSettings.apiProvider;
		const sambaMode = provider === 'sambanova';
		return {
			apiProvider: provider,
			apiKey: nlcaSettings.apiKey,
			sambaNovaApiKey: nlcaSettings.sambaNovaApiKey,
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
			// SambaNova hyperscale enforces memoryWindow=0 to maximise dedup.
			memoryWindow: sambaMode ? 0 : nlcaSettings.memoryWindow,
			maxConcurrency: nlcaSettings.maxConcurrency,
			batchSize: nlcaSettings.batchSize,
			frameBatched: sambaMode ? true : nlcaSettings.frameBatched,
			frameStreamed: sambaMode ? false : nlcaSettings.frameStreamed,
			cellTimeoutMs: sambaMode ? 120_000 : 30_000,
			compressPayload: sambaMode ? true : false,
			deduplicateRequests: sambaMode ? true : false,
			targetFrames: nlcaSettings.targetFrames
		};
	}

	function handlePlay() {
		const active = experimentManager.active;
		const playback = experimentManager.playback;

		if (playback) {
			// Playback in progress — Play toggles its pause state.
			if (playback.isPaused) experimentManager.resumePlayback();
			else experimentManager.pausePlayback();
			return;
		}

		if (!active) {
			experimentManager.createExperiment(configFromCurrentSettings()).catch((err) => {
				console.error('[MainAppNlca] Failed to create experiment:', err);
			});
			showExperimentPanel = true;
			return;
		}

		if (active.status === 'running') {
			experimentManager.pauseExperiment(active.id);
			return;
		}

		// paused / completed / error: replay saved frames with the fade-in
		// stagger animation when we have frames on disk. Falls back to live
		// compute behaviour only when there's nothing to play.
		if (active.progress.current > 0) {
			runPlayback();
			return;
		}

		if (active.status === 'paused') {
			experimentManager.resumeExperiment(active.id);
		} else {
			experimentManager.activeId = null;
			experimentManager.createExperiment(configFromCurrentSettings()).catch((err) => {
				console.error('[MainAppNlca] Failed to create experiment:', err);
			});
			showExperimentPanel = true;
		}
	}

	function handleNewExperiment() {
		experimentManager.activeId = null;
	}

	function handleClear() {
		canvas.clear();
	}
	function handleInitialize() {
		toggleModal('initialize');
	}
	function handleStep() {
		canvas.stepOnce();
	}
	function handleResetView() {
		canvas.resetView();
	}
	function handleRecord() {
		canvas.toggleRecording();
	}
	
	function handleInitializePattern(type: string, options?: { density?: number; tiled?: boolean; spacing?: number }) {
		canvas.initialize(type, options);
	}
	
	function handleScaleChange(scale: GridScale) {
		canvas.setScale(scale);
	}

	// Poll recording state from canvas (matches existing MainApp pattern).
	let isRecording = $state(false);
	onMount(() => {
		const interval = setInterval(() => {
			if (!canvas) return;
			isRecording = canvas.getIsRecording();
			nlcaBufferStatus = canvas.getNlcaBufferStatus();
			nlcaBatchRunTarget = canvas.getNlcaBatchRunTarget();
			nlcaBatchRunCompleted = canvas.getNlcaBatchRunCompleted();
		}, 100);
		return () => clearInterval(interval);
	});

	function openHelp() {
		toggleModal('help');
	}
	function openAbout() {
		toggleModal('about');
	}
	function openSettingsModal() {
		toggleModal('settings');
	}
	function openNlcaSettingsModal() {
		toggleModal('nlcaSettings');
	}
	function openNlcaPromptModal() {
		toggleModal('nlcaPrompt');
	}
	function openNlcaPromptViewer() {
		toggleModal('nlcaPromptViewer');
	}
	function openNlcaBatchRunModal() {
		toggleModal('nlcaBatchRun');
	}

	async function handleSeek(generation: number) {
		const active = experimentManager.active;
		if (!active) return;
		if (experimentManager.playback) experimentManager.stopPlayback();
		if (active.status === 'running') {
			await experimentManager.pauseExperiment(active.id);
		}
		await experimentManager.seekToGeneration(active.id, generation);
	}

	async function handleSeekPrev() {
		const active = experimentManager.active;
		if (!active || active.currentGeneration <= 1) return;
		await handleSeek(active.currentGeneration - 1);
	}

	async function handleSeekNext() {
		const active = experimentManager.active;
		if (!active || active.currentGeneration >= active.progress.current) return;
		await handleSeek(active.currentGeneration + 1);
	}
	
	function handleStartBatchRun(generations: number) {
		canvas.startNlcaBatchRun(generations);
	}
	
	function handleCancelBatchRun() {
		canvas.cancelNlcaBatchRun();
	}
	
	function handleEstimateTime(generations: number): number {
		return canvas.estimateNlcaTime(generations);
	}
	
	function handleKeydown(e: KeyboardEvent) {
		// Ignore if typing in an input
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
			return;
		}

		switch (e.code) {
			case 'Enter':
				e.preventDefault();
				handlePlay();
				break;
			case 'KeyD':
				if (!e.ctrlKey && !e.metaKey) {
					handleClear();
				}
				break;
			case 'KeyS':
				if (!e.ctrlKey && !e.metaKey) {
					handleStep();
				}
				break;
			case 'KeyG':
				simState.showGrid = !simState.showGrid;
				break;
			case 'KeyE':
				showExperimentPanel = !showExperimentPanel;
				break;
			case 'KeyR':
				if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
					chromeHidden = !chromeHidden;
				}
				break;
			case 'KeyI':
				toggleModal('initialize');
				break;
			case 'KeyF':
			case 'Home':
				handleResetView();
				break;
			case 'Escape':
				closeModal('help');
				closeModal('initialize');
				closeModal('about');
				closeModal('settings');
				closeModal('nlcaSettings');
				closeModal('nlcaPrompt');
				closeModal('nlcaPromptViewer');
				closeModal('nlcaBatchRun');
				showExperimentPanel = false;
				uiState.closeAll();
				break;
			case 'Slash':
				if (e.shiftKey) {
					e.preventDefault();
					toggleModal('help');
				}
				break;
			case 'Comma':
				simState.speed = Math.max(1, simState.speed - 5);
				break;
			case 'Period':
				simState.speed = Math.min(240, simState.speed + 5);
				break;
		}
	}
</script>

<svelte:head>
	<title>NLCA — Natural Language Cellular Automata</title>
	<meta name="description" content="Cellular automata with language-model rules: write a task in English and watch each cell decide its next state." />
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<main
	class="app"
	class:light-theme={simState.isLightTheme}
>
	<Canvas bind:this={canvas} nlcaMode={true} />

	<InfoOverlay />

	{#if !chromeHidden}
		<NlcaHUD
			experiment={experimentManager.active}
			onViewPrompt={openNlcaPromptViewer}
		/>
	{/if}

	{#if chromeHidden}
		<button
			type="button"
			class="chrome-reveal-hint"
			onclick={() => (chromeHidden = false)}
			aria-label="Show controls (R)"
		>Press R to restore controls</button>
	{/if}

	{#if !chromeHidden}
	<ControlsNlca
		onclear={handleClear}
		oninitialize={handleInitialize}
		onstep={handleStep}
		onresetview={handleResetView}
		onrecord={handleRecord}
		isRecording={isRecording}
		onhelp={openHelp}
		onabout={openAbout}
		onnlcasettings={openNlcaSettingsModal}
		onnlcaprompt={openNlcaPromptModal}
		onnlcabatchrun={openNlcaBatchRunModal}
		onsettings={openSettingsModal}
		showHelp={showHelp}
		showInitialize={showInitialize}
		showAbout={showAbout}
		experimentActive={true}
		experimentStatus={experimentManager.active?.status ?? 'paused'}
		activeExperiment={experimentManager.active}
		playbackActive={experimentManager.playback != null && !experimentManager.playback.isPaused}
		onexperimentpause={handlePlay}
		onexperimentresume={handlePlay}
		onseek={handleSeek}
		onseekprev={handleSeekPrev}
		onseeknext={handleSeekNext}
		onexperiments={() => showExperimentPanel = !showExperimentPanel}
		showExperimentPanel={showExperimentPanel}
	/>
	{/if}

	{#if showHelp}
		<HelpOverlay variant="nlca" onclose={() => closeModal('help')} onstarttour={() => {}} />
	{/if}

	{#if showAbout}
		<AboutModal onclose={() => closeModal('about')} onstarttour={() => {}} />
	{/if}

	{#if showSettings}
		<Settings onclose={() => closeModal('settings')} />
	{/if}

	{#if showInitialize}
		<InitializeModal 
			onclose={() => closeModal('initialize')} 
			oninitialize={handleInitializePattern}
			onscalechange={handleScaleChange}
		/>
	{/if}

	{#if showNlcaSettings}
		<NlcaSettingsModal onclose={() => closeModal('nlcaSettings')} />
	{/if}

	{#if showNlcaPrompt}
		<NlcaPromptModal onclose={() => closeModal('nlcaPrompt')} />
	{/if}

	{#if showNlcaPromptViewer}
		<NlcaPromptViewer
			experiment={experimentManager.active}
			onclose={() => closeModal('nlcaPromptViewer')}
		/>
	{/if}

	{#if showNlcaBatchRun}
		<NlcaBatchRunModal 
			onclose={() => closeModal('nlcaBatchRun')}
			bufferStatus={nlcaBufferStatus}
			batchRunActive={nlcaBatchRunTarget > 0}
			batchRunTarget={nlcaBatchRunTarget}
			batchRunCompleted={nlcaBatchRunCompleted}
			onStartBatchRun={handleStartBatchRun}
			onCancelBatchRun={handleCancelBatchRun}
			estimateTime={handleEstimateTime}
		/>
	{/if}

	<NlcaExperimentPanel
		open={showExperimentPanel}
		onclose={() => showExperimentPanel = false}
		onNew={handleNewExperiment}
	/>
</main>

<style>
	.chrome-reveal-hint {
		position: fixed;
		left: 50%;
		bottom: 18px;
		transform: translateX(-50%);
		font-size: 11px;
		padding: 6px 12px;
		border-radius: 999px;
		background: rgba(12, 12, 18, 0.55);
		border: 1px solid rgba(255, 255, 255, 0.08);
		color: rgba(255, 255, 255, 0.55);
		cursor: pointer;
		z-index: 400;
		transition: opacity 0.2s, color 0.15s;
		opacity: 0.6;
	}
	.chrome-reveal-hint:hover {
		color: rgba(255, 255, 255, 0.9);
		opacity: 1;
	}

	.app {
		position: fixed;
		inset: 0;
		overflow: hidden;
		--ui-bg: rgba(12, 12, 18, 0.7);
		--ui-bg-hover: rgba(20, 20, 30, 0.8);
		--ui-border: rgba(255, 255, 255, 0.08);
		--ui-border-hover: rgba(255, 255, 255, 0.15);
		--ui-text: #888;
		--ui-text-hover: #fff;
		--ui-input-bg: rgba(0, 0, 0, 0.3);
		--ui-canvas-bg: #0a0a0f;
		--ui-apply-text: #0a0a0f;
		--slider-track-bg: rgba(255, 255, 255, 0.2);
		--slider-track-border: rgba(255, 255, 255, 0.15);
	}

	.app.light-theme {
		--ui-bg: rgba(255, 255, 255, 0.85);
		--ui-bg-hover: rgba(240, 240, 245, 0.95);
		--ui-border: rgba(0, 0, 0, 0.1);
		--ui-border-hover: rgba(0, 0, 0, 0.2);
		--ui-text: #555;
		--ui-text-hover: #1a1a1a;
		--ui-input-bg: rgba(255, 255, 255, 0.5);
		--ui-canvas-bg: #f0f0f3;
		--ui-apply-text: #ffffff;
		--slider-track-bg: rgba(0, 0, 0, 0.15);
		--slider-track-border: rgba(0, 0, 0, 0.1);
	}
</style>
