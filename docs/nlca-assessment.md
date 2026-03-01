# NLCA (/nlca) Assessment and Plan

Date: 2026-02-28

This document audits the current NLCA (Neural Life Cellular Automata) pipeline end-to-end, verifies that NLCA UI settings are actually wired into runtime behavior, and proposes a plan to make the system more robust and faster for larger batch simulations.

## Executive Summary

NLCA is implemented as a special mode of the main WebGPU canvas that swaps classic CA transition rules for LLM decisions. The core pipeline is:

1. **UI settings** (NLCA Settings + Prompt Editor) → persisted (mostly) in `localStorage`
2. `Canvas.svelte` consumes settings and constructs an `NlcaStepper`
3. `NlcaStepper` builds per-cell contexts (self + neighborhood) and invokes `NlcaOrchestrator`
4. `NlcaOrchestrator` calls **SvelteKit server proxy APIs** (`/api/nlca/*`)
5. Server proxies call **OpenRouter** (`/chat/completions`) and return decisions
6. Client applies decisions to the WebGPU simulation and persists frames to a local SQLite “tape”

Changes made during this assessment (so the UI and runtime are consistent):

- Batch Run modal now shows live buffer/progress from the canvas.
- Prompt Editor advanced templates now affect **frame-batched** mode as well (previously ignored).
- Prompt Editor output contract display now matches the active stepping mode (frame-batched vs cell-mode).
- Frame-batched fallback chunking now respects the intended chunk concurrency limit.
- Frame-batched decision APIs now validate **unique** `cellId` coverage (no silent duplicates/missing cells).
- Batch runs now compute exactly N generations and persist frames at compute-time (not dependent on playback consumption).

## Where /nlca Lives

- Route selection happens in the root layout: `src/routes/+layout.svelte`
  - `MainAppNlca` is mounted when `pathname.startsWith('/nlca')`.
- The route file `src/routes/nlca/+page.svelte` is intentionally minimal.
- The NLCA app UI is `src/lib/components/MainAppNlca.svelte`, which embeds `src/lib/components/Canvas.svelte` with `nlcaMode={true}`.

## Architecture (Runtime Flow)

### High-level call path

**UI → Canvas**

- `MainAppNlca.svelte` mounts:
  - `Canvas.svelte` (WebGPU rendering + NLCA stepping)
  - `NlcaSettingsModal.svelte` (OpenRouter + stepping config)
  - `NlcaPromptModal.svelte` (task + advanced prompt template + color mode)
  - `NlcaBatchRunModal.svelte` (compute N generations)
  - `NlcaPlaybackModal.svelte` (replay from tape)

**Canvas → Stepper**

- `Canvas.svelte` creates an `NlcaStepper` in `ensureNlcaReady(...)` when an API key is present.
- `NlcaStepper` (`src/lib/nlca/stepper.ts`) is responsible for:
  - Building cell contexts via `extractCellContext(...)` (`src/lib/nlca/neighborhood.ts`)
  - Calling `NlcaOrchestrator` to get decisions
  - Returning the `next` grid + metrics (+ optional per-cell colors)

**Stepper → Orchestrator → Server APIs**

- `NlcaOrchestrator` (`src/lib/nlca/orchestrator.ts`) talks to SvelteKit endpoints:
  - `POST /api/nlca/decide` (cell-mode fan-out)
  - `POST /api/nlca/decideFrame` (frame-batched, structured output)
  - `POST /api/nlca/decideFrameStream` (frame-batched + SSE streaming)

**Server APIs → OpenRouter**

- The SvelteKit endpoints proxy to OpenRouter’s OpenAI-compatible Chat Completions API:
  - `https://openrouter.ai/api/v1/chat/completions`
  - Supports `stream: true` for SSE-style incremental deltas
  - Uses `response_format: { type: "json_schema", ... }` for structured outputs in frame-batched mode

**Persistence**

- Frames are stored locally via `NlcaTape` (`src/lib/nlca/tape.ts`) using `@sqlite.org/sqlite-wasm`.
  - Prefers OPFS if `crossOriginIsolated` is enabled (COOP/COEP headers).

## Prompt Feeding (What We Send to the Model)

NLCA has two stepping strategies controlled by **NLCA Settings → Frame-batched mode**:

### 1) Cell-mode (per-cell agents; `frameBatched = false`)

Each cell has a `CellAgent` with a message history (`src/lib/nlca/agentManager.ts`).

