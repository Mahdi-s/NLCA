/**
 * NLCA Prompt Configuration Store
 * Manages editable prompt settings for Neural-Linguistic Cellular Automata
 */

import type { PromptConfig } from '$lib/nlca/prompt.js';

// ============================================================================
// PROMPT PRESETS
// ============================================================================

export type PresetCategory = 'basic' | 'complex' | 'patterns' | 'scenes' | 'meta';

export interface PromptPreset {
	id: string;
	name: string;
	category: PresetCategory;
	description: string;
	task: string;
}

/**
 * Library of preset prompts for various shapes and patterns.
 * Each preset provides a complete task description that cells follow.
 */
export const PROMPT_PRESETS: PromptPreset[] = [
	// ─────────────────────────────────────────────────────────────────────────
	// BASIC SHAPES
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'filled-square',
		name: 'Filled Square',
		category: 'basic',
		description: 'Solid square in the center of the grid',
		task: `Form a filled square in the center of the grid.

Rules:
1. If your x coordinate is between 3 and 7 (inclusive) AND your y coordinate is between 3 and 7 (inclusive) → output 1
2. Otherwise → output 0
3. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'hollow-square',
		name: 'Hollow Square',
		category: 'basic',
		description: 'Square border/outline only',
		task: `Form a hollow square (border only) in the center of the grid.

Rules:
1. Calculate if you're on the border of a square from (2,2) to (8,8)
2. If (x == 2 OR x == 8) AND (y >= 2 AND y <= 8) → output 1 (left/right edges)
3. If (y == 2 OR y == 8) AND (x >= 2 AND x <= 8) → output 1 (top/bottom edges)
4. Otherwise → output 0
5. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'filled-circle',
		name: 'Filled Circle',
		category: 'basic',
		description: 'Circle based on distance from center',
		task: `Form a filled circle centered on the grid.

Rules:
1. The center of the grid is at (centerX, centerY) where centerX = floor(gridWidth/2), centerY = floor(gridHeight/2)
2. Calculate your distance from center: distance = sqrt((x - centerX)² + (y - centerY)²)
3. The radius should be about 1/3 of the smaller grid dimension, so radius = floor(min(gridWidth, gridHeight) / 3)
4. If distance <= radius → output 1
5. Otherwise → output 0
6. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'ring',
		name: 'Ring',
		category: 'basic',
		description: 'Hollow circle (donut shape)',
		task: `Form a ring (hollow circle) centered on the grid.

Rules:
1. The center of the grid is at (centerX, centerY) where centerX = floor(gridWidth/2), centerY = floor(gridHeight/2)
2. Calculate your distance from center: distance = sqrt((x - centerX)² + (y - centerY)²)
3. Inner radius = 2, outer radius = 4
4. If distance >= innerRadius AND distance <= outerRadius → output 1
5. Otherwise → output 0
6. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'diamond',
		name: 'Diamond',
		category: 'basic',
		description: 'Rotated square (45 degrees)',
		task: `Form a diamond shape (rotated square) centered on the grid.

Rules:
1. The center of the grid is at (centerX, centerY) where centerX = floor(gridWidth/2), centerY = floor(gridHeight/2)
2. Calculate your Manhattan distance from center: distance = |x - centerX| + |y - centerY|
3. The diamond radius should be about 1/3 of the smaller grid dimension
4. If distance <= radius (e.g., 3 or 4) → output 1
5. Otherwise → output 0
6. Your previous state does not matter - only your position determines your state`
	},

	// ─────────────────────────────────────────────────────────────────────────
	// COMPLEX SHAPES
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'cross',
		name: 'Cross (+)',
		category: 'complex',
		description: 'Plus sign through the center',
		task: `Form a cross (plus sign) centered on the grid.

Rules:
1. The center of the grid is at (centerX, centerY) where centerX = floor(gridWidth/2), centerY = floor(gridHeight/2)
2. The cross arms should be 1-2 cells thick
3. If x == centerX AND y is between 1 and gridHeight-2 → output 1 (vertical arm)
4. If y == centerY AND x is between 1 and gridWidth-2 → output 1 (horizontal arm)
5. Otherwise → output 0
6. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'x-shape',
		name: 'X Shape',
		category: 'complex',
		description: 'Diagonal cross through the center',
		task: `Form an X shape (diagonal cross) centered on the grid.

