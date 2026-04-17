# NLCA (Neural Language Cellular Automata) Starter Guide

This guide will walk you through setting up and testing the LLM-driven cellular automata feature.

## Prerequisites

- A modern browser with WebGPU support (Chrome 113+, Edge 113+, Safari 18+, Firefox Nightly)
- An OpenRouter.ai account and API key
- Node.js and npm installed (for development)

## Step 1: Get an OpenRouter API Key

1. Visit [OpenRouter.ai](https://openrouter.ai/)
2. Sign up or log in to your account
3. Navigate to your [API Keys page](https://openrouter.ai/keys)
4. Click "Create Key" to generate a new API key
5. Copy the API key (it will start with `sk-or-...`)

**Note:** OpenRouter uses a pay-as-you-go model. You'll be charged based on the model you choose and the number of tokens used. For testing, start with smaller grids (32×32 or 64×64) to minimize costs.

## Step 2: Install Dependencies

If you haven't already, install the project dependencies:

```bash
npm install
```

The NLCA feature requires:
- `@langchain/core` - LangChain core functionality
- `@langchain/openai` - OpenAI-compatible LangChain client
- `@sqlite.org/sqlite-wasm` - Browser SQLite for frame storage

These should already be installed if you've run `npm install` after the implementation.

## Step 3: Start the Development Server

```bash
npm run dev
```

The app will be available at `http://localhost:5173` (or the port Vite assigns).

**Important:** For SQLite WASM with OPFS (persistent storage) to work, the dev server must serve with specific headers. The `vite.config.ts` has been configured to include:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

If you're using a different dev server setup, ensure these headers are present.

## Step 4: Navigate to the NLCA Route

1. Open your browser and go to `http://localhost:5173/nlca`
2. You should see the NLCA canvas interface (similar to the main app but with NLCA-specific controls)

## Step 5: Configure NLCA Settings

1. Click the **NLCA Settings** button (gear icon) in the controls toolbar
2. In the modal that appears:
   - **OpenRouter API Key**: Paste your API key from Step 1
   - **Model**: Choose a model (default: `openai/gpt-4.1-mini`)
     - Recommended for testing: `openai/gpt-4.1-mini` (fast, cheap)
     - For better quality: `openai/gpt-4o-mini` or `anthropic/claude-3-haiku`
   - **Neighborhood**: Choose the neighborhood type
     - `Moore (8)` - Standard 8-neighbor Moore neighborhood
     - `Von Neumann (4)` - 4-neighbor cross pattern
     - `Extended Moore (24)` - Extended 24-neighbor pattern
   - **Batch size**: Number of cells to process per LLM request (default: 128)
     - Smaller batches = more requests but faster per-request
     - Larger batches = fewer requests but slower per-request
     - Recommended: 64-256 for testing
   - **Grid width/height**: Size of the square grid (default: 64×64)
     - **Important:** Start small! Larger grids mean exponentially more LLM calls
     - 32×32 = 1,024 cells per generation
     - 64×64 = 4,096 cells per generation
     - 128×128 = 16,384 cells per generation (very expensive!)
3. Click **Save**

Your settings are stored in `localStorage` and will persist across sessions.

## Step 6: Initialize the Grid

1. Click the **Initialize** button (grid icon) in the controls
2. Choose a pattern:
   - **Blank** - Start with an empty grid
   - **Random** - Randomly populate cells
   - **Patterns** - Predefined patterns (glider, blinker, etc.)
3. The grid will be populated and ready for NLCA stepping

## Step 7: Run Your First NLCA Generation

1. Click the **Play** button (▶) or press **Enter** to start
2. The simulation will:
   - Read the current grid state
   - For each cell, gather its neighborhood context (neighbors' previous states + its own current state)
   - Batch cells into groups and send them to the LLM via OpenRouter
   - Parse LLM responses (each cell outputs 0 or 1)
   - Update the grid with the new states
   - Save the frame to SQLite for playback
   - Increment the generation counter

3. You'll see:
   - A "thinking" indicator in the UI while LLM calls are in progress
   - The generation counter incrementing
   - The grid updating with new patterns
   - Colorization based on agent metrics (response latency, change flags)

**Note:** The first generation may take a while as the LLM processes all cells. Subsequent generations should be faster due to batching optimizations.

## Step 8: Monitor Costs and Performance

- **Generation time**: Check the console or UI for timing information
- **API costs**: Monitor your OpenRouter dashboard for usage
- **Errors**: If you see errors, check:
  - API key is valid and has credits
  - Model name is correct
  - Network connectivity
  - Browser console for detailed error messages

## Step 9: Use Playback Feature

1. Click the **Playback** button (circular arrow icon) in the controls
2. In the playback modal:
   - Select a run from the dropdown (runs are automatically created when you start stepping)
   - Use the slider to scrub through generations
   - Click **Play** to replay the saved frames
   - Click **Latest** to jump to the most recent generation

All frames are stored in browser SQLite (OPFS) and persist across page reloads.

## Step 10: Experiment!

Try different configurations:
- **Different models**: Some models may produce more interesting patterns
- **Different neighborhoods**: Moore vs Von Neumann vs Extended Moore
- **Different initial patterns**: Random vs structured patterns
- **Different grid sizes**: Start small, then scale up if you want
- **Different batch sizes**: Balance between speed and API efficiency

## Troubleshooting

### "WebGPU Not Available"
- Ensure you're using a supported browser
- Check that WebGPU is enabled in browser settings
- Try a different browser

### "API Key Invalid" or Authentication Errors
- Verify your API key is correct
- Check that your OpenRouter account has credits
- Ensure the key hasn't been revoked

### SQLite/OPFS Not Working
- Check browser console for errors
- Ensure dev server headers are set correctly
- Try a different browser (Chrome/Edge have best OPFS support)

### Slow Performance
- Reduce grid size
- Increase batch size (fewer requests)
- Use a faster model
- Check network latency to OpenRouter

### No Frames in Playback
- Ensure you've run at least one generation
- Check browser console for SQLite errors
- Try refreshing the page and checking again

## Cost Estimation

**Rough cost per generation** (using `openai/gpt-4.1-mini`):
- 32×32 grid (1,024 cells): ~$0.01-0.05 per generation
- 64×64 grid (4,096 cells): ~$0.05-0.20 per generation
- 128×128 grid (16,384 cells): ~$0.20-0.80 per generation

Costs vary based on:
- Model pricing
- Prompt complexity
- Response parsing overhead
- Batch efficiency

**Tip:** Start with 32×32 or 64×64 grids to test, then scale up once you're happy with the results.

## Next Steps

- Explore different LLM models to see how they affect pattern evolution
- Try different neighborhoods to see how context affects decisions
- Experiment with initial patterns to see how they evolve
- Use the playback feature to analyze interesting patterns
- Check the colorization to see which cells are "active" (changing frequently)

## Technical Details

- **Storage**: Frames are stored in browser SQLite using OPFS (Origin Private File System)
- **Batching**: Cells are processed in configurable batches to optimize API usage
- **Retries**: Failed LLM requests are retried with smaller batch sizes
- **Metrics**: Per-cell metrics (latency, change flags) are stored and visualized
- **History**: Full frame history is preserved for playback and analysis

Enjoy exploring LLM-driven cellular automata! 🎉