For each generation:

- System prompt (once per agent): `buildCellSystemPrompt(...)` (`src/lib/nlca/prompt.ts`)
  - Includes cell position, grid size, task, and an explicit output contract.
- User prompt (every generation): `buildCellUserPrompt(req)` (`src/lib/nlca/prompt.ts`)
  - JSON payload containing generation, self state, and neighborhood samples.

Those messages are sent via:

- Client: `NlcaOrchestrator.decideCellsBatch(...)` → `POST /api/nlca/decide`
- Server: fans out to OpenRouter with request-level concurrency control.

### 2) Frame-batched mode (one call per frame; `frameBatched = true`)

The entire frame (or chunk of it) is decided via structured outputs:

- Client: `NlcaOrchestrator.decideFrame(...)` → `POST /api/nlca/decideFrame`
- Client streaming path: `NlcaStepper.decideFrameBatched(...)` → `POST /api/nlca/decideFrameStream`

Payload includes, per cell:

- `cellId`, `x`, `y`, `self`
- `neighborhood`: array of `[dx, dy, state]`
- optional `history` (bounded by **Memory window**)

**Important:** Prompt Editor “Advanced Mode” is now honored for frame-batched calls:

- Server composes the system prompt using the advanced template as a per-cell template (with `{{CELL_X}}/{{CELL_Y}}` mapped to `x/y` variables from each cell entry).

## Response Processing (What We Accept and How We Apply It)

### Cell-mode parsing

- `parseCellResponse(text)` (`src/lib/nlca/prompt.ts`)
  - Accepts plain JSON or JSON inside markdown code fences.
  - Extracts `state` and optional `color`.
  - Has a simple fallback (isolated `0` or `1`) if JSON parsing fails.

### Frame-batched parsing (non-streaming)

- `POST /api/nlca/decideFrame` returns `{ decisions: [...] }`
- Server enforces:
  - JSON schema shape
  - exact array length
  - **unique `cellId` coverage** (added during this assessment)
- Client:
  - Orchestrator maps results by `cellId`
  - Stepper builds the next grid and metrics

### Frame-batched parsing (streaming SSE)

- `POST /api/nlca/decideFrameStream` returns `text/event-stream`
- Server:
  - extracts individual decision objects from the streaming JSON output
  - emits `decision` and `progress` events
  - now enforces **unique `cellId` coverage** during streaming extraction
- Client:
  - applies partial grid updates via callbacks for real-time visualization

## Neighborhoods (How Cell Context Is Built)

Neighborhood selection is exposed in NLCA Settings and implemented in `src/lib/nlca/neighborhood.ts`:

- `getOffsets(neighborhood)` supports:
  - `moore` (8 neighbors)
  - `vonNeumann` (4 neighbors)
  - `extendedMoore` (24 neighbors)
- `transformCoordinate(...)` applies boundary semantics consistent with the CPU kernel:
  - plane (no wrapping) → out-of-bounds neighbors treated as `0`
  - cylinder/torus/mobius/klein/projective plane → wraps and optionally flips coordinates
- `extractCellContext(...)` returns `{ self, neighbors }` for each cell, used in both cell-mode and frame-batched mode payloads.

## UI Settings Audit (UI → Runtime Wiring)

### NLCA Settings modal (`src/lib/components/NlcaSettingsModal.svelte`)

| UI control | Storage | Runtime consumer | Effect |
|---|---|---|---|
| OpenRouter API Key | `localStorage.nlca_openrouter_api_key` | `Canvas.ensureNlcaReady` → orchestrator cfg | Enables NLCA stepper + OpenRouter requests |
| Model | `localStorage.nlca_model` | `Canvas.ensureNlcaReady` → orchestrator cfg | Changes OpenRouter model id |
| Neighborhood | `localStorage.nlca_neighborhood` | `NlcaStepper` / `extractCellContext` | Changes neighbor sampling offsets |
| Max Concurrency | `localStorage.nlca_max_concurrency` | `/api/nlca/decide` fanout | Controls per-request upstream concurrency in cell-mode |
| Batch size (cell-mode) | `localStorage.nlca_batch_size` | `NlcaStepper.decideCells` | Controls cells per proxy request (cell-mode) |
| Frame-batched mode | `localStorage.nlca_frame_batched` | `NlcaStepper.decideCells` | Switches between per-cell vs per-frame prompting |
| Stream frame updates | `localStorage.nlca_frame_streamed` | `NlcaStepper.decideFrameBatched` | Uses SSE endpoint for progressive updates |
| Memory window | `localStorage.nlca_memory_window` | `NlcaStepper.decideFrameBatched` | Adds per-cell history to frame prompts |
| Grid width/height | event only (`nlca-config-changed`) | `Canvas.resize` | Recreates WebGPU sim + resets NLCA run |