Rules:
1. The center of the grid is at (centerX, centerY) where centerX = floor(gridWidth/2), centerY = floor(gridHeight/2)
2. You are on a diagonal if your offset from center satisfies: |x - centerX| == |y - centerY|
3. If |x - centerX| == |y - centerY| AND your position is within the grid bounds → output 1
4. Otherwise → output 0
5. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'triangle',
		name: 'Triangle',
		category: 'complex',
		description: 'Upward-pointing triangle',
		task: `Form an upward-pointing filled triangle.

Rules:
1. The triangle apex (top point) is at the center-top: (centerX, 1) where centerX = floor(gridWidth/2)
2. The base spans the lower portion of the grid
3. For each row y, the triangle widens: cells within |x - centerX| <= (y - 1) should be alive
4. If y >= 1 AND y <= gridHeight - 2 AND |x - centerX| <= (y - 1) → output 1
5. Otherwise → output 0
6. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'heart',
		name: 'Heart',
		category: 'complex',
		description: 'Heart shape (challenging)',
		task: `Form a heart shape centered on the grid.

Rules:
1. The center of the grid is at (centerX, centerY) where centerX = floor(gridWidth/2), centerY = floor(gridHeight/2)
2. A heart can be approximated: the top half has two bumps, the bottom comes to a point
3. For the top half (y < centerY): two circles centered at (centerX - 2, centerY - 1) and (centerX + 2, centerY - 1) with radius ~2
4. For the bottom half (y >= centerY): a triangular region pointing down
5. Use these conditions combined: if in either top circle OR in the bottom triangle region → output 1
6. This is approximate - do your best to form a recognizable heart shape
7. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'star',
		name: 'Star',
		category: 'complex',
		description: 'Five-pointed star shape',
		task: `Form a five-pointed star centered on the grid.

Rules:
1. The center of the grid is at (centerX, centerY) where centerX = floor(gridWidth/2), centerY = floor(gridHeight/2)
2. A star has 5 points radiating outward and 5 inner valleys
3. One approach: combine a small inner pentagon with 5 triangular points
4. Points should be at angles 90°, 162°, 234°, 306°, 18° from center (every 72°, starting at top)
5. If your position falls within a triangular region pointing to one of these angles → output 1
6. This is geometric - approximate as best you can based on your coordinates
7. Your previous state does not matter - only your position determines your state`
	},

	// ─────────────────────────────────────────────────────────────────────────
	// PATTERNS
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'checkerboard',
		name: 'Checkerboard',
		category: 'patterns',
		description: 'Alternating cells like a chess board',
		task: `Form a checkerboard pattern across the entire grid.

Rules:
1. Checkerboard means alternating cells: (x + y) determines the color
2. If (x + y) is even → output 1
3. If (x + y) is odd → output 0
4. This creates a classic checkerboard/chess board pattern
5. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'vertical-stripes',
		name: 'Vertical Stripes',
		category: 'patterns',
		description: 'Vertical lines across the grid',
		task: `Form vertical stripes across the grid.

Rules:
1. Stripes should be 2 cells wide, alternating on/off
2. If floor(x / 2) is even → output 1
3. If floor(x / 2) is odd → output 0
4. This creates alternating vertical bands
5. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'horizontal-stripes',
		name: 'Horizontal Stripes',
		category: 'patterns',
		description: 'Horizontal lines across the grid',
		task: `Form horizontal stripes across the grid.

Rules:
1. Stripes should be 2 cells wide, alternating on/off
2. If floor(y / 2) is even → output 1
3. If floor(y / 2) is odd → output 0
4. This creates alternating horizontal bands
5. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'diagonal-stripes',
		name: 'Diagonal Stripes',
		category: 'patterns',
		description: 'Diagonal lines across the grid',
		task: `Form diagonal stripes across the grid (from top-left to bottom-right).

Rules:
1. Diagonal stripes follow lines where (x + y) is constant
2. If floor((x + y) / 2) is even → output 1
3. If floor((x + y) / 2) is odd → output 0
4. This creates diagonal bands running from top-left to bottom-right
5. Your previous state does not matter - only your position determines your state`
	},
	{
		id: 'gradient',
		name: 'Gradient',
		category: 'patterns',
		description: 'Density increases left to right',
		task: `Form a horizontal gradient: sparse on left, dense on right.

