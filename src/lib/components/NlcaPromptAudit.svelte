<script lang="ts">
	import { onMount } from 'svelte';
	import { draggable } from '$lib/utils/draggable.js';
	import { bringToFront, setModalPosition, getModalState } from '$lib/stores/modalManager.svelte.js';
	import type { Experiment } from '$lib/nlca/experimentManager.svelte.js';
	import { experimentDisplayName } from '$lib/nlca/experimentDisplayName.js';
	import type { AuditReport, FrameAuditReport, Issue } from '$lib/nlca/promptAudit/types.js';

	interface Props {
		experiment: Experiment | null;
		onclose: () => void;
		onSelectFrame?: (generation: number) => void;
	}

	let { experiment, onclose, onSelectFrame }: Props = $props();
	const modalState = $derived(getModalState('nlcaPromptAudit'));
	const displayName = $derived(experiment ? experimentDisplayName(experiment) : '');

	type LoadState =
		| { status: 'idle' }
		| { status: 'loading' }
		| { status: 'no-logs' }
		| { status: 'error'; message: string }
		| { status: 'ready'; report: AuditReport };

	let loadState = $state<LoadState>({ status: 'idle' });
	let selectedGeneration = $state<number | null>(null);
	let frameDetail = $state<FrameAuditReport | null>(null);
	let frameLoading = $state(false);
	let severityFilter = $state<'all' | 'error' | 'warning'>('all');
	let codeFilter = $state<string>('all');
	let expandedCodes = $state<Record<string, boolean>>({});
	let expandedGroups = $state<Record<string, boolean>>({});

	$effect(() => {
		if (!experiment) {
			loadState = { status: 'idle' };
			return;
		}
		const runId = experiment.id;
		loadState = { status: 'loading' };
		fetch(`/api/nlca/audit/${runId}`)
			.then(async (res) => {
				if (res.status === 404) {
					loadState = { status: 'no-logs' };
					return;
				}
				if (!res.ok) {
					const text = await res.text();
					loadState = { status: 'error', message: `${res.status} ${text}` };
					return;
				}
				const report = (await res.json()) as AuditReport;
				loadState = { status: 'ready', report };
				if (report.perFrame.length > 0) {
					selectedGeneration = report.perFrame[0].generation;
				}
			})
			.catch((err: unknown) => {
				loadState = { status: 'error', message: err instanceof Error ? err.message : String(err) };
			});
	});

	$effect(() => {
		if (!experiment || selectedGeneration == null) {
			frameDetail = null;
			return;
		}
		const runId = experiment.id;
		const gen = selectedGeneration;
		frameLoading = true;
		fetch(`/api/nlca/audit/${runId}/${gen}`)
			.then(async (res) => {
				if (!res.ok) {
					frameDetail = null;
					return;
				}
				frameDetail = (await res.json()) as FrameAuditReport;
			})
			.catch(() => {
				frameDetail = null;
			})
			.finally(() => {
				frameLoading = false;
			});
	});

	function handleModalClick() {
		bringToFront('nlcaPromptAudit');
	}
	function handleDragEnd(position: { x: number; y: number }) {
		setModalPosition('nlcaPromptAudit', position);
	}

	function selectFrame(generation: number) {
		selectedGeneration = generation;
		onSelectFrame?.(generation);
	}

	function selectFrameStep(delta: number) {
		if (loadState.status !== 'ready') return;
		const frames = loadState.report.perFrame;
		if (frames.length === 0) return;
		const idx = frames.findIndex((f) => f.generation === selectedGeneration);
		const next = Math.max(0, Math.min(frames.length - 1, idx + delta));
		selectFrame(frames[next].generation);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
		if (e.code === 'Escape') {
			e.preventDefault();
			onclose();
		} else if (e.code === 'ArrowLeft') {
			e.preventDefault();
			selectFrameStep(-1);
		} else if (e.code === 'ArrowRight') {
			e.preventDefault();
			selectFrameStep(1);
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});

	function severity(frame: { errorCount: number; warningCount: number; total: number }) {
		if (frame.errorCount > 0) return 'error';
		if (frame.warningCount > 0) return 'warning';
		return frame.total > 0 ? 'info' : 'clean';
	}

	const maxFrameTotal = $derived(
		loadState.status === 'ready'
			? Math.max(1, ...loadState.report.perFrame.map((f) => f.total))
			: 1
	);

	function barHeight(total: number): number {
		return Math.round((total / maxFrameTotal) * 36) + 4;
	}

	const filteredIssueGroups = $derived.by(() => {
		if (!frameDetail) return [] as Array<{ code: string; level: 'error' | 'warning' | 'info'; issues: Issue[] }>;
		const filtered = frameDetail.issues.filter((i) => {
			if (severityFilter !== 'all' && i.level !== severityFilter) return false;
			if (codeFilter !== 'all' && i.code !== codeFilter) return false;
			return true;
		});
		const grouped = new Map<string, { code: string; level: 'error' | 'warning' | 'info'; issues: Issue[] }>();
		for (const i of filtered) {
			const g = grouped.get(i.code);
			if (g) g.issues.push(i);
			else grouped.set(i.code, { code: i.code, level: i.level, issues: [i] });
		}
		return [...grouped.values()].sort((a, b) => {
			const aErr = a.level === 'error' ? 0 : 1;
			const bErr = b.level === 'error' ? 0 : 1;
			if (aErr !== bErr) return aErr - bErr;
			return b.issues.length - a.issues.length;
		});
	});

	const allCodes = $derived(
		loadState.status === 'ready'
			? Object.keys(loadState.report.byCode).sort()
			: []
	);
