<script lang="ts">
	import './layout.css';
	import { getSimulationState } from '$lib/stores/simulation.svelte.js';

	let { children } = $props();
	const simState = getSimulationState();

	// Convert alive color (0-1 RGB) to CSS color strings
	const accentColor = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
	});

	const accentColorBg = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.15)`;
	});

	const accentColorBorder = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.3)`;
	});

	const accentColorBgHover = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.25)`;
	});

	// Toolbar background derived from theme and accent color
	const toolbarBg = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		if (simState.isLightTheme) {
			return `rgba(${Math.round(r * 255 * 0.1 + 245)}, ${Math.round(g * 255 * 0.1 + 245)}, ${Math.round(b * 255 * 0.1 + 245)}, 0.7)`;
		}
		return `rgba(${Math.round(r * 255 * 0.05)}, ${Math.round(g * 255 * 0.05)}, ${Math.round(b * 255 * 0.05 + 8)}, 0.6)`;
	});

	const toolbarBorder = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		if (simState.isLightTheme) {
			return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.2)`;
		}
		return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.15)`;
	});

	const btnBg = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		if (simState.isLightTheme) {
			return `rgba(${Math.round(r * 255 * 0.1)}, ${Math.round(g * 255 * 0.1)}, ${Math.round(b * 255 * 0.1)}, 0.08)`;
		}
		return `rgba(${Math.round(r * 255 * 0.2 + 40)}, ${Math.round(g * 255 * 0.2 + 40)}, ${Math.round(b * 255 * 0.2 + 40)}, 0.15)`;
	});

	const btnBgHover = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		if (simState.isLightTheme) {
			return `rgba(${Math.round(r * 255 * 0.15)}, ${Math.round(g * 255 * 0.15)}, ${Math.round(b * 255 * 0.15)}, 0.15)`;
		}
		return `rgba(${Math.round(r * 255 * 0.3 + 60)}, ${Math.round(g * 255 * 0.3 + 60)}, ${Math.round(b * 255 * 0.3 + 60)}, 0.25)`;
	});

	const btnBgActive = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		if (simState.isLightTheme) {
			return `rgba(${Math.round(r * 255 * 0.2)}, ${Math.round(g * 255 * 0.2)}, ${Math.round(b * 255 * 0.2)}, 0.2)`;
		}
		return `rgba(${Math.round(r * 255 * 0.4 + 80)}, ${Math.round(g * 255 * 0.4 + 80)}, ${Math.round(b * 255 * 0.4 + 80)}, 0.3)`;
	});

	const groupBg = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		if (simState.isLightTheme) {
			return `rgba(${Math.round(r * 255 * 0.05)}, ${Math.round(g * 255 * 0.05)}, ${Math.round(b * 255 * 0.05)}, 0.08)`;
		}
		return `rgba(255, 255, 255, 0.04)`;
	});

	const groupBorder = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		if (simState.isLightTheme) {
			return `rgba(${Math.round(r * 255 * 0.1)}, ${Math.round(g * 255 * 0.1)}, ${Math.round(b * 255 * 0.1)}, 0.12)`;
		}
		return `rgba(255, 255, 255, 0.06)`;
	});

	const groupBgHover = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		if (simState.isLightTheme) {
			return `rgba(${Math.round(r * 255 * 0.08)}, ${Math.round(g * 255 * 0.08)}, ${Math.round(b * 255 * 0.08)}, 0.12)`;
		}
		return `rgba(255, 255, 255, 0.06)`;
	});

	const groupBorderHover = $derived.by(() => {
		const [r, g, b] = simState.aliveColor;
		if (simState.isLightTheme) {
			return `rgba(${Math.round(r * 255 * 0.15)}, ${Math.round(g * 255 * 0.15)}, ${Math.round(b * 255 * 0.15)}, 0.18)`;
		}
		return `rgba(255, 255, 255, 0.1)`;
	});

	const siteTitle = 'NLCA — Natural Language Cellular Automata';
	const siteDescription =
		'Cellular automata with language-model rules: write a task in English and watch each cell decide its next state.';
	const thumbnailUrl = 'https://neovand.github.io/games-of-life/thumbnail.jpg';
</script>

<svelte:head>
	<title>{siteTitle}</title>
	<meta name="description" content={siteDescription} />

	<!-- Open Graph -->
	<meta property="og:type" content="website" />
	<meta property="og:title" content={siteTitle} />
	<meta property="og:description" content={siteDescription} />
	<meta property="og:image" content={thumbnailUrl} />
	<meta property="og:image:alt" content="Natural Language Cellular Automata" />

	<!-- Twitter -->
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={siteTitle} />
	<meta name="twitter:description" content={siteDescription} />
	<meta name="twitter:image" content={thumbnailUrl} />
</svelte:head>

<div
	class="root-layout"
	class:light-theme={simState.isLightTheme}
	style="--ui-accent: {accentColor}; --ui-accent-bg: {accentColorBg}; --ui-accent-border: {accentColorBorder}; --ui-accent-bg-hover: {accentColorBgHover}; --toolbar-bg: {toolbarBg}; --toolbar-border: {toolbarBorder}; --btn-bg: {btnBg}; --btn-bg-hover: {btnBgHover}; --btn-bg-active: {btnBgActive}; --group-bg: {groupBg}; --group-border: {groupBorder}; --group-bg-hover: {groupBgHover}; --group-border-hover: {groupBorderHover};"
>
	{@render children()}
</div>

<style>
	.root-layout {
		display: contents;
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

	.root-layout.light-theme {
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