Rules:
1. Your probability of being alive increases with your x coordinate
2. Calculate probability: p = x / gridWidth
3. Use a deterministic rule based on position: if (x * 7 + y * 13) mod gridWidth < x → output 1
4. Otherwise → output 0
5. This creates a pattern that is sparse on the left and dense on the right
6. Your previous state does not matter - only your position determines your state`
	},

	// ─────────────────────────────────────────────────────────────────────────
	// SCENES (COLOR OUTPUT)
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'scene-landscape-tree',
		name: 'Landscape: Tree + Mountains',
		category: 'scenes',
		description: 'A simple landscape: sky gradient, mountains, ground, and a tree',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Goal: Draw a landscape with mountains and a tree.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene (leave as empty background), output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#1A2B3C".

Scene composition (use your x,y and grid size):
- Sky: for y in the top ~45% of the grid, create a vertical gradient (lighter near top, slightly darker near horizon).
- Mountains: add 2–3 triangular silhouettes near the horizon (around y ~40–60%).
  - Give mountains a darker base color and add a lighter ridge line on one edge.
- Ground: for y below the horizon, use a dark green/brown.
- Tree: place a tree near the left-third or right-third of the grid:
  - Trunk: a vertical brown column 1–2 cells wide.
  - Canopy: a round-ish green blob above the trunk with a few lighter highlight pixels.

Hint: Use simple geometry (distance, slopes, and thresholds). Keep it recognizable, not perfect.`
	},
	{
		id: 'scene-sunset-hills',
		name: 'Scene: Sunset Hills',
		category: 'scenes',
		description: 'Sunset gradient with layered rolling hills',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#FF8800".

Scene:
- Sky gradient: top = deep blue/purple, horizon = warm orange/pink.
- Sun: a small bright circle near the horizon.
- Hills: 2–3 rolling hill layers (sin-like or parabolic curves) with darker colors for nearer hills.

Keep it simple and coherent.`
	},
	{
		id: 'scene-ocean-moon',
		name: 'Scene: Ocean + Moon',
		category: 'scenes',
		description: 'Night sky with moon and ocean reflection',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#C0D8FF".

Scene:
- Night sky: dark blue gradient at top.
- Moon: a bright circle in the upper half.
- Ocean: darker band in the bottom half.
- Reflection: a vertical shimmering stripe below the moon (alternating bright/dim pixels).
`
	},
	{
		id: 'color-territory-six-sectors',
		name: 'Color Game: Six-Sector Territories',
		category: 'scenes',
		description: 'Local majority rule; color shows dominant direction',
		task: `You are playing a local-rule color game. Your job is to decide your next state (0/1) and choose a color that visualizes what you locally see.

Color mode rules (IMPORTANT):
1. Always output exactly one JSON object: {"state":0,"color":"#RRGGBB"} or {"state":1,"color":"#RRGGBB"}.
2. Use ONLY uppercase hex colors like "#A1B2C3".
3. Be deterministic: the same inputs must produce the same output.

Neighborhood notes:
- Use the provided "neighborhood" array of [dx, dy, state]. Do NOT assume a fixed neighborhood size or shape.

Game rule (state):
1. Let N = neighborhood.length (can vary by neighborhood type).
2. Let alive = number of neighbors with state=1 (you may use the provided "neighbors" count).
3. Majority rule: if alive > floor(N/2) then state=1 else state=0.

Visualization rule (color):
1. Partition alive neighbors into 6 buckets based on (dx,dy):
   - NORTH: dy<0
   - SOUTH: dy>0
   - WEST: dx<0
   - EAST: dx>0
   - DIAG_PLUS: dx and dy have the same sign (dx*dy>0)
   - DIAG_MINUS: dx and dy have opposite signs (dx*dy<0)
2. Find the bucket with the highest alive count (ties broken deterministically by (x + 3*y + generation) mod numberOfTiedBuckets).
3. Choose the bucket color:
   - NORTH "#5BC0EB", SOUTH "#FDE74C", WEST "#9BC53D", EAST "#C3423F", DIAG_PLUS "#6D597A", DIAG_MINUS "#3D5A80"
4. If you output state=0, darken the chosen bucket color by using a darker variant:
   - NORTH "#12313B", SOUTH "#3B350F", WEST "#1D2B12", EAST "#3B1412", DIAG_PLUS "#201A24", DIAG_MINUS "#131D2A"`
	},
	{
		id: 'color-phase-waves-rps',
		name: 'Color Game: Phase-Wave Bands',
		category: 'scenes',
		description: '3-phase rule; color shows local phase and density',
		task: `You are generating moving “phase bands” using only local neighbor information. The state is binary, but the color shows the phase.

Color mode rules (IMPORTANT):
1. Always output exactly one JSON object: {"state":0,"color":"#RRGGBB"} or {"state":1,"color":"#RRGGBB"}.
2. Use ONLY uppercase hex colors like "#A1B2C3".
3. Be deterministic.

Definitions:
- N = neighborhood.length
- alive = count of neighbors with state=1
- frac = alive / max(1, N)
- phase = (generation + x + 2*y) mod 3  (0,1,2)

Game rule (state):
1. Each phase has a target neighbor density and tolerance:
   - phase 0: target 0.30, tolerance 0.10
   - phase 1: target 0.45, tolerance 0.10
   - phase 2: target 0.60, tolerance 0.10
2. If |frac - target| <= tolerance then state=1 else state=0.

Visualization rule (color):
1. Base phase colors:
   - phase 0: "#2D6CDF" (blue)
   - phase 1: "#B5179E" (magenta)
   - phase 2: "#F77F00" (orange)
2. If state=0, use a dark background-tinted version of that phase:
   - phase 0: "#0E1E3A"
   - phase 1: "#2A0A24"
   - phase 2: "#2E1400"
3. Optional highlight: if frac is within half the tolerance of target, slightly brighten (choose a fixed brighter hex per phase):
   - phase 0 highlight "#6FA8FF"
   - phase 1 highlight "#FF5ACD"
   - phase 2 highlight "#FFB000"`
	},
	{
		id: 'color-edge-vs-center',
		name: 'Color Game: Edge-Seekers vs Center-Seekers',
		category: 'scenes',
		description: 'Two behaviors by position; boundaries become vivid',
		task: `You have two roles based on where you live: edge cells prefer sparse neighborhoods, center cells prefer dense neighborhoods. Use ONLY local info plus your own position.

Color mode rules (IMPORTANT):
1. Always output exactly one JSON object: {"state":0,"color":"#RRGGBB"} or {"state":1,"color":"#RRGGBB"}.
2. Use ONLY uppercase hex colors.
3. Be deterministic.

Role:
- distToEdge = min(x, y, (gridWidth-1 - x), (gridHeight-1 - y))
- If distToEdge <= 1 you are an EDGE_SEEKER, otherwise a CENTER_SEEKER.

Game rule (state):
- N = neighborhood.length, alive = neighbor alive count, frac = alive / max(1,N)
- EDGE_SEEKER: state=1 if frac <= 0.20 else state=0
- CENTER_SEEKER: state=1 if frac >= 0.45 else state=0

Visualization rule (color):
- EDGE_SEEKER: state=1 "#00D9C0", state=0 "#08201D"
- CENTER_SEEKER: state=1 "#7AE582", state=0 "#0E2210"

Keep it crisp: your role is purely positional; do not invent hidden memory beyond your current state input.`
	},
	{
		id: 'color-stubborn-anchors-consensus',
		name: 'Color Game: Stubborn Anchors',
		category: 'scenes',
		description: 'Corner anchors + consensus hysteresis; large-scale fronts',
		task: `This is an opinion-dynamics game with “stubborn anchors” at the corners. Anchors never change; everyone else uses local consensus with hysteresis.

Color mode rules (IMPORTANT):
1. Always output exactly one JSON object: {"state":0,"color":"#RRGGBB"} or {"state":1,"color":"#RRGGBB"}.
2. Use ONLY uppercase hex colors.
3. Be deterministic.

Anchors (always state=1):
- Top-left (0,0), top-right (gridWidth-1,0), bottom-left (0,gridHeight-1), bottom-right (gridWidth-1,gridHeight-1).

Game rule (state):
1. If you are an anchor cell, output state=1.
2. Otherwise compute N, alive, frac = alive/max(1,N).
3. Use hysteresis with your current "state":
   - If state==1, stay alive if frac >= 0.35, else become 0.
   - If state==0, become alive if frac >= 0.55, else stay 0.

Visualization rule (color):
1. Color shows which corner you are closest to (by Manhattan distance):
   - closest top-left: "#3A86FF"
   - closest top-right: "#FF006E"
   - closest bottom-left: "#06D6A0"
   - closest bottom-right: "#FFBE0B"
2. If you output state=0, use a dark version of the same corner color:
   - "#10244A", "#3A0019", "#06261D", "#3A2A00"`
	},
	{
		id: 'color-parity-interference',
		name: 'Color Game: Parity Interference',
		category: 'scenes',
		description: 'Odd/even neighbor parity causes flicker and lattices',
		task: `You will create parity-based interference patterns. Your next state depends on whether the alive neighbor count is odd or even.

Color mode rules (IMPORTANT):
1. Always output exactly one JSON object: {"state":0,"color":"#RRGGBB"} or {"state":1,"color":"#RRGGBB"}.
2. Use ONLY uppercase hex colors.
3. Be deterministic.

Game rule (state):
1. Let alive = neighbor alive count (use "neighbors" or count neighborhood states).
2. Let parity = alive mod 2 (0=even, 1=odd).
3. Next state = state XOR parity.

Visualization rule (color):
- If parity is even:
  - state=1 "#4CC9F0"
  - state=0 "#0B1E26"
- If parity is odd:
  - state=1 "#F9C74F"
  - state=0 "#2A1F08"

This rule should work for any neighborhood definition because it relies only on the provided alive count.`
	},
	{
		id: 'color-heat-threshold',
		name: 'Color Game: Heat Threshold',
		category: 'scenes',
		description: 'Binary reaction-to-density; color shows “temperature”',
		task: `Treat your neighborhood density as “heat”. You turn on in the hot regime, turn off in the cold regime, and keep your current state in between.

Color mode rules (IMPORTANT):
1. Always output exactly one JSON object: {"state":0,"color":"#RRGGBB"} or {"state":1,"color":"#RRGGBB"}.
2. Use ONLY uppercase hex colors.
3. Be deterministic.

Game rule (state):
1. N = neighborhood.length, alive = neighbor alive count, frac = alive / max(1,N).
2. If frac >= 0.60 => state=1 (hot)
3. Else if frac <= 0.30 => state=0 (cold)
4. Else keep your current input state.

Visualization rule (color):
1. Map frac into 4 bands and choose a color:
   - frac < 0.25 => "#1D3557" (cold navy)
   - 0.25..0.45 => "#457B9D" (cool blue)
   - 0.45..0.60 => "#F4A261" (warm)
   - > 0.60 => "#E63946" (hot red)
2. If state=0, darken by using a darker fixed palette:
   - "#0B1422", "#152634", "#3A2416", "#3A0F12"`
	},
	{
		id: 'color-hysteresis-memory',
		name: 'Color Game: Hysteresis Memory',
		category: 'scenes',
		description: 'Different on/off thresholds; color highlights switching',
		task: `Use your current state as one-bit memory. Turning on requires stronger neighbor support than staying on. This creates sticky domains and sharp boundaries.

Color mode rules (IMPORTANT):
1. Always output exactly one JSON object: {"state":0,"color":"#RRGGBB"} or {"state":1,"color":"#RRGGBB"}.
2. Use ONLY uppercase hex colors.
3. Be deterministic.

Game rule (state):
1. N = neighborhood.length, alive = neighbor alive count, frac = alive / max(1,N).
2. If your current state==1:
   - stay on if frac >= 0.25, else turn off.
3. If your current state==0:
   - turn on if frac >= 0.55, else stay off.

Visualization rule (color):
- If your next state equals your current state (stable):
  - state=1 "#2A9D8F"
  - state=0 "#0E1F1C"
- If your next state differs from your current state (switching):
  - next state=1 (turning on) "#E9C46A"
  - next state=0 (turning off) "#E76F51"`
	},
	{
		id: 'color-local-symmetry-police',
		name: 'Color Game: Local Symmetry Police',
		category: 'scenes',
		description: 'Turns on when its neighborhood is locally symmetric',
		task: `You enforce LOCAL symmetry in the pattern. You can only see your neighborhood samples, so judge symmetry within that set (not global symmetry of the whole grid).

Color mode rules (IMPORTANT):
1. Always output exactly one JSON object: {"state":0,"color":"#RRGGBB"} or {"state":1,"color":"#RRGGBB"}.
2. Use ONLY uppercase hex colors.
3. Be deterministic.

Game rule (state):
1. Consider mirror symmetry across the vertical axis through you: (dx,dy) mirrors to (-dx,dy).
2. For each neighbor sample that has a mirrored counterpart present, check if their states match.
3. Let pairs = number of mirrored pairs you can compare, matches = number of those pairs with equal state.
4. If pairs == 0, set symmetryScore = 1.0 (trivially symmetric), else symmetryScore = matches / pairs.
5. If symmetryScore >= 0.70 then state=1 else state=0.

Visualization rule (color):
- If symmetryScore >= 0.90: "#8EECF5" (very symmetric)
- Else if symmetryScore >= 0.70: "#B8F2E6" (somewhat symmetric)
- Else: "#F28482" (asymmetric)
- If state=0, use a dark background instead: "#0C1517"`
	},
	{
		id: 'color-signal-couriers',
		name: 'Color Game: Signal Couriers',
		category: 'scenes',
		description: 'Sparse “signal” propagation; color shows flow direction',
		task: `Create sparse traveling signals. The rule favors thin filaments: single-neighbor activation propagates, but crowds extinguish. Color shows the local flow direction implied by alive neighbors.

Color mode rules (IMPORTANT):
1. Always output exactly one JSON object: {"state":0,"color":"#RRGGBB"} or {"state":1,"color":"#RRGGBB"}.
2. Use ONLY uppercase hex colors.
3. Be deterministic.

Game rule (state):
1. Let alive = neighbor alive count.
2. If alive == 1 => state=1 (propagate a lone signal).
3. Else if alive >= 3 => state=0 (overcrowding extinguishes).
4. Else keep your current input state.

Visualization rule (color):
1. Compute a crude flow vector from alive neighbors:
   - vx = sum(dx * state) over neighbor samples
   - vy = sum(dy * state) over neighbor samples
2. If state=0, use background "#070A12".
3. If state=1, choose a direction color by the signs of (vx,vy):
   - vx>=0 and vy<0 => "#00BBF9" (NE-ish)
   - vx<0 and vy<0 => "#00F5D4" (NW-ish)
   - vx>=0 and vy>=0 => "#F15BB5" (SE-ish)
   - vx<0 and vy>=0 => "#FEE440" (SW-ish)
If vx==0 and vy==0, use "#FFFFFF".`
	},
	{
		id: 'color-coalition-parity',
		name: 'Color Game: Coalition Parity',
		category: 'scenes',
		description: 'Two factions by coordinate parity; local coalitions decide life',
		task: `There are two factions: EVEN cells and ODD cells, determined by (x+y) parity. You turn on only when your faction has local support. This showcases how neighborhood geometry changes coalition outcomes.

Color mode rules (IMPORTANT):
1. Always output exactly one JSON object: {"state":0,"color":"#RRGGBB"} or {"state":1,"color":"#RRGGBB"}.
2. Use ONLY uppercase hex colors.
3. Be deterministic.

Definitions:
- myFaction = (x + y) mod 2  (0=EVEN, 1=ODD)
- For each neighbor sample [dx,dy,s], the neighbor's parity is (x+dx + y+dy) mod 2.

Game rule (state):
1. Count aliveSame = number of alive neighbors whose parity matches myFaction.
2. Count aliveOther = number of alive neighbors whose parity differs from myFaction.
3. If aliveSame >= aliveOther + 1 => state=1 else state=0.

Visualization rule (color):
- EVEN faction: state=1 "#3A0CA3", state=0 "#12052F"
- ODD faction: state=1 "#F72585", state=0 "#2A0416"
- If aliveSame >= aliveOther + 3 (strong majority), brighten:
  - EVEN "#7209B7"
  - ODD "#FF4DA6"`
	},

	// ─────────────────────────────────────────────────────────────────────────
	// META
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'custom',
		name: 'Custom',
		category: 'meta',
		description: 'Start with a blank slate',
		task: `Describe your custom task here.

Rules:
1. Define clear conditions for when a cell should output 1 (alive)
2. Define when a cell should output 0 (dead)
3. Use your position (x, y) and the grid dimensions to make decisions
4. Your previous state does not matter unless you want temporal behavior`
	}
];

