type MetaLike = {
	progress?: {
		current?: unknown;
	};
} | null;

type LatestLike = {
	generation?: unknown;
} | null;

export function deriveFrameCount(meta: MetaLike, latest: LatestLike): number {
	const fromMeta = meta?.progress?.current;
	if (typeof fromMeta === 'number' && Number.isFinite(fromMeta) && fromMeta >= 0) {
		return fromMeta;
	}

	const fromLatest = latest?.generation;
	if (typeof fromLatest === 'number' && Number.isFinite(fromLatest) && fromLatest >= 0) {
		return fromLatest;
	}

	return 0;
}
