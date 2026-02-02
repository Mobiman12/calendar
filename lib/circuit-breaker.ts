type CircuitState = {
  failures: number;
  openedAt: number | null;
};

const states = new Map<string, CircuitState>();

interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
}

export async function executeWithCircuitBreaker<T>(
  key: string,
  options: CircuitBreakerOptions,
  handler: () => Promise<T>,
): Promise<T> {
  const state = states.get(key) ?? { failures: 0, openedAt: null };
  if (state.openedAt && Date.now() - state.openedAt < options.cooldownMs) {
    throw new Error(`Circuit breaker for ${key} is open`);
  }

  try {
    const result = await handler();
    states.set(key, { failures: 0, openedAt: null });
    return result;
  } catch (error) {
    const failures = state.failures + 1;
    const openedAt = failures >= options.failureThreshold ? Date.now() : null;
    states.set(key, { failures, openedAt });
    throw error;
  }
}