/**
 * Get presets by category
 */
export function getPresetsByCategory(category: PresetCategory): PromptPreset[] {
	return PROMPT_PRESETS.filter(p => p.category === category);
}

/**
 * Get a preset by ID
 */
export function getPresetById(id: string): PromptPreset | undefined {
	return PROMPT_PRESETS.find(p => p.id === id);
}

// ============================================================================
// DEFAULT VALUES
// ============================================================================

// Default task description (matches 'filled-square' preset)
const DEFAULT_TASK = `Form a filled square in the center of the grid.

Rules:
1. If your x coordinate is between 3 and 7 (inclusive) AND your y coordinate is between 3 and 7 (inclusive) → output 1
2. Otherwise → output 0
3. Your previous state does not matter - only your position determines your state`;

// Default advanced template with placeholders - provides full CA context
const DEFAULT_TEMPLATE = `You are an autonomous cell agent in a cellular automaton simulation.

== YOUR IDENTITY ==
Position: ({{CELL_X}}, {{CELL_Y}}) on a {{GRID_WIDTH}}×{{GRID_HEIGHT}} grid
Coordinate system: x increases rightward (0 to {{MAX_X}}), y increases downward (0 to {{MAX_Y}})

== CELLULAR AUTOMATA CONTEXT ==
You are one of {{GRID_WIDTH}}×{{GRID_HEIGHT}} cells operating in parallel.
Each generation, every cell simultaneously decides its next state based on:
- Its position on the grid
- Its current state (0=dead/off, 1=alive/on)
- The states of neighboring cells

This is a synchronous update: all cells read the current state, then all cells update at once.

== YOUR TASK ==
{{TASK}}

== INPUT FORMAT (provided each generation) ==
You will receive a JSON object with:
- "generation": Current time step (0, 1, 2, ...)
- "state": Your current state (0 or 1)
- "neighbors": Count of alive neighbors (0-8 for Moore neighborhood)
- "neighborhood": Array of [dx, dy, state] for each neighbor
  - dx, dy: relative offset from your position (e.g., [-1, -1] is top-left)
  - state: that neighbor's current state (0 or 1)

== OUTPUT FORMAT ==
{{OUTPUT_CONTRACT}}`;

