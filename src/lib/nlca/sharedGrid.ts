/**
 * SharedArrayBuffer-backed grid for zero-copy worker communication.
 *
 * Workers read grid state directly from shared memory instead of
 * receiving copies via postMessage structured clone. This eliminates
 * the ~1-8ms per-worker copy overhead for large grids.
 *
 * Requires crossOriginIsolated = true (COOP/COEP headers).
 */

const CONTROL_INTS = 4; // 4 × Int32 = 16 bytes for signaling
const CONTROL_BYTES = CONTROL_INTS * 4;
const GEN_IDX = 0;
const READY_IDX = 1;

export class SharedGridBuffer {
	readonly buffer: SharedArrayBuffer;
	readonly view: Uint32Array;
	readonly width: number;
	readonly height: number;
	/** Control header for atomic signaling between threads. */
	private readonly control: Int32Array;

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
		const cellCount = width * height;
		const totalBytes = CONTROL_BYTES + cellCount * 4;
		this.buffer = new SharedArrayBuffer(totalBytes);
		this.control = new Int32Array(this.buffer, 0, CONTROL_INTS);
		this.view = new Uint32Array(this.buffer, CONTROL_BYTES, cellCount);
	}

	/** Write grid data into shared memory and signal workers that new data is ready. */
	writeGrid(source: Uint32Array, generation: number): void {
		this.view.set(source);
		Atomics.store(this.control, GEN_IDX, generation);
		Atomics.store(this.control, READY_IDX, 1);
		Atomics.notify(this.control, READY_IDX);
	}

	/** Read the generation counter from shared memory. */
	getGeneration(): number {
		return Atomics.load(this.control, GEN_IDX);
	}

	/** Copy current grid to a plain ArrayBuffer-backed Uint32Array (required for WebGPU). */
	toUint32Array(): Uint32Array {
		return new Uint32Array(this.view);
	}

	/** Check if SharedArrayBuffer is available in this environment. */
	static isAvailable(): boolean {
		return (
			typeof SharedArrayBuffer !== 'undefined' &&
			(typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false)
		);
	}

	/** Byte offset where grid data starts (after the control header). */
	static get DATA_OFFSET(): number {
		return CONTROL_BYTES;
	}
}
