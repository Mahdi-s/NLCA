/** Respects the OS-level "reduce motion" preference. Returns true when the
 *  user has asked to minimize animation. Safe to call on the server (returns
 *  false). */
export function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}