### Prompt Editor (`src/lib/components/NlcaPromptModal.svelte`)

| UI control | Storage | Runtime consumer | Effect |
|---|---|---|---|
| Preset task / Task text | `localStorage.nlca-prompt-config` | `nlcaPromptState.toPromptConfig()` | Changes task instructions in prompts |
| Advanced Mode + Template | `localStorage.nlca-prompt-config` | cell-mode: `buildCellSystemPrompt`; frame-batched: server system prompt | Changes the system prompt template |
| Cell color (hex) | `localStorage.nlca-prompt-config` | stepper + server schema | Enables per-cell color output + render indicators |

### Batch Run (`src/lib/components/NlcaBatchRunModal.svelte`)

- **Start Batch Run** calls `Canvas.startNlcaBatchRun(...)`.
- The modal’s progress and buffer status are now wired to live canvas state via:
  - `Canvas.getNlcaBufferStatus()`, `Canvas.getNlcaBatchRunTarget()`, `Canvas.getNlcaBatchRunCompleted()`
  - polled in `MainAppNlca.svelte`

## Robustness Notes (Current)

What’s solid today:

- Clear separation: neighborhood extraction, prompting, orchestration, UI.
- Server-side proxy prevents exposing OpenRouter directly to the client network stack and allows retries.
- Frame-batched mode uses strict structured outputs and now validates `cellId` coverage.
- Batch runs are now deterministic: compute exactly N generations and persist frames as they are computed.

Current risks / gaps:

- Context sizing: chunk sizing estimates don’t account for large advanced templates (risk of exceeding model context window).
- Playback: `NlcaPlaybackModal` loads frames into the current grid without resizing; runs with different dimensions can cause incorrect rendering or GPU buffer write errors.
- Provider variance: streaming structured outputs can fail for some providers/models; the client currently hard-fails streamed frame-batched runs to surface incompatibilities.

## Plan: Make NLCA More Robust

1. **Centralize NLCA config in a store**
   - Today NLCA settings live in localStorage + custom events + local component state.
   - Create a single `nlcaSettings` store with schema validation + typed defaults.
2. **Improve chunk sizing**
   - Include an estimate of advanced template size in chunk size calculations.
   - Add guardrails: if the rendered prompt is “too large”, auto-reduce chunk size and surface a clear UI warning.
3. **Playback safety**
   - When selecting a run, auto-resize the grid to match stored run dimensions (or explicitly block with a clear message).
4. **Better error surfaces**
   - In the UI, distinguish:
     - auth errors (401/403)
     - rate limiting (429) + effective concurrency backoff
     - structured output failures (schema mismatch / incomplete streaming)
5. **Test coverage**
   - Add unit tests for:
     - frame-batched system prompt composition when advanced template is enabled
     - `cellId` uniqueness validation behavior (server-side)

## Plan: Increase Simulation Speed (and Reduce Cost)

Primary lever: reduce the number of expensive model calls and tokens per generation.

1. **Prefer frame-batched mode**
   - It amortizes overhead into a single (or few) calls per generation.
2. **Add “compressed payload” toggle**
   - The server already supports a compact payload shape; expose it in NLCA Settings.
3. **Expose chunking knobs**
   - Add UI controls for:
     - `parallelChunks` (how many frame-chunks in flight)
     - `chunkSize` (or “auto”)
   - This is the main way to scale grids beyond a single-call context limit.
4. **Deduplicate identical contexts**
   - Orchestrator supports generation-scoped deduplication; expose it as a toggle for tasks where symmetry dominates.
5. **UI threading**
   - Move expensive context-building / payload construction into a Web Worker for large grids to keep the UI responsive (LLM latency dominates, but local work matters at 100k+ cells).

## Docs Hygiene

The following docs are currently out-of-sync with the code and should be updated to match the current OpenRouter proxy + frame-batched design:

- `NLCA_STARTER.md`
- `docs/nlca-agent-logic.md`

