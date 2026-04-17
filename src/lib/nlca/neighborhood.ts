import type { BoundaryMode } from '$lib/stores/simulation.svelte.js';
import type { CellContext, CellState01, NeighborSample, NlcaNeighborhood } from './types.js';

export type Offset = readonly [dx: number, dy: number];

export function getOffsets(neighborhood: NlcaNeighborhood): readonly Offset[] {
	switch (neighborhood) {
		case 'vonNeumann':
			return [
				[0, -1],
				[0, 1],
				[-1, 0],
				[1, 0]
			] as const;
		case 'extendedMoore': {
			const offsets: Offset[] = [];
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -2; dx <= 2; dx++) {
					if (dx === 0 && dy === 0) continue;
					offsets.push([dx, dy]);
				}
			}
			return offsets;
		}
		case 'moore':
		default:
			return [
				[-1, -1],
				[0, -1],
				[1, -1],
				[-1, 0],
				[1, 0],
				[-1, 1],
				[0, 1],
				[1, 1]
			] as const;
	}
}

function isWrappingX(boundary: BoundaryMode): boolean {
	return (
		boundary === 'cylinderX' ||
		boundary === 'torus' ||
		boundary === 'mobiusX' ||
		boundary === 'kleinX' ||
		boundary === 'kleinY' ||
		boundary === 'projectivePlane'
	);
}
function isWrappingY(boundary: BoundaryMode): boolean {
	return (
		boundary === 'cylinderY' ||
		boundary === 'torus' ||
		boundary === 'mobiusY' ||
		boundary === 'kleinX' ||
		boundary === 'kleinY' ||
		boundary === 'projectivePlane'
	);
}
function flipsOnWrapX(boundary: BoundaryMode): boolean {
	return boundary === 'mobiusX' || boundary === 'kleinX' || boundary === 'projectivePlane';
}
function flipsOnWrapY(boundary: BoundaryMode): boolean {
	return boundary === 'mobiusY' || boundary === 'kleinY' || boundary === 'projectivePlane';
}

/**
 * Match the CA boundary transform semantics used by the CPU kernel:
 * - supports multiple wraps (offset can exceed width/height)
 * - applies flips based on parity of boundary crossings
 */
export function transformCoordinate(
	x: number,
	y: number,
	width: number,
	height: number,
	boundary: BoundaryMode
): { x: number; y: number } | null {
	let fx = x;
	let fy = y;

	let xWraps = 0;
	let yWraps = 0;

	if (fx < 0 || fx >= width) {
		if (!isWrappingX(boundary)) return null;
		if (fx < 0) {
			xWraps = Math.floor((-fx - 1) / width) + 1;
			fx = ((fx % width) + width) % width;
		} else {
			xWraps = Math.floor(fx / width);
			fx = fx % width;
		}
	}

	if (fy < 0 || fy >= height) {
		if (!isWrappingY(boundary)) return null;
		if (fy < 0) {
			yWraps = Math.floor((-fy - 1) / height) + 1;
			fy = ((fy % height) + height) % height;
		} else {
			yWraps = Math.floor(fy / height);
			fy = fy % height;
		}
	}

	if (flipsOnWrapX(boundary) && (xWraps & 1) === 1) {
		fy = height - 1 - fy;
	}
	if (flipsOnWrapY(boundary) && (yWraps & 1) === 1) {
		fx = width - 1 - fx;
	}

	if (fx < 0 || fx >= width || fy < 0 || fy >= height) return null;
	return { x: fx | 0, y: fy | 0 };
}

export function getCell01(
	grid: Uint32Array,
	x: number,
	y: number,
	width: number,
	height: number,
	boundary: BoundaryMode
): CellState01 {
	const t = transformCoordinate(x, y, width, height, boundary);
	if (!t) return 0;
	const v = grid[t.x + t.y * width] ?? 0;
	return v === 0 ? 0 : 1;
}

export function extractCellContext(
	prev: Uint32Array,
	width: number,
	height: number,
	x: number,
	y: number,
	neighborhood: NlcaNeighborhood,
	boundary: BoundaryMode
): CellContext {
	const id = x + y * width;
	const self = getCell01(prev, x, y, width, height, boundary);
	const offsets = getOffsets(neighborhood);

	const neighbors: NeighborSample[] = [];
	for (const [dx, dy] of offsets) {
		neighbors.push({
			dx,
			dy,
			state: getCell01(prev, x + dx, y + dy, width, height, boundary)
		});
	}

	return { id, x, y, self, neighbors };
}


