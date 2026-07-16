import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/postgres";

// Allow concurrent queries (SSE connections + worker + HTTP). Was max:1.
const client = postgres(connectionString, { max: 10 });

export const db = drizzle(client, { schema });