</script>

<div class="modal-backdrop" role="presentation" style="z-index: {modalState.zIndex};">
	<div
		class="modal"
		role="dialog"
		aria-label="Prompt Audit"
		tabindex="0"
		use:draggable={{ onDragEnd: handleDragEnd, handle: '.header' }}
		onclick={handleModalClick}
		onkeydown={() => {}}
		style={modalState.position ? `transform: translate(${modalState.position.x}px, ${modalState.position.y}px);` : ''}
	>
		<div class="header">
			<div class="title">
				<h3>Prompt Audit</h3>
				{#if experiment}
					<span class="sub">{displayName} · <span class="mono">{experiment.id.slice(0, 8)}</span></span>
				{/if}
			</div>
			<button class="close" onclick={onclose} aria-label="Close">×</button>
		</div>

		<div class="content">
			{#if !experiment}
				<div class="empty">No experiment selected.</div>
			{:else if loadState.status === 'loading'}
				<div class="empty">
					<div class="spinner"></div>
					Auditing prompt logs…
				</div>
			{:else if loadState.status === 'no-logs'}
				<div class="empty">
					<p>Audit unavailable — no prompt logs found for this run.</p>
					<p class="hint">Logs are written under <code>logs/nlca/{experiment.id}/</code> when the dev server processes new frames.</p>
				</div>
			{:else if loadState.status === 'error'}
				<div class="empty err">Failed to load audit: {loadState.message}</div>
			{:else if loadState.status === 'ready'}
				{@const r = loadState.report}
				{#if r.totalIssues === 0}
					<div class="empty clean">
						<div class="big-check">✓</div>
						<p>No issues found across {r.frames} frames.</p>
					</div>
				{:else}
					<div class="summary">
						<div class="counts">
							<span class="count error"><span class="dot-error"></span>{r.errorCount} errors</span>
							<span class="count warning"><span class="dot-warning"></span>{r.warningCount} warnings</span>
							<span class="count muted">{r.frames} frames · {r.totalIssues} total</span>
						</div>
						<div class="chips">
							{#each Object.entries(r.byCode).sort((a, b) => b[1] - a[1]) as [code, count] (code)}
								<button
									class="chip"
									class:active={codeFilter === code}
									onclick={() => (codeFilter = codeFilter === code ? 'all' : code)}
								>{code} <span class="chip-count">{count}</span></button>
							{/each}
						</div>
					</div>

					<div class="timeline-section">
						<div class="timeline-label">Frame Timeline</div>
						<div class="timeline">
							{#each r.perFrame as frame (frame.generation)}
								<button
									class="bar"
									class:selected={frame.generation === selectedGeneration}
									data-severity={severity(frame)}
									onclick={() => selectFrame(frame.generation)}
									title={`Frame ${frame.generation} — ${frame.errorCount} errors, ${frame.warningCount} warnings`}
									aria-label={`Frame ${frame.generation}`}
								>
									<span class="bar-fill" style="height: {barHeight(frame.total)}px;"></span>
									<span class="bar-num">{frame.generation}</span>
								</button>
							{/each}
						</div>
						<div class="timeline-status">
							{#if selectedGeneration != null && frameDetail}
								Selected: Frame {selectedGeneration} —
								{frameDetail.errorCount} errors, {frameDetail.warningCount} warnings
							{:else if selectedGeneration != null}
								Selected: Frame {selectedGeneration}
							{/if}
						</div>
					</div>

					<div class="detail-header">
						<div class="filter-row">
							<div class="filter-chips">
								<button class:active={severityFilter === 'all'} onclick={() => (severityFilter = 'all')}>All</button>
								<button class:active={severityFilter === 'error'} onclick={() => (severityFilter = 'error')}>Errors</button>
								<button class:active={severityFilter === 'warning'} onclick={() => (severityFilter = 'warning')}>Warnings</button>
							</div>
							<select bind:value={codeFilter}>
								<option value="all">All checks</option>
								{#each allCodes as code (code)}
									<option value={code}>{code}</option>
								{/each}
							</select>
							<div class="frame-nav">
								<button onclick={() => selectFrameStep(-1)} aria-label="Previous frame">◀</button>
								<button onclick={() => selectFrameStep(1)} aria-label="Next frame">▶</button>
							</div>
						</div>
					</div>

					<div class="issues">
						{#if frameLoading}
							<div class="empty">Loading frame…</div>
						{:else if !frameDetail}
							<div class="empty muted">Select a frame to view issues.</div>
						{:else if filteredIssueGroups.length === 0}
							<div class="empty muted">No issues match the current filters.</div>
						{:else}
							{#each filteredIssueGroups as group (group.code)}
								<div class="group" data-level={group.level}>
									<button
										class="group-header"
										onclick={() => (expandedCodes[group.code] = !(expandedCodes[group.code] ?? true))}
									>
										<span class="caret">{(expandedCodes[group.code] ?? true) ? '▼' : '▶'}</span>
										<span class="level-icon">{group.level === 'error' ? '✗' : '⚠'}</span>
										<span class="code">{group.code}</span>
										<span class="group-count">({group.issues.length})</span>
									</button>
									{#if expandedCodes[group.code] ?? true}
										<ul class="issue-list">
											{#each (expandedGroups[group.code] ? group.issues : group.issues.slice(0, 3)) as issue, i (i)}
												<li>
													{#if issue.cellId !== undefined}
														<button
															class="cell-link"
															onclick={() => issue.cellId !== undefined && onSelectFrame?.(selectedGeneration!)}
															title="Frame {selectedGeneration} · cell {issue.cellId}"
														>cell {issue.cellId}</button>
													{/if}
													<span class="msg">{issue.message}</span>
												</li>
											{/each}
											{#if group.issues.length > 3 && !expandedGroups[group.code]}
												<li class="more">
													<button onclick={() => (expandedGroups[group.code] = true)}>+ {group.issues.length - 3} more</button>
												</li>
											{:else if expandedGroups[group.code] && group.issues.length > 3}
												<li class="more">
													<button onclick={() => (expandedGroups[group.code] = false)}>collapse</button>
												</li>
											{/if}
										</ul>
									{/if}
								</div>
							{/each}
						{/if}
					</div>
				{/if}
			{/if}
		</div>

		<div class="footer">
			<span class="hint mono">←/→ step frames · Esc to close</span>
			<button class="btn" onclick={onclose}>Close</button>
		</div>
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		pointer-events: none;
	}
	.modal {
		position: absolute;
		left: 50%;
		top: 8%;
		transform: translate(-50%, 0);
		width: min(760px, calc(100vw - 24px));
		max-height: 84vh;
		background: var(--ui-bg);
		border: 1px solid var(--ui-border);
		border-radius: 18px;
		backdrop-filter: blur(18px);
		color: var(--ui-text-hover);
		display: flex;
		flex-direction: column;
		pointer-events: auto;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
	}
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--ui-border);
	}
	.title {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.title h3 {
		font-size: 14px;
		font-weight: 600;
		margin: 0;
	}
	.sub {
		font-size: 11px;
		color: var(--ui-text);
	}
	.mono {
		font-family: 'SF Mono', 'Fira Code', monospace;
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
		padding: 12px 16px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		overflow-y: auto;
		flex: 1;
	}
	.empty {
		text-align: center;
		padding: 28px 12px;
		color: var(--ui-text);
		font-size: 13px;
	}
	.empty.clean {
		color: #22c55e;
	}
	.empty.err {
		color: #ef4444;
	}
	.big-check {
		font-size: 48px;
		line-height: 1;
		margin-bottom: 8px;
	}
	.spinner {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 2px solid var(--ui-border);
		border-top-color: var(--ui-accent, #2dd4bf);
		animation: spin 0.8s linear infinite;
		margin: 0 auto 8px;
	}
	@keyframes spin {
		to { transform: rotate(360deg); }
	}
	.hint {
		color: var(--ui-text);
		font-size: 11px;
	}
	.summary {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.counts {
		display: flex;
		align-items: center;
		gap: 14px;
		font-size: 12px;
	}
	.count {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.count.error { color: #ef4444; }
	.count.warning { color: #eab308; }
	.count.muted { color: var(--ui-text); margin-left: auto; }
	.dot-error, .dot-warning {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}
	.dot-error { background: #ef4444; }
	.dot-warning { background: #eab308; }
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		background: var(--btn-bg);
		border: 1px solid var(--ui-border);
		color: var(--ui-text-hover);
		font-family: 'SF Mono', 'Fira Code', monospace;
		font-size: 10px;
		padding: 3px 8px;
		border-radius: 999px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.chip.active {
		border-color: var(--ui-accent, #2dd4bf);
		color: var(--ui-accent, #2dd4bf);
	}
	.chip-count {
		opacity: 0.7;
		font-size: 10px;
	}
	.timeline-section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.timeline-label {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--ui-text);
	}
	.timeline {
		display: flex;
		gap: 2px;
		align-items: flex-end;
		min-height: 50px;
		padding: 6px 4px;
		background: var(--ui-input-bg);
		border: 1px solid var(--ui-border);
		border-radius: 10px;
		overflow-x: auto;
	}
	.bar {
		display: flex;
		flex-direction: column-reverse;
		align-items: center;
		gap: 4px;
		background: none;
		border: none;
		cursor: pointer;
		padding: 2px 1px;
		min-width: 22px;
	}
	.bar-fill {
		display: block;
		width: 14px;
		min-height: 4px;
		background: var(--ui-border);
		border-radius: 2px;
	}
	.bar[data-severity='error'] .bar-fill { background: #ef4444; }
	.bar[data-severity='warning'] .bar-fill { background: #eab308; }
	.bar[data-severity='info'] .bar-fill { background: #3b82f6; }
	.bar[data-severity='clean'] .bar-fill { background: #22c55e; opacity: 0.6; }
	.bar.selected .bar-fill {
		outline: 2px solid var(--ui-accent, #2dd4bf);
		outline-offset: 2px;
	}
	.bar-num {
		font-size: 9px;
		color: var(--ui-text);
	}
	.bar.selected .bar-num {
		color: var(--ui-accent, #2dd4bf);
		font-weight: 700;
	}
	.timeline-status {
		font-size: 11px;
		color: var(--ui-text);
	}
	.detail-header {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.filter-row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.filter-chips {
		display: flex;
		gap: 4px;
		background: var(--ui-input-bg);
		border: 1px solid var(--ui-border);
		border-radius: 10px;
		padding: 2px;
	}
	.filter-chips button {
		background: none;
		border: none;
		color: var(--ui-text);
		padding: 4px 10px;
		border-radius: 8px;
		font-size: 11px;
		cursor: pointer;
	}
	.filter-chips button.active {
		background: var(--btn-bg);
		color: var(--ui-text-hover);
	}
	select {
		background: var(--ui-input-bg);
		color: var(--ui-text-hover);
		border: 1px solid var(--ui-border);
		border-radius: 8px;
		padding: 4px 8px;
		font-size: 11px;
	}
	.frame-nav {
		display: flex;
		gap: 4px;
		margin-left: auto;
	}
	.frame-nav button {
		background: var(--btn-bg);
		border: 1px solid var(--ui-border);
		color: var(--ui-text-hover);
		border-radius: 8px;
		padding: 4px 10px;
		font-size: 12px;
		cursor: pointer;
	}
	.issues {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.group {
		border: 1px solid var(--ui-border);
		border-radius: 10px;
		overflow: hidden;
	}
	.group[data-level='error'] {
		border-color: rgba(239, 68, 68, 0.4);
	}
	.group[data-level='warning'] {
		border-color: rgba(234, 179, 8, 0.4);
	}
	.group-header {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--ui-input-bg);
		border: none;
		color: var(--ui-text-hover);
		padding: 8px 12px;
		font-size: 12px;
		font-family: 'SF Mono', 'Fira Code', monospace;
		cursor: pointer;
		text-align: left;
	}
	.caret {
		font-size: 10px;
		color: var(--ui-text);
	}
	.level-icon {
		font-size: 14px;
		line-height: 1;
	}
	.group[data-level='error'] .level-icon { color: #ef4444; }
	.group[data-level='warning'] .level-icon { color: #eab308; }
	.code { flex: 1; }
	.group-count { color: var(--ui-text); font-weight: 400; }
	.issue-list {
		list-style: none;
		margin: 0;
		padding: 6px 12px 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
	}
	.issue-list li {
		display: flex;
		gap: 6px;
		align-items: baseline;
		line-height: 1.5;
	}
	.cell-link {
		background: none;
		border: none;
		color: var(--ui-accent, #2dd4bf);
		font-family: 'SF Mono', 'Fira Code', monospace;
		font-size: 11px;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
		flex-shrink: 0;
	}
	.msg {
		color: var(--ui-text-hover);
	}
	.more button {
		background: none;
		border: none;
		color: var(--ui-text);
		font-size: 11px;
		cursor: pointer;
		text-decoration: underline;
		padding: 2px 0;
	}
	.muted { color: var(--ui-text); }
	.footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 16px;
		border-top: 1px solid var(--ui-border);
	}
	.btn {
		height: 32px;
		padding: 0 14px;
		border-radius: 10px;
		border: 1px solid var(--ui-border);
		background: var(--btn-bg);
		color: var(--ui-text-hover);
		cursor: pointer;
		font-size: 13px;
	}
	code {
		background: var(--ui-input-bg);
		padding: 1px 4px;
		border-radius: 4px;
		font-size: 11px;
	}
</style>
