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
		task: `Together with your neighbors, form a solid filled square in the middle of the grid.

Shared goal:
- A single coherent square block centered on the grid, roughly 40% of the grid's width/height on each side.

Your decision:
- Let centerX = gridWidth / 2 and centerY = gridHeight / 2.
- Let halfSide = max(2, floor(min(gridWidth, gridHeight) * 0.20)).
- If |x - centerX| <= halfSide AND |y - centerY| <= halfSide → join the square (state=1).
- Otherwise → stay outside (state=0).
- If you are right at the edge and unsure, use your neighborhood: if most of your neighbors on the "inside" side are alive, close the edge; if most are dead, stay out.`
	},
	{
		id: 'hollow-square',
		name: 'Hollow Square',
		category: 'basic',
		description: 'Square border/outline only',
		task: `Together with your neighbors, draw the border of a square centered on the grid — only the outline, no fill.

Shared goal:
- A single square ring one cell thick, centered on the grid.

Your decision:
- Let centerX = gridWidth / 2, centerY = gridHeight / 2.
- Let halfSide = max(2, floor(min(gridWidth, gridHeight) * 0.25)).
- You are on the border if max(|x - centerX|, |y - centerY|) == halfSide.
- If you are on the border → state=1. Otherwise → state=0.
- Near the corners, coordinate with your diagonal neighbors so the ring closes cleanly (no gaps and no double-thick bulges).`
	},
	{
		id: 'filled-circle',
		name: 'Filled Circle',
		category: 'basic',
		description: 'Circle based on distance from center',
		task: `Cooperate with your neighbors to form a single filled disc centered on the grid.

Shared goal:
- One round, solid circle of cells at the middle of the grid.

Your decision:
- Let centerX = gridWidth / 2, centerY = gridHeight / 2.
- Let radius = max(2, floor(min(gridWidth, gridHeight) / 3)).
- Compute d = sqrt((x - centerX)² + (y - centerY)²).
- If d <= radius → state=1 (join the disc). Otherwise → state=0.
- If d is right around the radius, look at your neighbors: match whatever the closest 2–3 neighbors on the radial boundary are doing so the edge is smooth.`
	},
	{
		id: 'ring',
		name: 'Ring',
		category: 'basic',
		description: 'Hollow circle (donut shape)',
		task: `Cooperate with your neighbors to form a single hollow ring (donut) centered on the grid.

Shared goal:
- A circular band of alive cells with a clear hole in the middle and clear empty space outside.

Your decision:
- Let centerX = gridWidth / 2, centerY = gridHeight / 2.
- Let outer = max(3, floor(min(gridWidth, gridHeight) * 0.40)).
- Let inner = max(1, outer - 2).
- Compute d = sqrt((x - centerX)² + (y - centerY)²).
- If inner <= d <= outer → state=1 (part of the ring). Otherwise → state=0.
- When ambiguous, keep the band consistent with your neighbors' states along the ring rather than leaving isolated gaps.`
	},
	{
		id: 'diamond',
		name: 'Diamond',
		category: 'basic',
		description: 'Rotated square (45 degrees)',
		task: `Cooperate with your neighbors to form a single filled diamond (rotated square) centered on the grid.

Shared goal:
- One clean diamond silhouette at the middle — pointed at top, bottom, left, right.

Your decision:
- Let centerX = gridWidth / 2, centerY = gridHeight / 2.
- Let radius = max(3, floor(min(gridWidth, gridHeight) / 3)).
- Compute Manhattan distance m = |x - centerX| + |y - centerY|.
- If m <= radius → state=1 (join the diamond). Otherwise → state=0.
- Tie-breaking on the boundary: agree with your diagonal neighbors so the four edges stay straight rather than jagged.`
	},

	// ─────────────────────────────────────────────────────────────────────────
	// COMPLEX SHAPES
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'cross',
		name: 'Cross (+)',
		category: 'complex',
		description: 'Plus sign through the center',
		task: `Cooperate with your neighbors to form a plus-sign (+) centered on the grid.

Shared goal:
- Two straight arms, one vertical and one horizontal, crossing at the center.

Your decision:
- Let centerX = gridWidth / 2, centerY = gridHeight / 2.
- Let armHalfThickness = 0 (arms are one cell thick). Let margin = max(1, floor(min(gridWidth, gridHeight) * 0.1)).
- Vertical arm: x == centerX AND margin <= y <= gridHeight - 1 - margin.
- Horizontal arm: y == centerY AND margin <= x <= gridWidth - 1 - margin.
- If you match either arm → state=1. Otherwise → state=0.
- Keep the arms consistent with your in-line neighbors so they render as continuous lines, not dotted.`
	},
	{
		id: 'x-shape',
		name: 'X Shape',
		category: 'complex',
		description: 'Diagonal cross through the center',
		task: `Cooperate with your neighbors to form an X (two diagonals crossing at the center).

Shared goal:
- Two diagonal lines from corner to corner, meeting at the middle.

Your decision:
- Let centerX = gridWidth / 2, centerY = gridHeight / 2.
- You sit on a diagonal if |x - centerX| == |y - centerY|.
- Stay within a margin of max(1, floor(min(gridWidth, gridHeight) * 0.1)) from each edge so the X doesn't touch the grid boundary.
- If both conditions hold → state=1. Otherwise → state=0.
- Along each diagonal, agree with your diagonal neighbors so the line stays unbroken.`
	},
	{
		id: 'triangle',
		name: 'Triangle',
		category: 'complex',
		description: 'Upward-pointing triangle',
		task: `Cooperate with your neighbors to form a single upward-pointing filled triangle.

Shared goal:
- Apex at the top-center, base along the bottom rows.

Your decision:
- Let centerX = gridWidth / 2.
- Let apexY = max(1, floor(gridHeight * 0.15)).
- Let baseY = gridHeight - 1 - max(1, floor(gridHeight * 0.15)).
- If apexY <= y <= baseY AND |x - centerX| <= (y - apexY) → state=1. Otherwise → state=0.
- At the slanted edges, look at your neighbors along the same edge and match them so the triangle's sides stay straight.`
	},
	{
		id: 'heart',
		name: 'Heart',
		category: 'complex',
		description: 'Heart shape (challenging)',
		task: `Cooperate with your neighbors to form a single heart shape at the center of the grid.

Shared goal:
- Two rounded bumps on top forming the lobes, a V-shaped point at the bottom.

Your decision:
- Let centerX = gridWidth / 2, centerY = gridHeight / 2.
- Let lobeRadius = max(2, floor(min(gridWidth, gridHeight) * 0.18)).
- Let lobeOffset = lobeRadius. The two lobe centers sit at (centerX - lobeOffset, centerY - 1) and (centerX + lobeOffset, centerY - 1).
- Top half (y <= centerY): you are alive if your distance to either lobe center is <= lobeRadius.
- Bottom half (y > centerY): you are alive if |x - centerX| <= max(0, (gridHeight - 1 - y) * 1.2) AND y <= gridHeight - 2 (the point tapers as y grows).
- Otherwise → state=0.
- Along the cleft between the two lobes at centerX, coordinate with your neighbors so the notch is visible (don't fill it in).`
	},
	{
		id: 'star',
		name: 'Star',
		category: 'complex',
		description: 'Five-pointed star shape',
		task: `Cooperate with your neighbors to form a single five-pointed star at the center of the grid.

Shared goal:
- Five sharp points radiating outward, five shorter valleys between them, with a solid body in the middle.

Your decision:
- Let centerX = gridWidth / 2, centerY = gridHeight / 2.
- Let rOuter = max(3, floor(min(gridWidth, gridHeight) * 0.40)).
- Let rInner = max(2, floor(rOuter * 0.5)).
- Compute your distance d = sqrt((x - centerX)² + (y - centerY)²) and angle θ = atan2(y - centerY, x - centerX) (radians).
- Points sit every 72° starting at the top (θ = -π/2). For your angle θ, let φ = ((θ + π/2) mod (2π/5)) − π/5 (distance to the nearest point axis, signed).
- Let rTarget = rInner + (rOuter - rInner) * max(0, 1 - |φ| / (π/5)).
- If d <= rTarget → state=1. Otherwise → state=0.
- If you are right on the boundary, match your neighbors along the same star-arm so the tip stays crisp.`
	},

	// ─────────────────────────────────────────────────────────────────────────
	// PATTERNS
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'checkerboard',
		name: 'Checkerboard',
		category: 'patterns',
		description: 'Alternating cells like a chess board',
		task: `Together with your neighbors, tile the whole grid in a checkerboard pattern.

Shared goal:
- Every alive cell is surrounded only by dead cells on its 4 cardinal sides, and vice versa.

Your decision:
- If (x + y) is even → state=1. Otherwise → state=0.
- Your neighbors on the N/E/S/W sides should all be the opposite of you — if they are, you are in agreement and stable.`
	},
	{
		id: 'vertical-stripes',
		name: 'Vertical Stripes',
		category: 'patterns',
		description: 'Vertical lines across the grid',
		task: `Together with your neighbors, paint the grid in vertical stripes two cells wide.

Shared goal:
- Columns alternating alive/dead in bands of width 2 (alive-alive-dead-dead-alive-alive...).

Your decision:
- If floor(x / 2) is even → state=1. Otherwise → state=0.
- Your left and right neighbors inside the same band should match your state; those crossing a band edge should be opposite.`
	},
	{
		id: 'horizontal-stripes',
		name: 'Horizontal Stripes',
		category: 'patterns',
		description: 'Horizontal lines across the grid',
		task: `Together with your neighbors, paint the grid in horizontal stripes two cells wide.

Shared goal:
- Rows alternating alive/dead in bands of height 2.

Your decision:
- If floor(y / 2) is even → state=1. Otherwise → state=0.
- Your up and down neighbors within the same band should match your state; those across a band edge should be opposite.`
	},
	{
		id: 'diagonal-stripes',
		name: 'Diagonal Stripes',
		category: 'patterns',
		description: 'Diagonal lines across the grid',
		task: `Together with your neighbors, paint the grid in diagonal stripes running top-left to bottom-right.

Shared goal:
- Bands of width 2 that all slope the same direction across the grid.

Your decision:
- If floor((x + y) / 2) is even → state=1. Otherwise → state=0.
- Your diagonal neighbors (dx=1, dy=1) and (dx=-1, dy=-1) within the same band should match your state; perpendicular neighbors on the (dx=1, dy=-1) axis should alternate.`
	},
	{
		id: 'gradient',
		name: 'Gradient',
		category: 'patterns',
		description: 'Density increases left to right',
		task: `Cooperate to paint a horizontal density gradient — sparse on the left side of the grid, dense on the right.

Shared goal:
- The fraction of alive cells per column increases smoothly from near 0 on the left edge to near 1 on the right edge.

Your decision:
- Let the target density for your column be p = x / (gridWidth - 1).
- Use an ordered-dither step: let t = (y mod 4) / 4 + 1 / 8. If p > t → state=1. Otherwise → state=0.
- This produces a stable, deterministic gradient where every column shares the same pattern across y, and denser columns simply flip more rows on.`
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
		id: 'scene-lighthouse-night',
		name: 'Scene: Lighthouse at Night',
		category: 'scenes',
		description: 'Lighthouse on a rocky cliff with a sweeping light beam',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#0A1128".

Scene:
- Night sky: deep indigo at top fading to near-black near the horizon. Sprinkle a few bright stars (single pixels) in the upper third.
- Sea: darker navy band below the horizon with a couple of brighter horizontal reflection pixels.
- Cliff: jagged dark rock shape rising from one side of the grid (~1/3 width), use a cold grey.
- Lighthouse: a tall narrow tower on top of the cliff (2 cells wide), white with one or two red accent bands. Small lantern cap at top in warm yellow.
- Light beam: a diagonal wedge of warm yellow pixels emanating from the lantern toward the opposite side of the grid — brightest near the source, fading with distance.
`
	},
	{
		id: 'scene-desert-cactus',
		name: 'Scene: Desert with Cactus',
		category: 'scenes',
		description: 'Sand dunes, a saguaro cactus, and a hot sun',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#F5A25D".

Scene:
- Sky: warm peach/orange gradient, lighter near horizon.
- Sun: large pale-yellow disc in the upper portion (use distance-from-center threshold).
- Dunes: two overlapping rolling curves across the lower half, lighter tan in front, darker ochre behind.
- Cactus: a saguaro silhouette near the center — a thick vertical trunk (2–3 cells wide) in deep green with two upward-curved arms branching off at different heights.
- Small rocks or pebbles: a couple of dark brown single-pixel specks scattered on the dune surface.
`
	},
	{
		id: 'scene-volcano-eruption',
		name: 'Scene: Erupting Volcano',
		category: 'scenes',
		description: 'Mountain spewing lava with ash cloud and glowing sky',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#FF4500".

Scene:
- Sky: angry gradient from deep purple at top to hot red/orange near the volcano.
- Volcano: a large triangular silhouette occupying the lower ~60% of the grid. Dark grey-black rock, lighter grey ridgelines on one edge.
- Crater: a small notch at the apex.
- Lava flow: bright orange/yellow streaks running down one flank of the mountain — hottest at the source, cooling to dark red at the base.
- Ash cloud: a billowing dark-grey plume rising above the crater, growing wider as it rises. Scatter a few bright ember pixels inside the plume.
- Ground: scorched black/red at the volcano's foot.
`
	},
	{
		id: 'scene-campfire-stars',
		name: 'Scene: Campfire Under Stars',
		category: 'scenes',
		description: 'Nighttime campsite with a warm fire and a starry sky',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#1A1330".

Scene:
- Sky: deep navy-to-black gradient. Scatter ~8–12 bright star pixels (white or very pale yellow) in the upper two-thirds using a deterministic hash of (x, y).
- Ground: dark earthy brown band across the bottom (~20% of grid).
- Tent: a simple triangular silhouette to one side, dark teal or olive. Small vertical pole line at the apex.
- Campfire: a small cluster of 4–6 pixels near the center-bottom — hottest yellow at the core, orange around it, deep red at the outer edges.
- Glow: a faint warm tint on ground cells immediately surrounding the fire.
- Silhouetted trees: 2–3 dark pine tree outlines on the horizon behind the tent.
`
	},
	{
		id: 'scene-coral-reef',
		name: 'Scene: Underwater Coral Reef',
		category: 'scenes',
		description: 'Blue water with coral stacks, fish, and light shafts',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#08415C".

Scene:
- Water: vertical gradient — bright aqua near the top, deep navy near the bottom.
- Light shafts: two or three diagonal bands of slightly-lighter blue reaching down from the surface.
- Sand floor: pale yellow band across the bottom 2–3 rows.
- Coral stacks: 2–3 vertical coral structures rising from the sand in different colors — coral-pink, mustard-yellow, and magenta-purple. Use varied widths and branching tips.
- Seaweed: a few thin dark-green wavy vertical lines.
- Fish: 3–5 tiny fish silhouettes (2-pixel clusters) in bright accent colors scattered at different heights.
- Bubbles: a handful of single-pixel pale highlights rising in a column.
`
	},
	{
		id: 'scene-city-skyline',
		name: 'Scene: City Skyline at Dusk',
		category: 'scenes',
		description: 'Building silhouettes against a pink/orange evening sky',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#F5A3B4".

Scene:
- Sky: rich dusk gradient — lavender/purple at the top, pink in the middle, warm amber near the horizon.
- Sun: a flattened half-disc sitting on the horizon line in bright gold.
- Buildings: a jagged skyline silhouette across the lower half — at least 5 rectangular buildings of different heights and widths, all very dark indigo. Include one taller skyscraper.
- Windows: small lit windows scattered across the building silhouettes — use warm yellow single pixels in a deterministic pattern (e.g. based on (x + y) parity on certain rows).
- Reflection: a muted version of the sky colors mirrored on a water strip at the very bottom, with faint horizontal ripple lines.
`
	},
	{
		id: 'scene-spaceship-planet',
		name: 'Scene: Spaceship Over Ringed Planet',
		category: 'scenes',
		description: 'Starfield, a ringed planet, and a small spaceship',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#0B0221".

Scene:
- Space: deep purple-black background everywhere by default.
- Stars: many tiny bright pixels across the whole grid, varied brightness (white / pale blue / pale yellow). Use a deterministic hash of (x, y) so only a small fraction are lit.
- Nebula wisps: a few soft patches of violet/rose tint in the upper portion.
- Planet: a large disc occupying the lower-right quadrant, orange/ochre body with one darker band across the middle. Smooth circular silhouette from (x,y) distance check.
- Rings: a thin ellipse of lighter cream cutting across the planet at a tilt (passing behind and then in front).
- Spaceship: a small bright silver/cyan cluster (5–8 pixels) in the upper-left, with a faint warm engine trail of 2–3 pixels behind it.
`
	},
	{
		id: 'scene-hot-air-balloon',
		name: 'Scene: Hot Air Balloon',
		category: 'scenes',
		description: 'Colorful balloon drifting over distant hills and clouds',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#9BD3F7".

Scene:
- Sky: bright cheerful blue with a soft gradient (lighter near horizon).
- Clouds: 2–3 puffy white cloud shapes at varied heights, slightly off-white with lighter highlights on top.
- Distant hills: soft green rolling silhouettes across the bottom third.
- Balloon envelope: a large rounded teardrop/circle in the upper-center. Paint it with 3 vertical bands of contrasting colors — red, yellow, and blue stripes for a festival look.
- Basket: a small brown rectangular basket directly beneath the balloon, connected by 2–3 thin ropes (vertical lines).
- Flame: a tiny orange/yellow flicker at the top of the basket, just beneath the balloon mouth.
`
	},
	{
		id: 'scene-tropical-island',
		name: 'Scene: Tropical Island',
		category: 'scenes',
		description: 'Small island with a palm tree, turquoise ocean, and bright sun',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#FFD76E".

Scene:
- Sky: pale cyan-to-white gradient.
- Sun: bright yellow disc in the upper area with a soft paler halo ring around it.
- Ocean: turquoise band across the middle, with 2–3 thin horizontal wave lines in lighter aqua suggesting ripples.
- Island: a small arched sand mound near the center-bottom — golden-tan color.
- Palm tree: a curved dark-brown trunk rising from the island, with 4–5 fronds fanning out at the top in two shades of green.
- Coconuts: 2 small dark-brown dots where the fronds meet the trunk.
- Reflection: a faint vertical shimmer below the island and sun.
`
	},
	{
		id: 'scene-autumn-forest',
		name: 'Scene: Autumn Forest',
		category: 'scenes',
		description: 'Red, orange, and yellow trees with falling leaves',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#D4572A".

Scene:
- Sky: soft hazy gradient from pale blue at top to creamy peach near the tree line.
- Trees: 3–5 tree silhouettes across the middle of the grid at varying x. Each tree is a thin dark-brown trunk (1 cell wide) topped with a round canopy. Vary the canopy color per tree — pick from deep red, burnt orange, golden yellow, and rust brown.
- Ground: warm brown earth band at the bottom with scattered fallen-leaf pixels in the same autumn palette.
- Falling leaves: 6–10 single-pixel leaves in red/orange/yellow scattered across the air between the trees, positioned with a deterministic hash so they don't clump.
- Distant trees: a faint purplish silhouette strip on the horizon suggesting depth.
`
	},
	{
		id: 'scene-cherry-blossom',
		name: 'Scene: Cherry Blossom Tree',
		category: 'scenes',
		description: 'A pink sakura tree against a calm spring sky',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#FFC7E0".

Scene:
- Sky: pale baby-blue with a very soft gradient toward lavender-pink near the horizon.
- Ground: soft mossy-green band at the bottom, a few tiny grass tufts in slightly darker green.
- Tree trunk: a twisting dark-brown trunk rising from the ground-left, with 2–3 main branches spreading up and to the right.
- Blossoms: a dense cloud of pink pixels covering the branch tips — mix at least two pinks (light cotton-candy pink and a slightly deeper rose) for depth. Include a few pure-white highlight pixels.
- Falling petals: 4–6 single pink pixels drifting in the air around the tree.
- Distant pond: a narrow horizontal band of pale blue near the ground mirroring the sky.
`
	},
	{
		id: 'scene-castle-hill',
		name: 'Scene: Castle on a Hill',
		category: 'scenes',
		description: 'Silhouetted castle on a grassy hill under a moonlit sky',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#2B2D5C".

Scene:
- Sky: deep indigo gradient with a hint of violet near the horizon.
- Moon: a bright pale-yellow disc with a subtle glow ring in the upper quadrant.
- Stars: a sparse sprinkle of tiny white/pale-blue pixels.
- Hill: a rounded dark-green/teal mound occupying the lower half of the grid.
- Castle silhouette on the hilltop: central keep rectangle with two flanking towers (taller). Top of each tower has crenellations (a row of alternating tall/short pixels).
- Windows: 2–3 tiny warm-yellow lit windows in the keep and towers.
- Flag: a single-pixel flag on top of the tallest tower, in deep red.
- Path: a subtle winding strip of lighter green/tan leading from the castle down the hill.
`
	},
	{
		id: 'scene-pumpkin-patch',
		name: 'Scene: Pumpkin Patch at Night',
		category: 'scenes',
		description: 'Halloween scene with pumpkins, a spooky tree, and a big moon',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#F7872F".

Scene:
- Sky: midnight purple-to-black gradient.
- Moon: a large pale-orange/cream full moon behind the tree, slightly off-center.
- Bats: 2–3 tiny M-shaped dark silhouettes flying across the sky.
- Spooky tree: a bare crooked dark tree silhouette on one side, with thin branches reaching toward the moon.
- Ground: dark muted brown/olive band across the bottom.
- Pumpkins: 3–5 round orange pumpkins at varied positions on the ground, each with a dark-green stem on top and a few darker vertical ridge lines for shape.
- One jack-o'-lantern: choose one pumpkin and give it a glowing yellow face (two triangle-eyes and a jagged mouth).
- Fog: a few low horizontal strips of faint grey just above the ground.
`
	},
	{
		id: 'scene-submarine-deep',
		name: 'Scene: Submarine in the Deep',
		category: 'scenes',
		description: 'Yellow submarine descending through dark water with bioluminescent fish',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#02162B".

Scene:
- Water: steep gradient — midnight blue at the top to almost-black at the bottom, suggesting great depth.
- Submarine: a yellow ovoid body in the middle-right with a small top tower (conning tower) and a single round porthole in warm white. Add a thin dark outline.
- Propeller: 2–3 small dark pixels trailing behind the sub.
- Headlight beam: a cone of pale yellow pixels extending forward from the front of the sub, dimming with distance.
- Bioluminescent fish: 4–6 tiny dots in cyan/teal/magenta scattered in the dark water, concentrated at varied depths.
- Seafloor: suggest a jagged darker ridge across the very bottom in murky grey-green.
- Bubbles: a column of small pale dots rising from near the sub.
`
	},
	{
		id: 'scene-alien-planet',
		name: 'Scene: Alien Planet',
		category: 'scenes',
		description: 'Purple landscape with twin moons and strange rock spires',
		task: `You are painting a pixel-art scene by choosing your cell's color.

Color mode rules (IMPORTANT):
1. If you are part of the scene, output {"state":1,"color":"#RRGGBB"}.
2. If you are not part of the scene, output {"state":0,"color":"#RRGGBB"}.
3. Use ONLY uppercase hex colors like "#5D2A8A".

Scene:
- Sky: eerie gradient from deep magenta at top to teal near the horizon.
- Twin moons: two differently-sized pale discs in the upper sky — one cream-white, one turquoise.
- Stars: a handful of sharp bright pixels sprinkled across the sky.
- Mountains: a low silhouette of jagged dark-purple peaks on the horizon.
- Ground: alien magenta/violet rock plain with subtle darker cracks (thin lines).
- Rock spires: 2–3 tall impossibly-thin vertical spires rising from the ground in dark purple with a lighter highlight on one side.
- Glowing crystals: 3–5 small bright cyan/green single-pixel crystals on the ground, each with one diagonal pixel of glow adjacent.
- Atmosphere: a thin band of aurora-like green shimmer running horizontally in the middle sky.
`
	},
	{
		id: 'face-generic-portrait',
		name: 'Face: Generic Close-up Portrait',
		category: 'scenes',
		description: 'Basic symmetric human face — discovered collaboratively',
		task: `Together with your neighbors, paint a recognizable close-up portrait of a human face.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- Pick colors collectively. No single cell owns the palette.

Shared goal:
- One coherent face centered on the grid, with hair above, two eyes, a nose, and a mouth below, fading to background at the edges. Bilaterally symmetric about the vertical center.

Your decision:
- From your (x, y), guess which region you probably belong to (background, hair, skin, eye, brow, nose, or mouth) and pick a color consistent with that role.
- Look at your neighbors' current colors and your own history from previous frames. Early frames will be rough; later frames sharpen as cells settle into matching colors within each region.
- Stay close to your own last color unless the surrounding pattern clearly asks you to change roles.`
	},
	{
		id: 'face-elderly-man',
		name: 'Face: Elderly Man with Wrinkles',
		category: 'scenes',
		description: 'Weathered older face — features emerge through iteration',
		task: `Together with your neighbors, paint a close-up portrait of a weathered elderly man.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group picks the palette. No single cell prescribes it.

Shared goal:
- A recognizable aged male face, roughly symmetric. Distinguishing traits the group should converge on: grey/white hair or thinning top, bushy brows, deep-set eyes, a fuller nose, a grey beard or moustache covering the jaw.

Your decision:
- From your (x, y), infer whether you live in background, hair, brow, skin, eye, beard, or mouth.
- Watch neighbors and your own past frames. Wrinkle lines and beard texture emerge when neighboring cells agree on subtle tone differences — let them form over multiple generations rather than forcing them immediately.`
	},
	{
		id: 'face-baby',
		name: 'Face: Baby',
		category: 'scenes',
		description: 'Round, big-eyed infant face — emerges over frames',
		task: `Together with your neighbors, paint a close-up portrait of a smiling baby.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group chooses the palette.

Shared goal:
- A very round, symmetric infant face. Distinguishing traits: oversized eyes, chubby cheeks with a warm flush, a tiny nose, a small smiling mouth, and very sparse hair on top.

Your decision:
- From your (x, y), guess whether you belong to background, cheek, eye, nose, mouth, or the small hair wisp.
- Use your neighbors' colors and your own history to stabilise. Round features sharpen when neighbors in the same region converge on the same colour.`
	},
	{
		id: 'face-cat-close-up',
		name: 'Face: Cat Close-up',
		category: 'scenes',
		description: 'Furry cat face — cells cooperate to find features',
		task: `Together with your neighbors, paint a close-up portrait of a cat.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group picks fur colour and markings.

Shared goal:
- A single recognisable cat face centered on the grid, symmetric about the vertical axis. Distinguishing traits: two triangular ears at the top corners, large almond-shaped eyes with vertical slit pupils, a small triangular nose, a simple mouth, and whiskers extending sideways from the cheeks.

Your decision:
- From your (x, y), guess your role (background, ear, fur, eye, pupil, nose, mouth, or whisker).
- Let markings (tabby stripes, etc.) emerge through agreement with neighbors over frames — don't invent them on frame 1.`
	},
	{
		id: 'face-robot',
		name: 'Face: Robot',
		category: 'scenes',
		description: 'Mechanical head — layout discovered by the group',
		task: `Together with your neighbors, paint a close-up portrait of a robot.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group chooses metal tone and accent colour.

Shared goal:
- A symmetric mechanical head centered on the grid. Distinguishing traits: rectangular or rounded metallic body, two glowing eyes, some kind of antenna or sensor on top, and a grille/mouth.

Your decision:
- From your (x, y), guess whether you are background, metal plate, rivet, eye glow, antenna, or mouth grille.
- Glow, rivets, and panel seams should emerge as neighbors settle on subtly different tones. Use your past frames to stay stable once your role is clear.`
	},
	{
		id: 'face-astronaut-helmet',
		name: 'Face: Astronaut in Helmet',
		category: 'scenes',
		description: 'Face peering through a visor — discovered iteratively',
		task: `Together with your neighbors, paint a close-up portrait of an astronaut inside a helmet.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group picks the helmet, visor, and background palette.

Shared goal:
- A symmetric astronaut head against deep space. Distinguishing traits: a round light-coloured helmet enclosing the face, a darker visor window in the middle, a dim face visible behind the visor, and stars scattered in the background.

Your decision:
- From your (x, y), guess your role (star/background, helmet shell, visor glass, face behind visor, or neck seal).
- Visor reflections emerge when helmet-edge cells settle on brighter values than glass cells over multiple frames. Don't invent them on the first frame.`
	},
	{
		id: 'face-viking-warrior',
		name: 'Face: Viking Warrior',
		category: 'scenes',
		description: 'Horned-helmet warrior — beard and features emerge',
		task: `Together with your neighbors, paint a close-up portrait of a Viking warrior.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group chooses skin, helmet, and beard tones.

Shared goal:
- A symmetric, stern male warrior face centered on the grid. Distinguishing traits: a metallic helmet on top with two horns curving outward, piercing eyes beneath the helmet rim, a thick beard covering the lower half of the face, possibly with visible braids.

Your decision:
- From your (x, y), guess your role (background, helmet metal, horn, skin, eye, beard).
- Braid texture and helmet rivets should appear gradually — let neighboring cells within the beard settle into alternating lighter/darker tones over several frames.`
	},
	{
		id: 'face-mona-lisa',
		name: 'Famous Face: Mona Lisa',
		category: 'scenes',
		description: 'Renaissance portrait — iconic features discovered together',
		task: `Together with your neighbors, paint a pixel-art homage to the Mona Lisa.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group decides the palette collaboratively.

Shared goal:
- A calm three-quarter-view female portrait in warm earth tones. Distinguishing traits that must be legible: long dark hair parted in the middle, a pale oval face, a subtle faint smile with one corner lifted slightly more than the other, and a hazy landscape background.

Your decision:
- From your (x, y), guess whether you are distant landscape, hair, skin, eye, smile, or dress.
- The faint asymmetric smile emerges only when cells around the mouth corners refine their positions across several frames. Don't paint a bold smile on frame 1.`
	},
	{
		id: 'face-einstein',
		name: 'Famous Face: Einstein',
		category: 'scenes',
		description: 'Wild white hair and mustache — emerge over frames',
		task: `Together with your neighbors, paint a pixel-art homage to Albert Einstein.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group picks the background tone and hair/skin tones.

Shared goal:
- A symmetric older male face. Distinguishing traits the group should converge on: a wild, chaotic crown of white/silver hair filling the upper portion (extending beyond the face outline), a thick bushy white mustache covering the upper lip, small lively eyes, and a smooth chin (no beard).

Your decision:
- From your (x, y), guess if you are background, hair, forehead, brow, eye, nose, mustache, or neckline.
- The chaotic hair texture emerges when neighboring hair cells settle on small variations in tone rather than a uniform block. Let that happen gradually across frames, using your own history to stay consistent once your role is clear.`
	},
	{
		id: 'face-van-gogh',
		name: 'Famous Face: Van Gogh Self-Portrait',
		category: 'scenes',
		description: 'Red-haired bearded man — bandaged ear emerges',
		task: `Together with your neighbors, paint a pixel-art homage to Van Gogh's self-portrait with bandaged ear.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group picks background, hair, and clothing tones.

Shared goal:
- A mostly-symmetric male face with one deliberate asymmetry: a pale bandage wrapping around one side of the head covering a single ear. Distinguishing traits: red/orange hair and beard, pale skin with warm undertones, a dark hat, intense eyes, and a coat beneath the chin.

Your decision:
- From your (x, y), guess your role (swirling background, hat, hair, skin, eye, beard, bandage, coat).
- Swirling brush-stroke textures in the background and the warm red-orange beard should emerge from neighbor agreement over several frames. The bandage must stay on ONE side only — reach consensus with neighbors on which side holds it and keep it consistent across frames.`
	},
	{
		id: 'face-frida-kahlo',
		name: 'Famous Face: Frida Kahlo',
		category: 'scenes',
		description: 'Unibrow, flower crown, bold lips — emerge together',
		task: `Together with your neighbors, paint a pixel-art homage to Frida Kahlo.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group picks the skin tone, flower colours, and background.

Shared goal:
- A symmetric female portrait with strong personality. Distinguishing traits that must be readable: a band of brightly-coloured flowers across the top of the head, a SINGLE continuous eyebrow spanning across the nose (unibrow — do not split it in the middle), confident dark eyes, and bold lips.

Your decision:
- From your (x, y), guess whether you are background, flower, leaf, hair, skin, brow, eye, nose, lip, or shawl.
- Flower colours should stay varied and playful — coordinate with neighbors so adjacent flowers pick different hues rather than all matching.
- Cells along the brow line across the bridge of the nose must agree on staying dark across frames; any split in the middle would break the defining unibrow. Use your history to hold the brow steady once it forms.`
	},
	{
		id: 'face-lincoln',
		name: 'Famous Face: Abraham Lincoln',
		category: 'scenes',
		description: 'Stovepipe hat, gaunt face, chinstrap beard',
		task: `Together with your neighbors, paint a pixel-art homage to Abraham Lincoln.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group picks the hat tone, background, and skin tone.

Shared goal:
- A symmetric, gaunt male portrait. Distinguishing traits: a TALL stovepipe top hat dominating the upper portion of the grid (visibly taller than it is wide), a narrow elongated face beneath, a prominent long nose, a serious mouth with no smile, and a CHINSTRAP beard — hair along the jawline only, with a CLEAN-SHAVEN upper lip (no mustache).

Your decision:
- From your (x, y), guess if you are background, hat, brim, face, eye, nose, mouth, beard, or collar.
- The chinstrap beard is the defining feature. Cells above the mouth must agree to stay clean-shaven skin; cells along the jaw must agree to be beard. This boundary sharpens over successive frames as neighbors reinforce each other's roles from past states.`
	},
	{
		id: 'face-geisha',
		name: 'Famous Face: Geisha',
		category: 'scenes',
		description: 'White-painted face, ornate hair, red lower lip',
		task: `Together with your neighbors, paint a pixel-art portrait of a geisha.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group picks background, hair ornament colours, and lip/accent tones.

Shared goal:
- A symmetric female portrait against a dark background. Distinguishing traits: a very pale, almost porcelain face, a tall ornate dark hairstyle on top of the head with a few bright accent ornaments, thin arched brows, subtle eyes, and a small painted lower lip (upper lip stays unpainted like the face).

Your decision:
- From your (x, y), guess your role (background, hair, ornament, face paint, brow, eye, lower-lip accent, neckline).
- The defining detail is that only the CENTER of the lower lip is vividly coloured — the upper lip and most of the mouth area stay as pale face. Neighbors across the mouth must agree, frame by frame, to keep most of the mouth region the same as the face; let the tiny red accent stabilise through iteration.`
	},
	{
		id: 'face-samurai',
		name: 'Famous Face: Samurai (Kabuto Helmet)',
		category: 'scenes',
		description: 'Horned helmet, menpo mask, only eyes exposed',
		task: `Together with your neighbors, paint a pixel-art portrait of a samurai in a full kabuto helmet.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group picks helmet colour, accent metal, and background.

Shared goal:
- A symmetric, imposing portrait. Distinguishing traits: a domed helmet filling the upper half with a prominent metallic front-crest (moon or horn shape), side flaps sweeping outward, a narrow horizontal strip of exposed face showing only the EYES, and a dark metal mask covering the lower face.

Your decision:
- From your (x, y), guess your role (background, helmet body, crest, side flap, exposed skin/eye strip, mouth mask, neck armour).
- Rim rivets along the helmet edge and crest shine emerge when those cells reach agreement on slightly brighter tones over successive frames.`
	},
	{
		id: 'face-hepburn',
		name: 'Famous Face: Audrey Hepburn',
		category: 'scenes',
		description: 'Updo, oval sunglasses, red lips',
		task: `Together with your neighbors, paint a pixel-art homage to Audrey Hepburn.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group chooses the palette.

Shared goal:
- A symmetric elegant female portrait. Distinguishing traits: a tall smooth dark updo on the head, large round dark sunglasses fully covering the eyes (two connected lenses with a thin bridge), pale refined skin, a slender nose, bold red lips, and a high black neckline below.

Your decision:
- From your (x, y), guess your role (background, hair, brow, sunglasses, skin, nose, lip, neckline).
- The sunglasses are the signature feature. Cells in the eye region must consensus-agree to be dark lens rather than skin or brow across frames.`
	},
	{
		id: 'face-profile-silhouette',
		name: 'Face: Side Profile Silhouette',
		category: 'scenes',
		description: 'Asymmetric side-profile silhouette',
		task: `Together with your neighbors, paint a side-profile pixel-art silhouette portrait.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group picks one solid silhouette colour and one background gradient or tone.

Shared goal:
- A single head seen from the side, NOT symmetric. The silhouette sits on one half of the grid with the facial features (forehead, nose, upper lip, lips, chin, jaw) protruding toward the other half. Distinguishing landmarks in the profile outline: forehead curve, brow ridge bump, triangular nose tip, philtrum indent, lip double-bump, chin curve, and jaw.

Your decision:
- From your (x, y), guess whether you are background or silhouette. Agree with neighbors on which side of the grid the face points — once the group commits to a direction, keep it consistent across all frames.
- The profile's sharpness (especially the nose tip) emerges from neighbours along the silhouette edge agreeing on exactly which cells are inside vs outside.`
	},
	{
		id: 'face-cyclops',
		name: 'Face: Mythical Cyclops',
		category: 'scenes',
		description: 'One giant central eye, stony features',
		task: `Together with your neighbors, paint a pixel-art portrait of a mythical cyclops.

Output format:
- Portrait cell: {"state":1,"color":"#RRGGBB"} (uppercase hex).
- Background cell: {"state":0,"color":"#RRGGBB"} (uppercase hex).
- The group picks skin and background tones.

Shared goal:
- A symmetric monstrous face with ONE striking feature: a single large central eye, clearly bigger than a normal human eye. Secondary traits: a heavy single brow above that eye, flat broad nose with just nostrils (no bridge), wide snarling mouth, unkempt hair.

Your decision:
- From your (x, y), guess your role (background, hair, rough skin, eye, pupil, brow, nostril, mouth, fang).
- Cells at (centerX, centerY) and a few rows/columns around must cooperate to form ONE eye, not two. Agreement is critical here — no independent sub-eyes should appear on either side. Use your past frames to keep the single eye stable once the group has committed to it.`
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

Good prompts frame a shared goal the cells cooperate to form, not a lookup from (x, y) to 0/1.

Suggested structure:
- Shared goal: what pattern should the whole grid converge on?
- Your decision: how to use your position, your current state, and your neighbor states to decide state=0 or state=1 each generation.
- Conflict resolution: what to do when the rule is ambiguous (look at your neighbors to stay consistent with them).`
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

/**
 * Recover a preset from its full task text. Useful when older persisted
 * experiment metadata lost `promptPresetId` but still kept the exact task.
 */
export function getPresetByTask(task: string): PromptPreset | undefined {
	const normalizedTask = task.trim();
	if (!normalizedTask) return undefined;
	return PROMPT_PRESETS.find((preset) => preset.task.trim() === normalizedTask);
}

// ============================================================================
// DEFAULT VALUES
// ============================================================================

// Default task description (matches 'filled-square' preset)
const DEFAULT_TASK = `Together with your neighbors, form a solid filled square in the middle of the grid.

Shared goal:
- A single coherent square block centered on the grid, roughly 40% of the grid's width/height on each side.

Your decision:
- Let centerX = gridWidth / 2 and centerY = gridHeight / 2.
- Let halfSide = max(2, floor(min(gridWidth, gridHeight) * 0.20)).
- If |x - centerX| <= halfSide AND |y - centerY| <= halfSide → join the square (state=1).
- Otherwise → stay outside (state=0).
- If you are right at the edge and unsure, use your neighborhood: if most of your neighbors on the "inside" side are alive, close the edge; if most are dead, stay out.`;

// Default advanced template with placeholders - provides full CA context
const DEFAULT_TEMPLATE = `== YOUR POSITION ==
You occupy cell ({{CELL_X}}, {{CELL_Y}}) on a {{GRID_WIDTH}}×{{GRID_HEIGHT}} grid.
x increases rightward (0 to {{MAX_X}}), y increases downward (0 to {{MAX_Y}}).

== HOW THIS GRID WORKS ==
{{GRID_WIDTH}}×{{GRID_HEIGHT}} cells update at the same time each generation. Every cell
reads the current frame (its own state + neighbor states), then all cells
commit their next state simultaneously. You cooperate with your neighbors
to accomplish the shared task below — your choice depends on the
collective pattern the group is trying to form, not only on your position
alone.

== TASK ==
{{TASK}}

== INPUT (each generation) ==
A JSON object with:
- "generation": Current time step (0, 1, 2, ...).
- "state": Your current state (0 or 1).
- "neighbors": Count of alive neighbors.
- "neighborhood": Array of [dx, dy, state] — offsets relative to you.

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

