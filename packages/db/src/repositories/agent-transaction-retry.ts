const MAX_TRANSACTION_ATTEMPTS = 5;

export function isRetryableAgentTransactionConflict(error: unknown): boolean {
  const databaseError = error as {
    code?: string;
    errno?: number;
    number?: number;
    cause?: { code?: string; errno?: number; number?: number };
  };
  const code = databaseError.code ?? databaseError.cause?.code;
  const errno = databaseError.errno ?? databaseError.cause?.errno;
  const number = databaseError.number ?? databaseError.cause?.number;
  return (
    code === '40001' ||
    code === '40P01' ||
    code === 'ER_LOCK_DEADLOCK' ||
    errno === 1213 ||
    number === 1205
  );
}

export async function executeAgentTransactionWithRetry<T>(
  operation: () => Promise<T>,
  exhaustedCode: string,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableAgentTransactionConflict(error)) throw error;
      if (attempt === MAX_TRANSACTION_ATTEMPTS) throw new Error(exhaustedCode, { cause: error });
    }
  }
  throw new Error(exhaustedCode);
}
