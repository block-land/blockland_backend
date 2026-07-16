import { Worker } from "bullmq";
import { eq, and, lt, desc } from "drizzle-orm";
import { redis } from "./redis";
import { db } from "../db/connection";
import { conversation, message } from "../db/schema";
import { publishToUser } from "./realtime";
import type { MessageJobData } from "./queue";

/**
 * BullMQ worker that processes chat message jobs:
 *  1. INSERT the message row
 *  2. UPDATE the conversation (last message + unread counter for the recipient)
 *  3. PUBLISH a realtime event to BOTH participants so inbox + active thread update
 *
 * Started as a side-effect in index.ts (same process for dev simplicity).
 */

const started = { value: false };

export function startMessageWorker() {
  if (started.value) return;
  started.value = true;

  const worker = new Worker<MessageJobData>(
    "messages",
    async (job) => {
      const { conversationId, senderWallet, text, clientMessageId } = job.data;

      const [conv] = await db
        .select()
        .from(conversation)
        .where(eq(conversation.id, conversationId))
        .limit(1);

      if (!conv) {
        throw new Error(`Conversation ${conversationId} not found`);
      }

      // Use the client-provided id as the DB row id so the sender's optimistic
      // message dedupes against the SSE echo (same id on both sides).
      const msgId = clientMessageId;
      const now = new Date();

      await db.insert(message).values({
        id: msgId,
        conversationId,
        senderWallet,
        text,
        createdAt: now,
      });

      // Determine the recipient and increment their unread counter.
      const senderIsA = conv.participantA === senderWallet;
      const recipientWallet = senderIsA ? conv.participantB : conv.participantA;

      await db
        .update(conversation)
        .set({
          lastMessageText: text,
          lastMessageAt: now,
          // only bump unread if recipient still has it unread; mark read endpoint resets
          unreadA: senderIsA ? conv.unreadA : conv.unreadA + 1,
          unreadB: senderIsA ? conv.unreadB + 1 : conv.unreadB,
        })
        .where(eq(conversation.id, conversationId));

      const msgPayload = {
        type: "message",
        conversationId,
        message: {
          id: msgId,
          conversationId,
          senderWallet,
          text,
          createdAt: now.toISOString(),
          readAt: null,
        },
        lastMessageText: text,
        lastMessageAt: now.toISOString(),
      };

      // Fan out to both participants (sender gets echo/optimistic confirmation,
      // recipient gets the new message + unread bump).
      await Promise.all([
        publishToUser(conv.participantA, msgPayload),
        publishToUser(conv.participantB, msgPayload),
      ]);

      return { msgId, recipientWallet };
    },
    { connection: redis as any }
  );

  worker.on("completed", (job) => {
    console.log(`[worker] message job ${job.id} completed`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[worker] message job ${job?.id} failed:`, err.message);
  });

  return worker;
}
