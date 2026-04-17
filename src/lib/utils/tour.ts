/**
 * NLCA-only build: interactive GoL tour removed. Stubs keep Canvas + ClickHint compiling.
 */

const TOUR_COMPLETED_KEY = 'games-of-life-tour-completed';

let tourCompletionCallbacks: (() => void)[] = [];

export function isTourActive(): boolean {
	return false;
}

export function onTourCompleted(callback: () => void): () => void {
	tourCompletionCallbacks.push(callback);
	return () => {
		tourCompletionCallbacks = tourCompletionCallbacks.filter((cb) => cb !== callback);
	};
}

function notifyTourCompleted(): void {
	tourCompletionCallbacks.forEach((cb) => cb());
}

export function getSelectedGalleryRule(): string | null {
	return null;
}

export function hasTourBeenCompleted(): boolean {
	// No interactive tour in NLCA-only build; allow click hint without a prior tour.
	return true;
}

export function markTourCompleted(): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(TOUR_COMPLETED_KEY, 'true');
	notifyTourCompleted();
}

export function resetTourStatus(): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.removeItem(TOUR_COMPLETED_KEY);
}

export function createTour(): { destroy: () => void } {
	return { destroy: () => {} };
}

export function startTour(): void {
	markTourCompleted();
}

export function getTourStyles(): string {
	return '';
}
