# NLCA: Grid cells as agents — API calls, neighborhoods, and prompt construction

This document describes **Neural-Linguistic Cellular Automata (NLCA)** in this repository: how each grid square is treated as an **agent**, which **HTTP APIs** are invoked, and **exactly** what goes into **system** and **user** prompts (including neighbors, “how far” each cell sees, configurable parameters, and mode differences). It is written for engineers extending the system; every claim below is tied to the current implementation.

---

## 1. Mental model: one agent per cell

- **Stable cell identity**: Each cell has `cellId = x + y * width` (row-major index). See `CellContext` in `src/lib/nlca/types.ts` and `extractCellContext` in `src/lib/nlca/neighborhood.ts`.
- **Per-cell “agent” in cell (non–frame-batched) mode**: A `CellAgent` (`src/lib/nlca/agentManager.ts`) holds a **chat message list** (`system`, repeated `user`/`assistant` pairs). One OpenRouter chat completion is executed **per cell** (batched into one HTTP request to *this app’s* proxy, which fans out upstream).
- **Frame-batched mode**: There is **no per-cell OpenRouter call**. Instead, many cells are packed into **one** (or a few **chunked**) OpenRouter `chat/completions` request(s) with **structured JSON output** listing a decision per `cellId`. The model is instructed as a single “frame solver,” but each entry in the user JSON still corresponds to one spatial cell with its own neighborhood sample.

So “each square is an agent” is **literally true** in cell mode (separate conversation state per `CellAgent`). In frame mode, it is **true at the data level** (each cell has its own row in the payload) but **not** at the HTTP/OpenRouter session level (shared request and shared system prompt for the batch).

---

## 2. How far can a cell “see”? (Neighborhood radius and topology)

Neighbor visibility is **not** a separate numeric “radius” setting. It is entirely determined by the **`NlcaNeighborhood`** enum on the stepper config:

| `neighborhood` value   | Meaning | Offsets included (`dx`, `dy` relative to cell) | Count |
|-------------------------|---------|--------------------------------------------------|------|
| `moore` (default)       | Chebyshev distance 1: 8 neighbors              | `(-1,-1) (0,-1) (1,-1) (-1,0) (1,0) (-1,1) (0,1) (1,1)` | 8 |
| `vonNeumann`            | Manhattan distance 1: 4 orthogonal neighbors   | `(0,-1) (0,1) (-1,0) (1,0)` | 4 |
| `extendedMoore`         | Chebyshev distance 2: 5×5 block minus center   | All `(dx,dy)` with `dx,dy ∈ {-2,-1,0,1,2}` except `(0,0)`, in **nested loop order**: outer `dy` from `-2` to `2`, inner `dx` from `-2` to `2` | 24 |

Implementation: `getOffsets` in `src/lib/nlca/neighborhood.ts`.

**“How far” in grid units**

- **Moore / von Neumann**: distance **1** (only adjacent cells).
- **Extended Moore**: distance **2** in Chebyshev sense (a 5×5 ring of cells around the center, excluding the center).

There is **no** larger-radius neighborhood in code today.

### 2.1 Boundary conditions (how out-of-bounds neighbors are read)

Neighbor samples are read from the **previous generation** grid via `getCell01` → `transformCoordinate` in `src/lib/nlca/neighborhood.ts`, using the same **`BoundaryMode`** as the main simulation (`src/lib/stores/simulation.svelte.ts`).

- **Non-wrapping boundaries**: If a neighbor coordinate maps outside the grid, `transformCoordinate` returns `null` and `getCell01` treats that neighbor as state **`0`** (dead).
- **Wrapping / exotic topologies** (`cylinderX`, `torus`, `mobiusX`, etc.): Coordinates are wrapped and optional **parity flips** applied so neighbor reads match the CPU CA kernel semantics (see comments in `transformCoordinate`).

The NLCA stepper receives `boundary` from the UI (`Canvas.svelte` passes `simState.boundaryMode`). The experiment manager currently hard-codes **`boundary: 'torus'`** when constructing `NlcaStepper` in `src/lib/nlca/experimentManager.svelte.ts` — that is a behavioral difference vs interactive NLCA on the main canvas.

### 2.2 What each neighbor carries

Each neighbor is a `NeighborSample`: `{ dx, dy, state }` where `state ∈ {0,1}` is read from the **previous** frame (`prev` buffer) at `(x+dx, y+dy)` after boundary transform. Built in `extractCellContext`.

---

## 3. End-to-end execution path (client)

High-level flow each generation:

