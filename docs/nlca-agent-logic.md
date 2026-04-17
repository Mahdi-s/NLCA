# NLCA Agent Logic Analysis

This document provides a comprehensive analysis of the Neural-Linguistic Cellular Automata (NLCA) implementation, explaining the logic flow and reasoning for approval.

## Overview

NLCA replaces traditional CA transition rules with LLM-based agents. Each cell on the grid is represented by an independent agent that decides its next state based on:
1. Its position on the grid
2. Its current state
3. The states of neighboring cells
4. A task-specific prompt (currently: form a square border)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Canvas.svelte                           │
│  (Triggers NLCA step when playing or manual step requested)     │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                         NlcaStepper                             │
│  - Builds cell contexts from grid state                         │
│  - Manages parallel execution                                   │
│  - Collects results and builds next grid state                  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      NlcaOrchestrator                           │
│  - Invokes LLM for each cell decision                           │
│  - Manages conversation history via CellAgent                   │
│  - Tracks tokens and costs                                      │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      prompt.ts Functions                        │
│  - buildCellSystemPrompt: Task instructions + position          │
│  - buildCellUserPrompt: Neighbor state context                  │
│  - parseCellResponse: Extract state from LLM output             │
└─────────────────────────────────────────────────────────────────┘
```

## Component Analysis

### 1. Prompt Strategy (`src/lib/nlca/prompt.ts`)

#### System Prompt

```typescript
function buildCellSystemPrompt(cellId, x, y, width, height): string
```

The system prompt tells each cell:
- Its exact position `(x, y)` on the grid
- The grid dimensions (currently 10×10)
- The task: form a square border
- Decision rules:
  - Edge cells (x=0, x=9, y=0, or y=9) → output 1
  - Interior cells → output 0
  - Coordinate with neighbors for continuity

**Analysis:** The prompt is well-structured:
- ✅ Position-aware: Each cell knows where it is
- ✅ Clear binary output: Only 0 or 1
- ✅ Deterministic rules: Edge detection is unambiguous
- ✅ Token-efficient: Minimal text, OpenRouter caches system prompts

#### User Prompt

```typescript
function buildCellUserPrompt(req: NlcaCellRequest): string
```

Each generation, the cell receives:
```json
{
  "g": 0,           // generation number
  "s": 0,           // self state (0 or 1)
  "alive": 3,       // count of alive neighbors
  "n": [[-1,-1,0], [0,-1,1], ...]  // [dx, dy, state] for each neighbor
}
```

**Analysis:**
- ✅ Compact JSON minimizes tokens
- ✅ Provides full neighbor context for coordination
- ✅ Generation tracking enables temporal reasoning

#### Response Parsing

```typescript
function parseCellResponse(text: string): NlcaCellResponse | null
```

Handles multiple response formats:
1. Clean JSON: `{"state":1}`
2. Markdown-wrapped: ` ```json {"state":1} ``` `
3. Fallback: Searches for isolated 0 or 1

**Analysis:**
- ✅ Robust parsing handles LLM output variability
- ✅ Fallback logic prevents hard failures
- ✅ Returns null on unparseable input (cell keeps current state)

---

### 2. Agent Management (`src/lib/nlca/agentManager.ts`)

#### CellAgent Class

Each cell has its own agent instance with:
- Persistent conversation history across generations
- Bounded history (default: 20 messages) to prevent token explosion
- System prompt preservation during trimming

```typescript
class CellAgent {
  readonly cellId: number;
  readonly x: number;
  readonly y: number;
  private history: AgentMessage[];
  private maxHistoryLength: number;
}
```

**Analysis:**
- ✅ Per-cell memory enables learning from past decisions
- ✅ History trimming keeps first message (system) + recent exchanges
- ✅ Bounded memory prevents unbounded token costs

#### CellAgentManager Class

Manages the pool of 100 agents (10×10 grid):
- Lazy agent creation (on first access)
- Reset capability for new runs
- Dimension tracking for grid resizes

**Analysis:**
- ✅ Lazy creation avoids premature allocation
- ✅ Clear reset semantics for new experiments
- ✅ Thread-safe design (each agent accessed independently)

---

### 3. Neighborhood Extraction (`src/lib/nlca/neighborhood.ts`)

Supports three neighborhood types:
- **Moore** (8 neighbors): Standard CA neighborhood
- **von Neumann** (4 neighbors): Cardinal directions only
- **Extended Moore** (24 neighbors): 5×5 minus center

```typescript
function extractCellContext(prev, width, height, x, y, neighborhood, boundary): CellContext
```

**Boundary Handling:**

The implementation correctly handles all 9 boundary modes:
- `plane`: Edges see dead (0) neighbors
- `torus`: Wraps both axes
- `cylinderX/Y`: Wraps one axis
- `mobiusX/Y`: Wraps with flip
- `kleinX/Y`: Klein bottle topology
- `projectivePlane`: Both edges flip

**Analysis:**
- ✅ Correct modular arithmetic for wrapping
- ✅ Flip logic matches CPU kernel semantics
- ✅ Returns null for out-of-bounds in non-wrapping modes (treated as 0)

---

### 4. Orchestrator (`src/lib/nlca/orchestrator.ts`)

#### LLM Configuration

```typescript
new ChatOpenAI({
  apiKey: cfg.apiKey,
  model: cfg.model.model,       // e.g., 'openai/gpt-4.1-mini'
  temperature: 0,                // Deterministic output
  maxTokens: 64,                 // Minimal output tokens
  timeout: 30000,                // 30s per cell
  maxRetries: 2,
  configuration: {
    baseURL: 'https://openrouter.ai/api/v1'
  }
});
```

**Analysis:**
- ✅ Temperature 0 ensures reproducible decisions
- ✅ Low max tokens prevents verbose responses
- ✅ Retry logic handles transient failures
- ✅ Timeout prevents hung cells from blocking

#### Decision Flow

```typescript
async decideCell(agent: CellAgent, req: NlcaCellRequest): Promise<CellDecisionResult>
```

1. Build system prompt if not in history
2. Build user prompt with current state
3. Invoke LLM with full conversation history
4. Parse response and extract state
5. Add assistant response to history
6. Return result with metrics

**Error Handling:**
- On parse failure: Log warning, keep current state
- On LLM error: Log error, keep current state
- Cost tracking: Accumulates tokens and estimates cost

**Analysis:**
- ✅ Graceful degradation on failures
- ✅ Full observability via debug log
- ✅ Cost awareness for monitoring

---

### 5. Stepper (`src/lib/nlca/stepper.ts`)

#### Parallel Execution

```typescript
async step(prev, width, height, generation, callbacks): Promise<NlcaStepResult>
```

Uses a custom `asyncPool` for controlled concurrency:
- Default: 50 parallel LLM calls
- Progress callbacks for UI updates
- Working grid for streaming partial results

```typescript
async function asyncPool<T, R>(
  concurrency: number,
  items: readonly T[],
  fn: (item: T, idx: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => void
): Promise<R[]>
```

**Analysis:**
- ✅ Configurable concurrency prevents rate limiting
- ✅ Progress reporting enables responsive UI
- ✅ Streaming updates show cells as they complete

#### State Management

After all cells decide:
1. Build new grid from decisions
2. Track changed cells for metrics
3. Return next state + latency/change metrics

**Analysis:**
- ✅ Atomic state transition (all cells decide, then update)
- ✅ Metrics enable performance analysis
- ✅ Change detection for debugging

---

## Logic Approval

### ✅ APPROVED: Square Formation Task

The current implementation is **logically sound** for the square formation task:

1. **Deterministic Rules**: Edge detection is unambiguous
   - Cell (0,5): x=0 → edge → output 1
   - Cell (5,5): not on any edge → interior → output 0
   - Cell (9,9): x=9 AND y=9 → corner (edge) → output 1

2. **Expected Outcome** (10×10 grid):
   ```
   1 1 1 1 1 1 1 1 1 1   (y=0, top edge)
   1 0 0 0 0 0 0 0 0 1
   1 0 0 0 0 0 0 0 0 1
   1 0 0 0 0 0 0 0 0 1
   1 0 0 0 0 0 0 0 0 1
   1 0 0 0 0 0 0 0 0 1
   1 0 0 0 0 0 0 0 0 1
   1 0 0 0 0 0 0 0 0 1
   1 0 0 0 0 0 0 0 0 1
   1 1 1 1 1 1 1 1 1 1   (y=9, bottom edge)
   ```

3. **Border Cells**: 36 cells (4×10 - 4 corners counted once = 36)
4. **Interior Cells**: 64 cells (8×8 interior)

### Potential Improvements (Future)

1. **Multi-step convergence**: Currently cells decide independently. Could add:
   - State persistence across generations
   - Neighbor-aware refinement

2. **Task variety**: The prompt framework supports arbitrary tasks:
   - Digit formation (original)
   - Pattern replication
   - Emergent behavior exploration

3. **Cost optimization**:
   - Batch API calls where supported
   - Skip unchanged cells
   - Use smaller models for simple tasks

---

## Conclusion

The NLCA implementation is well-architected with:
- Clear separation of concerns
- Robust error handling
- Efficient token usage
- Observable execution

The square formation task is logically sound and should produce a perfect hollow square border on the first generation, given that the LLM correctly follows the explicit position-based rules in the prompt.

