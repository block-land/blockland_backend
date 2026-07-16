import Redis from "ioredis";
import { redis } from "./redis";

/**
 * Realtime fan-out registry for chat SSE connections.
 *
 * Why a registry? We keep exactly ONE subscribed Redis connection per process
 * per channel, regardless of how many browser SSE clients are connected. Each
 * browser connection registers a callback; when a message is published to
 * Redis Pub/Sub, we fan it out to every registered callback for that channel.
 *
 * Channel convention: `chat:user:<walletAddress>`
 */

type Listener = (payload: string) => void;

const channelForUser = (wallet: string) => `chat:user:${wallet}`;

// Map of channel -> set of SSE callbacks
const listeners = new Map<string, Set<Listener>>();
// Map of channel -> subscribed Redis connection (1 per channel)
const subscribers = new Map<string, Redis>();
// Track how many processes have subscribed (ref-count not needed since 1 conn/channel)

/** Publish a chat event to a user's channel via Redis Pub/Sub. */
export async function publishToUser(wallet: string, payload: unknown): Promise<void> {
  const channel = channelForUser(wallet);
  const json = typeof payload === "string" ? payload : JSON.stringify(payload);
  await redis.publish(channel, json);
}

function ensureSubscriber(channel: string) {
  if (subscribers.has(channel)) return;
  const sub = redis.duplicate();
  sub.on("error", (err) => console.error(`[realtime] subscriber error for ${channel}:`, err.message));
  sub.subscribe(channel, (err) => {
    if (err) console.error(`[realtime] subscribe error for ${channel}:`, err.message);
  });
  sub.on("message", (_chan, message) => {
    const cbs = listeners.get(channel);
    if (!cbs) return;
    for (const cb of cbs) {
      try {
        cb(message);
      } catch (e) {
        console.error("[realtime] listener threw:", e);
      }
    }
  });
  subscribers.set(channel, sub);
}

/** Register an SSE callback for a user's chat channel. Returns an unsubscribe fn. */
export function subscribeToUser(wallet: string, cb: Listener): () => void {
  const channel = channelForUser(wallet);
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  set.add(cb);
  ensureSubscriber(channel);
  return () => {
    const s = listeners.get(channel);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) {
      listeners.delete(channel);
      const sub = subscribers.get(channel);
      if (sub) {
        sub.unsubscribe(channel);
        sub.quit();
        subscribers.delete(channel);
      }
    }
  };
}