1. `NlcaStepper.step(prev, width, height, generation, callbacks?, promptConfig?)` (`src/lib/nlca/stepper.ts`)
2. `buildContexts` scans every `(x,y)` and calls `extractCellContext` → array of `CellContext`.
3. `decideCells` chooses:
   - **If** `orchestrator.frameBatched === true` → `decideFrameBatched` (one frame request, optionally SSE streaming, with fallback to parallel chunks on failure except when streaming is enabled — see §5).
   - **Else** → classic **per-cell** path: batches of `batchSize` cells, each cell an agent (`CellAgentManager.getAgent`), `NlcaOrchestrator.decideCellsBatch` → `POST /api/nlca/decide`.

`PromptConfig` (task + template + color flag) is built from:

- Interactive NLCA: `getNlcaPromptState().toPromptConfig()` in `src/lib/stores/nlcaPrompt.svelte.ts` (used from `Canvas.svelte`).
- Experiments: `buildPromptConfig` in `src/lib/nlca/experimentManager.svelte.ts` maps `ExperimentConfig.cellColorEnabled` → `PromptConfig.cellColorHexEnabled`.

---

## 4. `PromptConfig` — every field and how it is used

Defined in `src/lib/nlca/prompt.ts`:

| Field | Type | Role |
|-------|------|------|
| `taskDescription` | `string` | **Primary task text** injected as `{{TASK}}` in templates, or sent as `task` / `t` in frame user JSON. **Required** on the server for frame routes: `promptConfig.taskDescription` must be a string (`decideFrame` / `decideFrameStream` validate this). |
| `useAdvancedMode` | `boolean` | If **true** and `advancedTemplate` is a non-empty string, that template drives the **system** side (with placeholder substitution). If false, a shorter default system prompt is used on the server for frame mode; client uses `DEFAULT_TEMPLATE` for cell system prompts. |
| `advancedTemplate` | `string?` | Full markdown/text template with placeholders (see §6). |
| `cellColorHexEnabled` | `boolean?` | If **true**, the output contract requires a per-cell hex color (`#RRGGBB`) in addition to `state`. Drives JSON schema on frame routes and parsing in the orchestrator. |

**Not** part of `PromptConfig` but tightly coupled on frame APIs:

- `compressPayload` — carried on `NlcaOrchestratorConfig` / experiment config, forwarded as `promptConfig.compressPayload` in the JSON body to `decideFrame` / `decideFrameStream` (see `orchestrator.ts` and `stepper.ts`). Changes **user JSON shape** and system prompt hints (§7).

---

## 5. HTTP APIs (this SvelteKit app → OpenRouter)

All upstream calls go to `https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer <apiKey>` from the client-supplied key (see `src/routes/api/nlca/decide/+server.ts`, `decideFrame/+server.ts`, `decideFrameStream/+server.ts`).

### 5.1 `POST /api/nlca/decide` — **per-cell** completions (cell mode)

**Client**: `NlcaOrchestrator.decideCellsBatch` (`src/lib/nlca/orchestrator.ts`).

**Request body (subset)**:

- `apiKey`, `model`, `temperature`, `maxOutputTokens`, `timeoutMs`
- `maxConcurrency` — max **parallel** upstream OpenRouter calls **inside this single HTTP request** to your app (implemented with `asyncPool` on the server).
- `cells`: array of `{ cellId, messages }` where `messages` is the full OpenAI-style array built on the client.

**Server behavior**: For each cell, sends `messages` unchanged to OpenRouter (after mapping to `{ role, content }`). Retries on 429 / 5xx. Returns `{ results: [...], stats: {...} }` per cell.

**Important**: The server does **not** build NLCA prompts. The **client** builds `system` + `user` content before calling this endpoint.

### 5.2 `POST /api/nlca/decideFrame` — **frame** structured output (non-streaming)

**Client**: `NlcaOrchestrator.decideFrame`.

**Request body (subset)**:

- `apiKey`, `model`, `temperature`, `timeoutMs`, `maxOutputTokens` (server bumps `max_tokens` based on cell count and color mode)
- `width`, `height`, `generation`
- `cells`: array of `{ cellId, x, y, self, neighborhood, history? }` where `neighborhood` is `Array<[dx, dy, state]>`
- `promptConfig`: `{ taskDescription, useAdvancedMode, advancedTemplate?, cellColorHexEnabled?, compressPayload? }`

