export interface StartupRetryOptions<T> {
	operationName: string;
	operation: () => Promise<T>;
	retryDelaysMs: readonly number[];
	wait: (milliseconds: number) => Promise<void>;
	onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export async function runStartupTaskWithRetries<T>({
	operationName,
	operation,
	retryDelaysMs,
	wait,
	onRetry,
}: StartupRetryOptions<T>): Promise<T> {
	for (let attemptIndex = 0; ; attemptIndex += 1) {
		try {
			return await operation();
		} catch (error) {
			const retryDelay = retryDelaysMs[attemptIndex];
			if (retryDelay === undefined) {
				throw new Error(`${operationName} failed after ${attemptIndex + 1} attempts.`, {
					cause: error,
				});
			}
			onRetry?.(attemptIndex + 1, error, retryDelay);
			await wait(retryDelay);
		}
	}
}
