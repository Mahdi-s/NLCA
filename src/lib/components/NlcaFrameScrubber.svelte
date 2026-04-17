<script lang="ts">
	interface Props {
		current: number;
		stored: number;
		target: number;
		onSeek: (generation: number) => void;
	}

	let { current, stored, target, onSeek }: Props = $props();

	let trackEl: HTMLDivElement;
	let isDragging = $state(false);

	function seekFromEvent(e: PointerEvent) {
		if (!trackEl) return;
		const rect = trackEl.getBoundingClientRect();
		const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
		const frac = rect.width > 0 ? x / rect.width : 0;
		const maxSeekable = Math.max(1, stored);
		const gen = Math.round(frac * maxSeekable);
		onSeek(Math.max(1, Math.min(maxSeekable, gen)));
	}

	function handlePointerDown(e: PointerEvent) {
		isDragging = true;
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
		seekFromEvent(e);
	}

	function handlePointerMove(e: PointerEvent) {
		if (!isDragging) return;
		seekFromEvent(e);
	}

	function handlePointerUp(e: PointerEvent) {
		isDragging = false;
		(e.target as HTMLElement).releasePointerCapture(e.pointerId);
	}

	const storedPct = $derived(target > 0 ? (stored / target) * 100 : 0);
	const currentPct = $derived(target > 0 ? (current / target) * 100 : 0);
</script>

<div class="scrubber">
	<div
		class="track"
		bind:this={trackEl}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		role="slider"
		aria-valuemin="0"
		aria-valuemax={target}
		aria-valuenow={current}
		aria-label="Frame scrubber"
		tabindex="0"
	>
		<div class="track-bg"></div>
		<div class="track-stored" style="width: {storedPct}%"></div>
		<div class="thumb" style="left: {currentPct}%"></div>
	</div>
	<div class="frame-counts">
		<span class="current">{current}</span>
		<span class="sep">/</span>
		<span class="target">{target}</span>
	</div>
</div>

<style>
	.scrubber {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 6px;
		width: 100%;
		min-width: 280px;
	}
	.track {
		position: relative;
		flex: 1;
		height: 20px;
		cursor: pointer;
		display: flex;
		align-items: center;
		touch-action: none;
	}
	.track-bg {
		position: absolute;
		left: 0;
		right: 0;
		height: 4px;
		background: rgba(255, 255, 255, 0.08);
		border-radius: 2px;
	}
	.track-stored {
		position: absolute;
		left: 0;
		height: 4px;
		background: rgba(100, 200, 100, 0.45);
		border-radius: 2px;
		transition: width 0.15s;
	}
	.thumb {
		position: absolute;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--ui-accent, #2dd4bf);
		transform: translateX(-50%);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
		pointer-events: none;
		transition: left 0.1s;
	}
	.frame-counts {
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		color: var(--ui-text, #888);
		min-width: 60px;
		text-align: right;
	}
	.current {
		color: var(--ui-text-hover, #fff);
		font-weight: 600;
	}
	.sep {
		margin: 0 2px;
		opacity: 0.5;
	}
</style>