**Server behavior**: Builds **system** + **user** messages (§6–§7), sets `response_format: { type: 'json_schema', json_schema: { strict: true, ... } }`, validates returned `decisions` length, uniqueness, and coverage of `cellId`s.

### 5.3 `POST /api/nlca/decideFrameStream` — same as frame, but **SSE** to browser

**Client**: `NlcaStepper.decideFrameBatched` when `frameStreamed === true` (`src/lib/nlca/stepper.ts`).

Same payload shape as `decideFrame` (including `promptConfig` spread from UI + `compressPayload` from orchestrator config). Response is `text/event-stream` with `decision`, `progress`, `done`, `error` events (parsed in `stepper.ts`). If streaming fails, **no** fallback to chunking (explicit `throw` path) — differs from non-streamed frame path.

---

## 6. Cell mode: exact prompt construction

### 6.1 System message — `buildCellSystemPrompt`

**File**: `src/lib/nlca/prompt.ts`

Inputs: `cellId` (currently unused in template), `x`, `y`, `width`, `height`, optional `PromptConfig`.

Logic:

1. **Task text**: `config.taskDescription` or built-in `DEFAULT_TASK` (filled square demo).
2. **Template**: If `useAdvancedMode && advancedTemplate`, use `advancedTemplate`; else use `DEFAULT_TEMPLATE` (large instructional block describing CA + JSON input/output).
3. **Output contract**: `buildOutputContract(config)` — either `{"state":0|1}` only, or `{"state":0|1,"color":"#RRGGBB"}` with uppercase hex constraint.
4. **Placeholder substitution** via `replacePlaceholders`:
   - `{{CELL_X}}`, `{{CELL_Y}}`, `{{GRID_WIDTH}}`, `{{GRID_HEIGHT}}`, `{{MAX_X}}` (= width−1), `{{MAX_Y}}`, `{{TASK}}`, `{{OUTPUT_CONTRACT}}`
5. If the chosen template **does not** contain `{{OUTPUT_CONTRACT}}`, the function **appends** a trailing `== OUTPUT CONTRACT ==` section so the model still sees hard output rules.

**Orchestrator integration** (`decideCellsBatch`):

- On **first** use of a `CellAgent`, if `!agent.hasSystemPrompt()`, it pushes **one** `system` message built with that cell’s `(x,y)` and grid size.
- Then pushes a **user** message every generation.

### 6.2 User message — `buildCellUserPrompt`

**File**: `src/lib/nlca/prompt.ts`

Builds a **JSON string** (not an object sent separately) with keys:

```json
{
  "generation": <number>,
  "state": <0|1 self on previous frame>,
  "neighbors": <integer count of neighbors with state 1>,
  "neighborhood": [[dx, dy, state], ...]
}
```

Notes:

- `neighbors` is **only** the count of **alive** (`state === 1`) samples in the `NeighborSample[]`; it is **not** fixed to 0–8 in code — for von Neumann it is 0–4, for extended Moore 0–24. The **default template text** in `nlcaPrompt.svelte.ts` / `DEFAULT_TEMPLATE` still says “0-8 for Moore neighborhood” in prose — that is **inaccurate** if the simulation neighborhood is not Moore; expansions should fix copy or make it dynamic.
- `NlcaCellRequest` also carries `cellId`, `x`, `y`, `runId`, `width`, `height` for tracing, but **`buildCellUserPrompt` does not include them in the JSON**. Position context is expected to live in the **system** prompt.

### 6.3 Assistant message and parsing

- Raw model text is appended as an `assistant` message (even on failure, a minimal JSON string may be written).
- `parseCellResponse` (`prompt.ts`) accepts JSON or fenced ```json blocks, keys `state`/`s`, optional `confidence`/`c`, optional `color` with strict `#RRGGBB` normalization. Fallback: lone `0` or `1` heuristics.

### 6.4 Color in cell mode

If `promptConfig.cellColorHexEnabled` is true, `parseCellResponse` extracts color; orchestrator copies `colorHex` / `colorStatus` into `CellDecisionResult` **only** when the flag is enabled.

---

## 7. Frame mode: server-built system + user JSON

**Files**: `src/routes/api/nlca/decideFrame/+server.ts` and `src/routes/api/nlca/decideFrameStream/+server.ts` (duplicate helpers: `buildSystemPrompt`, `buildUserPayload`, `buildJsonSchema`).

### 7.1 System prompt composition

Two major branches:

**A) Advanced mode** (`useAdvancedMode === true` and non-empty `advancedTemplate`):

