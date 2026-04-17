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
	import { ExperimentManager } from '$lib/nlca/experimentManager.svelte.js';
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
	const experimentManager = new ExperimentManager();
	let showExperimentPanel = $state(false);

	// Load experiments from index on mount
	$effect(() => {
		experimentManager.loadFromIndex();
	});

	let canvas: Canvas;

	// Push active experiment's grid to Canvas whenever it changes
	$effect(() => {
		const active = experimentManager.active;
		if (active?.currentGrid && canvas) {
			canvas.setExperimentGrid(active.currentGrid, active.config.gridWidth, active.config.gridHeight);
		}
	});

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
			targetFrames: nlcaSettings.targetFrames
		};
	}

	function handlePlay() {
		const active = experimentManager.active;
		if (active) {
			if (active.status === 'running') {
				experimentManager.pauseExperiment(active.id);
			} else if (active.status === 'paused') {
				experimentManager.resumeExperiment(active.id);
			}
		} else {
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
		if (active.status === 'running') {
			await experimentManager.pauseExperiment(active.id);
		}
		await experimentManager.seekToGeneration(active.id, generation);
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

	<ClickHint />

	<InfoOverlay />

	<NlcaHUD
		experiment={experimentManager.active}
		onViewPrompt={openNlcaPromptViewer}
	/>

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
		onexperimentpause={handlePlay}
		onexperimentresume={handlePlay}
		onseek={handleSeek}
		onexperiments={() => showExperimentPanel = !showExperimentPanel}
		showExperimentPanel={showExperimentPanel}
	/>

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
		manager={experimentManager}
		open={showExperimentPanel}
		onclose={() => showExperimentPanel = false}
		onNew={handleNewExperiment}
	/>
</main>

<style>
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
