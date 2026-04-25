const queues = new Map<string, Promise<void>>();

export function enqueueFileMutation<T>(
	key: string,
	mutation: () => Promise<T>
): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();

	const run = previous.catch(() => {}).then(mutation);
	const tail = run.then(
		() => undefined,
		() => undefined
	);
	queues.set(key, tail);

	return run.finally(() => {
		if (queues.get(key) === tail) queues.delete(key);
	});
}

export function __resetFileMutationQueueForTests(): void {
	queues.clear();
}
