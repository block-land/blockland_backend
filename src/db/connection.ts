import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/postgres";

// Disable SSL verification issues for development if needed, standard connection options
const client = postgres(connectionString, { max: 1 });

export const db = drizzle(client, { schema });