// Placeholders that will be replaced by the system
export const SYSTEM_PLACEHOLDERS = [
	{ key: '{{CELL_X}}', description: 'Cell X coordinate', editable: false },
	{ key: '{{CELL_Y}}', description: 'Cell Y coordinate', editable: false },
	{ key: '{{GRID_WIDTH}}', description: 'Grid width', editable: false },
	{ key: '{{GRID_HEIGHT}}', description: 'Grid height', editable: false },
	{ key: '{{MAX_X}}', description: 'Maximum X (width - 1)', editable: false },
	{ key: '{{MAX_Y}}', description: 'Maximum Y (height - 1)', editable: false },
	{ key: '{{OUTPUT_CONTRACT}}', description: 'Output contract (auto-generated)', editable: false },
] as const;

// Placeholders that are user-editable
export const USER_PLACEHOLDERS = [
	{ key: '{{TASK}}', description: 'Your task description', editable: true },
] as const;

export interface NlcaPromptConfig {
	/** Simple mode: task description only */
	taskDescription: string;
	/** Whether to use advanced template mode */
	useAdvancedMode: boolean;
	/** Full template with placeholders (advanced mode) */
	advancedTemplate: string;
	/** Request the model to output a deterministic hex color for this cell */
	cellColorHexEnabled: boolean;
	/** Currently selected preset ID (null = custom/modified) */
	selectedPresetId: string | null;
}

