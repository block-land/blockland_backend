import { Queue } from "bullmq";
import { redis } from "./redis";

/**
 * BullMQ queue for chat message persistence. The HTTP handler enqueues a job
 * and returns immediately (202), so the client isn't blocked on a DB write.
 * The worker (see worker.ts) persists the message and publishes the realtime
 * event via Redis Pub/Sub.
 */
export interface MessageJobData {
  conversationId: string;
  senderWallet: string;
  text: string;
  /** Client-provided message id; used as the DB row id so the sender's
   * optimistic message dedupes against the SSE echo. */
  clientMessageId: string;
}

export const messageQueue = new Queue<MessageJobData>("messages", {
  // Cast: bullmq bundles its own ioredis copy which mismatches our top-level
  // ioredis types. The live ioredis instance works fine at runtime.
  connection: redis as any,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 500 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});
