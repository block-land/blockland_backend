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
    console.log("Migration succeeded!");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await sql.end();
  }
}

run();
