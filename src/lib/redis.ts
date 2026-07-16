import Redis from "ioredis";

/**
 * Singleton Redis connection for the Blockland backend.
 * - Used by BullMQ (queue/worker) and the realtime SSE fan-out registry.
 * - `REDIS_URL` is configured in docker-compose / .env (default local).
 */
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null, // required by BullMQ
  lazyConnect: false,
});

redis.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});

export default redis;
