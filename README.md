# NLCA — Natural Language Cellular Automata

**NLCA** replaces the hand-coded rule of a cellular automaton with a language model. Instead of writing `B3/S23`, you write *"cells survive when they have exactly 2 or 3 live neighbors"* — and the LLM decides each cell's next state, live.

<p align="center">
  <img src="static/thumbnail.jpg" alt="NLCA — Natural Language Cellular Automata" />
</p>

![Svelte](https://img.shields.io/badge/Svelte-5-ff3e00?style=flat&logo=svelte)
![WebGPU](https://img.shields.io/badge/WebGPU-Compute-blue?style=flat)
![License](https://img.shields.io/badge/License-MIT-green?style=flat)

## What is NLCA?

In a standard cellular automaton every cell applies the same fixed rule. In NLCA that rule is a prompt. Each cell sees its neighborhood as a small grid of 0s and 1s (or hex values when color is enabled), optionally remembers a history window of previous generations, and asks an LLM: *"given this neighborhood, what should my next state be?"*

The result is a cellular automaton whose behavior you shape entirely in plain English — no rule syntax to learn, no parameter tuning required. Emergent patterns arise directly from how the model interprets your intent.

## Features

- **Natural language rules** — describe behavior in English; the LLM is the rule engine
- **Multiple experiments** — run and compare several prompts side by side, each with independent state
- **Experiment panel** — collapsible sidebar showing all experiments; switch active experiment with one click
- **Frame scrubber** — seek back through stored frames without re-running the model
- **Cost & latency HUD** — tracks cumulative API cost and last-step latency per experiment
- **Read-only prompt viewer** — inspect the exact prompt (task description + configuration) for any stored experiment
- **OpenRouter model selection** — live model list from OpenRouter; swap models between experiments freely
- **Prompt presets** — curated starting prompts (Conway, majority vote, edge detection, …)
- **Advanced prompt mode** — full control over the Handlebars template sent to the model
- **Neighborhood modes** — Moore (8-cell square) or Von Neumann (4-cell orthogonal)
- **Memory window** — feed the model N previous generations for temporal patterns
- **Grid initialization** — random, blank, or tiled pattern seeds
- **Video recording** — export the canvas as a video clip
- **WebGPU rendering** — GPU-accelerated canvas even while the LLM drives the logic

## Getting started

### 1. Install dependencies

```bash
npm install
npm run dev
```

Requires a browser with WebGPU support (Chrome 113+, Edge 113+, Safari 18+).

### 2. Add your OpenRouter API key

Open **NLCA Settings** (gear icon → NLCA Settings) and paste your [OpenRouter](https://openrouter.ai) API key. The model list loads automatically.

### 3. Write a prompt

Click **Prompt** (pencil icon) in the toolbar to open the prompt editor. Describe the rule you want in plain English, or pick a preset from the dropdown.

Example prompts:
- *"A cell becomes alive if it has exactly 3 live neighbors, and stays alive if it has 2 or 3."*
- *"Cells form clusters — a dead cell springs to life only when surrounded by a majority of live cells."*
- *"Implement a reaction-diffusion-like pattern where cells alternate between alive and dead based on the balance of their neighborhood."*

### 4. Press Play

Hit **Enter** or the Play button. NLCA creates a new experiment, spins up concurrent LLM calls for every cell, and renders each generation as results arrive.

## How it works

```
┌─────────────┐     neighborhood     ┌──────────────────┐
│  Grid state │ ──── as text ──────▶ │   LLM (via API)  │
│  (current   │                      │  "0 or 1?"       │
│   + history)│ ◀─── next state ──── │                  │
└─────────────┘                      └──────────────────┘
        │
        ▼  (all cells in parallel)
  next generation
```

Each cell's neighborhood is serialized to text (e.g. a 3×3 grid of `0`/`1` values). The task description is prepended. The model responds with `0` or `1` (or an RGB hex when color mode is on). All cells in a generation are dispatched concurrently up to the configured concurrency limit.

Frames are stored in SQLite (OPFS) so you can seek back through history without re-invoking the model.

## Core flow

| Step | What to do |
|------|-----------|
| **Configure** | NLCA Settings → pick model, grid size, neighborhood, memory window |
| **Prompt** | Toolbar Prompt button → write task description or pick preset |
| **Play** | Press Enter or Play — a new experiment starts |
| **Watch** | HUD shows generation count, cost, and latency in real time |
| **Scrub** | Drag the frame scrubber to replay earlier generations |
| **Compare** | Press `+` in the Experiments panel to start a second experiment with different settings |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Play / Pause / New Experiment |
| `S` | Step one generation |
| `E` | Toggle Experiments panel |
| `I` | Initialize grid |
| `D` | Clear grid |
| `G` | Toggle grid lines |
| `F` / `Home` | Fit canvas to screen |
| `, .` | Slower / Faster (for non-LLM step modes) |
| `Shift+?` | Help overlay |
| `Esc` | Close panels and modals |

## Settings reference

### NLCA Settings

| Setting | Description |
|---------|-------------|
| Model | OpenRouter model to use (e.g. `openai/gpt-4o-mini`, `anthropic/claude-haiku-4-5`) |
| Neighborhood | Moore (8 neighbors) or Von Neumann (4 neighbors) |
| Grid size | Width × height in cells |
| Memory window | How many previous generations the model sees (0 = current only) |
| Target frames | How many generations to run before auto-pausing |

### API Settings

| Setting | Description |
|---------|-------------|
| API key | Your OpenRouter API key |
| Max concurrency | Parallel LLM requests per generation |
| Batch size | Cells per request (when batching is enabled) |

## Running locally

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # production build
npm run preview    # preview production build
```

## Tech stack

- **SvelteKit 5** with runes for reactivity
- **WebGPU** compute + render for the canvas
- **OpenRouter** for LLM access (any model they carry)
- **SQLite (OPFS)** for per-experiment frame storage
- **Handlebars** for the prompt template system

## Attribution

NLCA is built on top of **[Games of Life](https://github.com/neovand/games-of-life)** by [Neo Mohsenvand](https://github.com/neovand) — a WebGPU-powered cellular automaton engine with a rich rule editor, brush tools, hex grids, audio sonification, and more. The WebGPU rendering pipeline, canvas infrastructure, and simulation architecture all come from that project.

## License

MIT