// Reactive state
let taskDescription = $state(DEFAULT_TASK);
let useAdvancedMode = $state(false);
let advancedTemplate = $state(DEFAULT_TEMPLATE);
let cellColorHexEnabled = $state(false);
let selectedPresetId = $state<string | null>('filled-square'); // Default to filled-square preset

// LocalStorage persistence key
const STORAGE_KEY = 'nlca-prompt-config';

/**
 * Load saved prompt config from localStorage
 */
function loadFromStorage(): void {
	if (typeof window === 'undefined') return;
	
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			const config = JSON.parse(saved) as Partial<NlcaPromptConfig>;
			if (config.taskDescription) taskDescription = config.taskDescription;
			if (config.useAdvancedMode !== undefined) useAdvancedMode = config.useAdvancedMode;
			if (config.advancedTemplate) advancedTemplate = config.advancedTemplate;
			if (config.cellColorHexEnabled !== undefined) cellColorHexEnabled = config.cellColorHexEnabled;
			if (config.selectedPresetId !== undefined) selectedPresetId = config.selectedPresetId;
		}
	} catch (e) {
		console.warn('[NLCA Prompt] Failed to load saved config:', e);
	}
}

/**
 * Save current prompt config to localStorage
 */
function saveToStorage(): void {
	if (typeof window === 'undefined') return;
	
	try {
		const config: NlcaPromptConfig = {
			taskDescription,
			useAdvancedMode,
			advancedTemplate,
			cellColorHexEnabled,
			selectedPresetId
		};
		localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
	} catch (e) {
		console.warn('[NLCA Prompt] Failed to save config:', e);
	}
}