1. Frame-specific placeholder rendering `renderAdvancedTemplateForFrame`:
   - **Critical behavior**: `{{CELL_X}}` → literal substring **`x`**, `{{CELL_Y}}` → **`y`** (the letters), **not** numeric coordinates. Rationale in code comment: in frame mode, coordinates come from each cell object in the user JSON; the model is told to interpret **`x` and `y` as variables** referencing those payload fields.
   - Other placeholders use global `width` / `height` / `taskDescription` / frame-level `buildFrameOutputContract(wantColor)`.
2. If `{{OUTPUT_CONTRACT}}` was absent from the template, the frame output contract block is **appended**.
3. The server prepends fixed instructions, including:
   - synchronous CA update story,
   - “Apply the following **per-cell system prompt template** to each cell entry” (advanced path only),
   - optional **compressed format** line (§7.2),
   - optional color-mode line,
   - “Return ONLY valid JSON matching the provided schema.”

**B) Default (non-advanced) frame system prompt**

Short variant: CA synchronous update + task + optional compressed line + color line + schema-only return — **no** injection of the long `DEFAULT_TEMPLATE` from `prompt.ts` (that file’s default is **cell-mode oriented**).

### 7.2 User payload — verbose vs compressed

Both routes call `buildUserPayload`.

**Verbose** (`compressPayload` not true):

```json
{
  "generation": <number>,
  "width": <number>,
  "height": <number>,
  "task": "<taskDescription string>",
  "colorMode": "on" | "off",
  "cells": [
    {
      "id": <cellId>,
      "x": <number>,
      "y": <number>,
      "self": <0|1>,
      "aliveNeighbors": <count of state===1 in neighborhood array>,
      "neighborhood": [[dx, dy, state], ...],
      "history": [<0|1>, ...]   // only if non-empty array provided
    }
  ]
}
```

**Compressed** (`compressPayload === true`):

```json
{
  "g": generation,
  "w": width,
  "h": height,
  "t": taskDescription,
  "c": 1 | 0,   // color on/off
  "d": [
    [cellId, x, y, self, aliveCount, [neighbor states in offset order...], ?historyArray],
    ...
  ]
}
```

**Neighbor state order in compressed mode**

The array `neighborStates` / `nStates` is built by iterating `cell.neighborhood` **in the order provided by the client** — which originates from `getOffsets(neighborhood)` order in `extractCellContext`. The system prompt line claims *“reading order (top-left to bottom-right)”* — that phrase is **only literally descriptive for extended Moore’s nested `dy` then `dx` loop**; for standard Moore it is a **specific 8-neighbor order** (see §2 table), not a full rectangle scan. **Implementers extending neighborhoods must keep server hint text, compressed order, and `getOffsets` consistent.**

**History field**

- Included only when `memoryWindow > 0` on the client (`NlcaStepper.decideFrameBatched` / chunking).
- Values are the last `memoryWindow` **post-decision states** (0/1) for that `cellId`, **most recent last** — maintained in `frameHistory` in `stepper.ts` after each successful frame: it pushes `next` state (or keeps `self` if a decision was missing).

### 7.3 Frame output JSON schema (strict)

`buildJsonSchema` enforces:

- Top-level `{ "decisions": [ ... ] }` only.
- `decisions.length` **exactly** equals number of requested cells in **this** HTTP call.
- Each item: `{ cellId, state }` plus required **`color`** (`^#[0-9A-F]{6}$`) if color mode on.

The client orchestrator then maps `cellId` → `CellDecisionResult`, including color normalization.

---

## 8. Orchestrator / stepper parameters (not all in `PromptConfig`)

These live on `NlcaOrchestratorConfig` (`src/lib/nlca/types.ts`) and affect API behavior or payload:

| Parameter | Effect |
|-----------|--------|
| `frameBatched` | Switches between **cell** path (`/decide`) and **frame** path (`/decideFrame` or stream). |
| `frameStreamed` | If true **and** `frameBatched`, uses `/decideFrameStream` SSE; **no silent fallback** on error. If false, uses `decideFrame` with optional fallback to parallel chunks. |
| `memoryWindow` | Max length of per-cell `history` appended in **frame** payloads (0 disables). |
| `maxConcurrency` | Server-side parallelism for **`/decide`** only. |
| `batchSize` | Number of cells per **`decideCellsBatch`** HTTP round-trip in cell mode (each round-trip still contains many per-cell upstream calls). |
| `cellTimeoutMs` | Abort timeout per upstream fetch (both modes). |
| `compressPayload` | Frame user JSON compression + system prompt hint (§7.2). |
| `deduplicateRequests` | Before calling `decideFrame`, hash `(self, sorted neighbor tuples, optional history)` **excluding position**; identical contexts reuse cached decision within a generation (`hashCellContext` / cache in `orchestrator.ts`). |
| `parallelChunks` | When frame call fails and falls back, max concurrent chunk requests (default **4** if unset). |
| `chunkSize` | Explicit cells per chunk for fallback; if unset, `calculateChunkSize` estimates from model id + `compressPayload` + `memoryWindow` + neighborhood size. |
| `model.maxOutputTokens` | Cell mode uses per-cell cap; frame mode uses `Math.max(8192, maxOutputTokens)` on client; server may raise further based on cell count. |

