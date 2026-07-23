// Simple script to execute the migration directly using pg
import postgres from "postgres";
import "dotenv/config";

const url = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/postgres";
const sql = postgres(url);

async function run() {
  console.log("Running manual migration...");
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS "client_details" (
        "id" text PRIMARY KEY NOT NULL,
        "wallet_address" text NOT NULL,
        "username" text NOT NULL,
        "photo_url" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "client_details_wallet_address_unique" UNIQUE("wallet_address")
      );
    `;
    
    await sql`
      CREATE TABLE IF NOT EXISTS "tile_offer" (
        "id" text PRIMARY KEY NOT NULL,
        "tile_id" text NOT NULL REFERENCES "tile_listing"("id") ON DELETE CASCADE,
        "bidder" text NOT NULL,
        "price_lamports" bigint NOT NULL,
        "tx_signature" text,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `;

    // Add status column to existing tile_offer tables (idempotent).
    // Values: "pending" (default) | "accepted" | "declined"
    await sql`ALTER TABLE "tile_offer" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'pending';`;

    // Marketplace custody/escrow support:
    // - tile_listing.custodian: dev wallet that holds the tile while listed
    await sql`ALTER TABLE "tile_listing" ADD COLUMN IF NOT EXISTS "custodian" text;`;
    // - tile_offer.escrow_tx: signature of SOL locked into the dev wallet when an offer is made
    await sql`ALTER TABLE "tile_offer" ADD COLUMN IF NOT EXISTS "escrow_tx" text;`;
    // - tile_offer.refund_tx: signature of SOL returned to the bidder (cancel/decline/lost-approve)
    await sql`ALTER TABLE "tile_offer" ADD COLUMN IF NOT EXISTS "refund_tx" text;`;

    await sql`
      CREATE TABLE IF NOT EXISTS "conversation" (
        "id" text PRIMARY KEY NOT NULL,
        "participant_a" text NOT NULL,
        "participant_b" text NOT NULL,
        "tile_id" text REFERENCES "tile_listing"("id") ON DELETE SET NULL,
        "last_message_text" text,
        "last_message_at" timestamp,
        "unread_a" integer DEFAULT 0 NOT NULL,
        "unread_b" integer DEFAULT 0 NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `;

    // Drop index if it exists in older/broken setups, then recreate
    try {
      await sql`DROP INDEX IF EXISTS "conversation_pair_idx";`;
      await sql`CREATE UNIQUE INDEX "conversation_pair_idx" ON "conversation" ("participant_a", "participant_b");`;
    } catch (e) {
      console.warn("Roving pair index note:", e);
    }

    await sql`
      CREATE TABLE IF NOT EXISTS "message" (
        "id" text PRIMARY KEY NOT NULL,
        "conversation_id" text NOT NULL REFERENCES "conversation"("id") ON DELETE CASCADE,
        "sender_wallet" text NOT NULL,
        "text" text NOT NULL,
        "read_at" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `;

    try {
      await sql`DROP INDEX IF EXISTS "message_conversation_idx";`;
      await sql`CREATE INDEX "message_conversation_idx" ON "message" ("conversation_id", "created_at");`;
    } catch (e) {
      console.warn("Message sorting index note:", e);
    }

    console.log("Migration succeeded!");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await sql.end();
  }
}

run();