// Initialize from storage on first access
let initialized = false;
function ensureInitialized() {
	if (!initialized) {
		initialized = true;
		loadFromStorage();
	}
}

/**
 * Get the NLCA prompt state (reactive)
 */
export function getNlcaPromptState() {
	ensureInitialized();
	
	return {
		// Getters
		get taskDescription() { return taskDescription; },
		get useAdvancedMode() { return useAdvancedMode; },
		get advancedTemplate() { return advancedTemplate; },
		get cellColorHexEnabled() { return cellColorHexEnabled; },
		get selectedPresetId() { return selectedPresetId; },
		get defaultTask() { return DEFAULT_TASK; },
		get defaultTemplate() { return DEFAULT_TEMPLATE; },
		
		/**
		 * Check if the current task has been modified from the selected preset
		 */
		get isModifiedFromPreset(): boolean {
			if (!selectedPresetId) return false;
			const preset = getPresetById(selectedPresetId);
			if (!preset) return false;
			return taskDescription !== preset.task;
		},
		
		/**
		 * Get the currently selected preset object
		 */
		get currentPreset(): PromptPreset | undefined {
			return selectedPresetId ? getPresetById(selectedPresetId) : undefined;
		},
		
		// Setters
		set taskDescription(value: string) {
			taskDescription = value;
			saveToStorage();
		},
		set useAdvancedMode(value: boolean) {
			useAdvancedMode = value;
			saveToStorage();
		},
		set advancedTemplate(value: string) {
			advancedTemplate = value;
			saveToStorage();
		},
		set cellColorHexEnabled(value: boolean) {
			cellColorHexEnabled = value;
			saveToStorage();
		},
		set selectedPresetId(value: string | null) {
			selectedPresetId = value;
			saveToStorage();
		},
		
		// Actions
		toPromptConfig(): PromptConfig {
			return {
				taskDescription,
				useAdvancedMode,
				advancedTemplate,
				cellColorHexEnabled
			};
		},
		
		/**
		 * Select a preset and populate the task description with its content
		 */
		selectPreset(presetId: string) {
			const preset = getPresetById(presetId);
			if (preset) {
				selectedPresetId = presetId;
				taskDescription = preset.task;
				saveToStorage();
			}
		},
		
		/**
		 * Reset to the currently selected preset's original task
		 */
		resetToPreset() {
			if (selectedPresetId) {
				const preset = getPresetById(selectedPresetId);
				if (preset) {
					taskDescription = preset.task;
					saveToStorage();
				}
			}
		},
		
		resetToDefaults() {
			selectedPresetId = 'filled-square';
			taskDescription = DEFAULT_TASK;
			useAdvancedMode = false;
			advancedTemplate = DEFAULT_TEMPLATE;
			cellColorHexEnabled = false;
			saveToStorage();
		},
		
		resetTaskOnly() {
			// Reset to current preset's task if one is selected, otherwise default
			if (selectedPresetId) {
				const preset = getPresetById(selectedPresetId);
				if (preset) {
					taskDescription = preset.task;
					saveToStorage();
					return;
				}
			}
			taskDescription = DEFAULT_TASK;
			saveToStorage();
		},
		
		resetTemplateOnly() {
			advancedTemplate = DEFAULT_TEMPLATE;
			saveToStorage();
		},
		
		/**
		 * Build the final system prompt by replacing placeholders
		 */
		buildSystemPrompt(cellX: number, cellY: number, gridWidth: number, gridHeight: number): string {
			const template = useAdvancedMode ? advancedTemplate : DEFAULT_TEMPLATE;
			const task = taskDescription;
			
			return template
				.replace(/\{\{CELL_X\}\}/g, String(cellX))
				.replace(/\{\{CELL_Y\}\}/g, String(cellY))
				.replace(/\{\{GRID_WIDTH\}\}/g, String(gridWidth))
				.replace(/\{\{GRID_HEIGHT\}\}/g, String(gridHeight))
				.replace(/\{\{MAX_X\}\}/g, String(gridWidth - 1))
				.replace(/\{\{MAX_Y\}\}/g, String(gridHeight - 1))
				.replace(/\{\{TASK\}\}/g, task);
		},
		
		/**
		 * Get a preview of the prompt with sample values
		 */
		getPreview(sampleX = 5, sampleY = 5, width = 10, height = 10): string {
			return this.buildSystemPrompt(sampleX, sampleY, width, height);
		}
	};
}

// Export default values for reference
export { DEFAULT_TASK, DEFAULT_TEMPLATE };