**Interactive `Canvas` wiring** (`src/lib/components/Canvas.svelte`): passes `apiKey`, `model` (temperature **0**, maxOutputTokens **64** for the stored model object), `maxConcurrency`, `batchSize`, `frameBatched`, `frameStreamed`, `memoryWindow`, `cellTimeoutMs: 30_000`. It does **not** currently pass `compressPayload`, `deduplicateRequests`, `parallelChunks`, or `chunkSize` — those default to `undefined` / falsy in `NlcaOrchestrator` behavior.

**Experiments** (`MainAppNlca.svelte` → `ExperimentConfig`): sets `compressPayload: false`, `deduplicateRequests: false` explicitly today; still no UI for `parallelChunks` / `chunkSize`.

---

## 9. Persistence and settings (where parameters live)

- **Prompt UI + localStorage**: key `nlca-prompt-config` in `src/lib/stores/nlcaPrompt.svelte.ts` (`taskDescription`, `useAdvancedMode`, `advancedTemplate`, `cellColorHexEnabled`, preset id).
- **Technical settings + localStorage**: keys in `src/lib/stores/nlcaSettings.svelte.ts` (`nlca_frame_batched`, `nlca_frame_streamed`, `nlca_memory_window`, `nlca_neighborhood`, grid sizes, concurrency, batch size, etc.).
- **Tape DB**: run metadata includes `neighborhood`, `model`, `max_concurrency`, and full `config_json` for experiments (`src/lib/nlca/tape.ts`).

---

## 10. Known documentation / copy mismatches (for implementers)

1. **Neighbor count prose**: Default templates say alive neighbor count is **0–8 (Moore)**; actual range depends on `neighborhood` (§2, §6.2).
2. **“Top-left to bottom-right”** for compressed neighbor arrays: order is **`getOffsets` order**, not necessarily a visual rectangle scan except for extended Moore’s loop structure.
3. **Experiments vs canvas boundary**: experiments use **torus** for NLCA neighbor reads; canvas uses **current simulation boundary**.

---

## 11. Quick reference — source files

| Concern | Primary files |
|--------|----------------|
| Neighborhood geometry + boundary reads | `src/lib/nlca/neighborhood.ts` |
| Per-cell vs frame routing | `src/lib/nlca/stepper.ts` |
| HTTP client, dedupe, chunking | `src/lib/nlca/orchestrator.ts` |
| Cell prompt text + parsing | `src/lib/nlca/prompt.ts` |
| Agent message storage | `src/lib/nlca/agentManager.ts` |
| Types | `src/lib/nlca/types.ts` |
| Cell proxy API | `src/routes/api/nlca/decide/+server.ts` |
| Frame API + schema | `src/routes/api/nlca/decideFrame/+server.ts` |
| Frame SSE API | `src/routes/api/nlca/decideFrameStream/+server.ts` |
| Prompt presets / placeholders UI | `src/lib/stores/nlcaPrompt.svelte.ts`, `NlcaPromptModal.svelte` |
| Live wiring | `src/lib/components/Canvas.svelte`, `MainAppNlca.svelte` |
| Experiments | `src/lib/nlca/experimentManager.svelte.ts` |

---

## 12. Summary sentence

**Each grid cell** is identified by **`cellId`**, reads **binary** neighbor states within a **fixed pattern** (`moore` / `vonNeumann` / `extendedMoore`) from the **previous** frame under the simulation **boundary** rules, and either (**cell mode**) participates in its **own** multi-turn chat whose **user** turn is a small JSON (`generation`, `self`, alive count, full `neighborhood` list) with a rich **system** prompt from `PromptConfig`, or (**frame mode**) contributes one object to a **batch user JSON** and receives decisions from a **single structured-output** completion per chunk, with optional **history**, **color**, **compression**, and **deduplication** layered on as described above.
