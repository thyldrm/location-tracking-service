import type { Env } from '../config/env.schema.js';
import { createKafka, type StructuredLogger } from './kafka-client.js';
import { TOPIC_DEFINITIONS } from './topic-definitions.js';

export type ProvisionTopicsEnv = Pick<
  Env,
  'KAFKA_BROKERS' | 'SERVICE_NAME' | 'KAFKA_REPLICATION_FACTOR'
>;

const ADMIN_TIMEOUT_MS = 30_000;

/**
 * Creates the topics of `TOPIC_DEFINITIONS` that do not exist yet. Safe to run repeatedly (like the
 * database migrations). Existing topics are never changed: a different partition count is reported
 * as a warning, because repartitioning a keyed topic is an operational decision, not a deploy step.
 *
 * In production the platform usually owns topics (e.g. Strimzi `KafkaTopic` resources); this keeps local
 * environments and tests reproducible from the same definitions.
 */
export async function provisionTopics(
  env: ProvisionTopicsEnv,
  logger: StructuredLogger,
): Promise<string[]> {
  const admin = createKafka(env, logger).admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics({ timeout: ADMIN_TIMEOUT_MS }));
    const missing = TOPIC_DEFINITIONS.filter((topic) => !existing.has(topic.name));
    if (missing.length > 0) {
      await admin.createTopics({
        timeout: ADMIN_TIMEOUT_MS,
        topics: missing.map((topic) => ({
          topic: topic.name,
          numPartitions: topic.partitions,
          replicationFactor: env.KAFKA_REPLICATION_FACTOR,
          configEntries: [
            { name: 'retention.ms', value: String(topic.retentionMs) },
            // With acks=all, a write succeeds only if this many replicas have it.
            {
              name: 'min.insync.replicas',
              value: String(Math.min(2, env.KAFKA_REPLICATION_FACTOR)),
            },
          ],
        })),
      });
    }

    const present = TOPIC_DEFINITIONS.filter((topic) => existing.has(topic.name));
    if (present.length > 0) {
      const metadata = await admin.fetchTopicMetadata({
        topics: present.map((topic) => topic.name),
        timeout: ADMIN_TIMEOUT_MS,
      });
      for (const topic of metadata) {
        const expected = TOPIC_DEFINITIONS.find((definition) => definition.name === topic.name);
        if (expected && topic.partitions.length !== expected.partitions) {
          logger.warn(
            {
              topic: topic.name,
              actual: topic.partitions.length,
              expected: expected.partitions,
            },
            'Topic exists with a different partition count; left unchanged',
          );
        }
      }
    }
    return missing.map((topic) => topic.name);
  } finally {
    await admin.disconnect();
  }
}
