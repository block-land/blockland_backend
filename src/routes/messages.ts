import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eq, and, or, desc, lt, inArray } from "drizzle-orm";
import { db } from "../db/connection";
import {
  conversation,
  message,
  clientDetails,
  tileListing,
} from "../db/schema";
import { messageQueue } from "../lib/queue";
import { subscribeToUser } from "../lib/realtime";

export const messagesRouter = new Hono();

/** Order two wallets so each pair maps to exactly one conversation row. */
function orderedPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/** Find or create a conversation between two wallets, optionally scoped to a tile. */
async function findOrCreateConversation(
  walletA: string,
  walletB: string,
  tileId?: string | null
): Promise<string> {
  const [participantA, participantB] = orderedPair(walletA, walletB);

  const existing = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(
      and(
        eq(conversation.participantA, participantA),
        eq(conversation.participantB, participantB)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  const id = crypto.randomUUID();
  await db.insert(conversation).values({
    id,
    participantA,
    participantB,
    tileId: tileId ?? null,
  });
  return id;
}

// POST /api/messages
// Send a message. Enqueues a BullMQ job (async persistence) and returns 202.
messagesRouter.post("/", async (c) => {
  try {
    const { senderWallet, recipientWallet, text, tileId } = await c.req.json();

    if (!senderWallet || !recipientWallet || !text || !text.trim()) {
      return c.json(
        { ok: false, error: "senderWallet, recipientWallet and text are required" },
        400
      );
    }
    if (senderWallet === recipientWallet) {
      return c.json({ ok: false, error: "Cannot message yourself" }, 400);
    }

    const convId = await findOrCreateConversation(senderWallet, recipientWallet, tileId);

    const tempMessageId = crypto.randomUUID();
    await messageQueue.add("sendMessage", {
      conversationId: convId,
      senderWallet,
      text: text.trim(),
      clientMessageId: tempMessageId,
    });

    return c.json({ ok: true, conversationId: convId, tempMessageId }, 202);
  } catch (err) {
    console.error("Send message error:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

// GET /api/messages/conversation?me=<wallet>&them=<wallet>&tile=<tileId?>
// Find-or-create a conversation between two wallets (optionally scoped to a
// tile) and return its id. Used by the chat widget to open a thread before the
// first message is sent. Rejects self-conversation.
messagesRouter.get("/conversation", async (c) => {
  try {
    const me = c.req.query("me");
    const them = c.req.query("them");
    const tileId = c.req.query("tile") || null;

    if (!me || !them) {
      return c.json({ ok: false, error: "me and them query params are required" }, 400);
    }
    if (me === them) {
      return c.json({ ok: false, error: "Cannot message yourself" }, 400);
    }

    const convId = await findOrCreateConversation(me, them, tileId);
    return c.json({ ok: true, conversationId: convId });
  } catch (err) {
    console.error("Find-or-create conversation error:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

// GET /api/messages/conversations?wallet=<wallet>
// List all conversations for a wallet, with the other participant's profile,
// the context tile (card), and the caller's unread count.
messagesRouter.get("/conversations", async (c) => {
  try {
    const wallet = c.req.query("wallet");
    if (!wallet) {
      return c.json({ ok: false, error: "wallet query param is required" }, 400);
    }

    const rows = await db
      .select({
        id: conversation.id,
        participantA: conversation.participantA,
        participantB: conversation.participantB,
        tileId: conversation.tileId,
        lastMessageText: conversation.lastMessageText,
        lastMessageAt: conversation.lastMessageAt,
        unreadA: conversation.unreadA,
        unreadB: conversation.unreadB,
        createdAt: conversation.createdAt,
        tileLat: tileListing.lat,
        tileLng: tileListing.lng,
        tileRarity: tileListing.rarity,
        tileListingPriceLamports: tileListing.listingPriceLamports,
      })
      .from(conversation)
      .leftJoin(tileListing, eq(tileListing.id, conversation.tileId))
      .where(
        or(
          eq(conversation.participantA, wallet),
          eq(conversation.participantB, wallet)
        )
      )
      .orderBy(desc(conversation.lastMessageAt));

    if (rows.length === 0) {
      return c.json({ ok: true, conversations: [] });
    }

    // Batch-fetch profiles for all counterparties in one query.
    const otherWallets = Array.from(
      new Set(
        rows.map((r) =>
          r.participantA === wallet ? r.participantB : r.participantA
        )
      )
    );
    const profiles = await db
      .select({
        walletAddress: clientDetails.walletAddress,
        username: clientDetails.username,
        photoUrl: clientDetails.photoUrl,
      })
      .from(clientDetails)
      .where(inArray(clientDetails.walletAddress, otherWallets));

    const profileMap = new Map(
      profiles.map((p) => [p.walletAddress, p])
    );

    const conversationsList = rows.map((r: any) => {
      const isA = r.participantA === wallet;
      const otherWallet = isA ? r.participantB : r.participantA;
      const profile = profileMap.get(otherWallet);
      return {
        id: r.id,
        participantA: r.participantA,
        participantB: r.participantB,
        tileId: r.tileId,
        lastMessageText: r.lastMessageText,
        lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt).toISOString() : null,
        unread: isA ? r.unreadA : r.unreadB,
        createdAt: new Date(r.createdAt).toISOString(),
        other: {
          walletAddress: otherWallet,
          username: profile?.username || "Anonymous",
          photoUrl: profile?.photoUrl || null,
        },
        tile: r.tileId
          ? {
              id: r.tileId,
              lat: r.tileLat,
              lng: r.tileLng,
              rarity: r.tileRarity,
              listingPriceLamports: r.tileListingPriceLamports
                ? r.tileListingPriceLamports.toString()
                : null,
            }
          : null,
      };
    });

    return c.json({ ok: true, conversations: conversationsList });
  } catch (err) {
    console.error("List conversations error:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

// GET /api/messages/conversations/:id/messages?before=<iso>&limit=30
// Message history for a conversation, cursor-based (older than `before`).
messagesRouter.get("/conversations/:id/messages", async (c) => {
  try {
    const id = c.req.param("id");
    const beforeRaw = c.req.query("before");
    const limit = Math.min(parseInt(c.req.query("limit") || "30"), 100);

    const [conv] = await db
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.id, id))
      .limit(1);

    if (!conv) {
      return c.json({ ok: false, error: "Conversation not found" }, 404);
    }

    const conditions = [eq(message.conversationId, id)];
    if (beforeRaw) {
      conditions.push(lt(message.createdAt, new Date(beforeRaw)));
    }

    const rows = await db
      .select()
      .from(message)
      .where(and(...conditions))
      .orderBy(desc(message.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;

    const messages = slice
      .map((m: any) => ({
        id: m.id,
        conversationId: m.conversationId,
        senderWallet: m.senderWallet,
        text: m.text,
        createdAt: new Date(m.createdAt).toISOString(),
        readAt: m.readAt ? new Date(m.readAt).toISOString() : null,
      }))
      .reverse(); // chronological order for display

    return c.json({ ok: true, messages, hasMore });
  } catch (err) {
    console.error("Get messages error:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

// POST /api/messages/conversations/:id/read
// Mark a conversation as read for the given wallet (resets its unread counter).
messagesRouter.post("/conversations/:id/read", async (c) => {
  try {
    const id = c.req.param("id");
    const { wallet } = await c.req.json();
    if (!wallet) {
      return c.json({ ok: false, error: "wallet is required" }, 400);
    }

    const [conv] = await db
      .select()
      .from(conversation)
      .where(eq(conversation.id, id))
      .limit(1);

    if (!conv) {
      return c.json({ ok: false, error: "Conversation not found" }, 404);
    }

    const isA = conv.participantA === wallet;
    await db
      .update(conversation)
      .set(isA ? { unreadA: 0 } : { unreadB: 0 })
      .where(eq(conversation.id, id));

    return c.json({ ok: true });
  } catch (err) {
    console.error("Mark read error:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

// GET /api/messages/stream?wallet=<wallet>
// Server-Sent Events: pushes realtime chat events for the given wallet.
messagesRouter.get("/stream", (c) => {
  const wallet = c.req.query("wallet");
  if (!wallet) {
    return c.json({ ok: false, error: "wallet query param is required" }, 400);
  }

  return streamSSE(c, async (stream) => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;

    const cleanup = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = undefined;
      }
    };

    stream.onAbort(cleanup);

    try {
      // Let the client know the stream is live.
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ wallet }) });

      // Register for realtime events on this wallet's channel.
      unsubscribe = subscribeToUser(wallet, async (raw) => {
        try {
          const payload = JSON.parse(raw);
          await stream.writeSSE({
            event: payload.type || "message",
            data: raw,
          });
        } catch {
          /* ignore malformed payloads */
        }
      });

      // Heartbeat keeps the connection alive (proxies/clients may drop idle SSE).
      heartbeat = setInterval(async () => {
        try {
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        } catch {
          cleanup();
        }
      }, 25_000);

      // Hold the stream open for the lifetime of the connection. Hono keeps the
      // response open until the client disconnects (handled via onAbort).
      await new Promise<void>(() => {});
    } catch (e) {
      console.error("[sse] stream error:", e);
      cleanup();
    }
  });
});
