import type { NlcaNeighborhood } from '../types.js';

type Offset = readonly [number, number];

function buildSquareRing(radius: number): Offset[] {
	const out: Offset[] = [];
	for (let dy = -radius; dy <= radius; dy++) {
		for (let dx = -radius; dx <= radius; dx++) {
			if (dx === 0 && dy === 0) continue;
			out.push([dx, dy]);
		}
	}
	return out;
}

const MOORE: Offset[] = buildSquareRing(1);
const VON_NEUMANN: Offset[] = [
	[0, -1],
	[-1, 0],
	[1, 0],
	[0, 1]
];
const EXTENDED_MOORE: Offset[] = buildSquareRing(2);

export function expectedOffsets(neighborhood: NlcaNeighborhood): Offset[] {
	switch (neighborhood) {
		case 'moore':
			return MOORE;
		case 'vonNeumann':
			return VON_NEUMANN;
		case 'extendedMoore':
			return EXTENDED_MOORE;
	}
}

export function expectedOffsetCount(neighborhood: NlcaNeighborhood): number {
	return expectedOffsets(neighborhood).length;
}

export function isOffsetValid(neighborhood: NlcaNeighborhood, dx: number, dy: number): boolean {
	if (dx === 0 && dy === 0) return false;
	const offsets = expectedOffsets(neighborhood);
	return offsets.some(([ex, ey]) => ex === dx && ey === dy);
}

/** Stable, order-independent string key for an offset set — used by edge checks. */
export function offsetSetKey(offsets: ReadonlyArray<readonly [number, number]>): string {
	return [...offsets]
		.map(([dx, dy]) => `${dx},${dy}`)
		.sort()
		.join('|');
}
