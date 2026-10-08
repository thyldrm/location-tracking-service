export type KeyOrderedResult<T> = {
  /** Rows the broker acknowledged, in input order. */
  published: T[];
  /** The first failed row of each key; the later rows of that key were not attempted. */
  failed: Array<{ row: T; error: unknown }>;
};

/**
 * Publishes rows so that rows with the same key reach the broker in input order, and a failure never
 * lets a later row of a key overtake the failed one:
 *
 * - the rows of one key are sent one after another, each after the previous one was acknowledged; the
 *   first failure stops that key, its remaining rows stay unpublished and are retried (in order) later;
 * - different keys are independent and are sent concurrently, so a batch takes about as long as its
 *   longest chain of one key, not as long as all sends together.
 *
 * Sending everything at once and keeping what succeeded would be faster, but when the first event of a
 * user fails and the second succeeds, the retry would publish them in the wrong order.
 */
export async function publishInKeyOrder<T extends { messageKey: string }>(
  rows: readonly T[],
  publish: (row: T) => Promise<void>,
): Promise<KeyOrderedResult<T>> {
  const published = new Set<T>();
  const failed: KeyOrderedResult<T>['failed'] = [];
  const chains = Map.groupBy(rows, (row) => row.messageKey);

  await Promise.all(
    [...chains.values()].map(async (chain) => {
      for (const row of chain) {
        try {
          await publish(row);
          published.add(row);
        } catch (error) {
          failed.push({ row, error });
          return;
        }
      }
    }),
  );

  return { published: rows.filter((row) => published.has(row)), failed };
}
