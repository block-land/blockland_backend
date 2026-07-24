import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./lib/auth";
import { tiles } from "./routes/tiles";
import { clientRouter } from "./routes/client";
import { messagesRouter } from "./routes/messages";
import { startMessageWorker } from "./lib/worker";
import "dotenv/config";

// Start the BullMQ message-persistence worker (same process for dev simplicity).
startMessageWorker();

const app = new Hono();

const defaultCorsOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://blockland.app",
  "https://blockland.app",
];
const allowedCorsOrigins = [
  ...new Set(
    (process.env.CORS_ORIGINS ?? defaultCorsOrigins.join(","))
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
];

// Browser requests are accepted only from configured frontend origins.
app.use(
  "*",
  cors({
    origin: allowedCorsOrigins,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Better Auth API Route Mounting
app.on(["POST", "GET"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

// Middleware to protect routes and resolve active user session
const getSession = async (req: Request) => {
  const session = await auth.api.getSession({
    headers: req.headers,
  });
  return session;
};

// Simple Healthcheck
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "blockland-backend" });
});

// Protected Profile Endpoint
app.get("/api/user/me", async (c) => {
  const sessionData = await getSession(c.req.raw);

  if (!sessionData || !sessionData.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({
    user: sessionData.user,
    session: sessionData.session,
  });
});

// Tile marketplace routes (mint, list, owner)
app.route("/api/tiles", tiles);

// Client details routes
app.route("/api/client", clientRouter);

// Messaging routes (send, list, history, read, SSE stream)
app.route("/api/messages", messagesRouter);

const port = process.env.PORT ? parseInt(process.env.PORT) : 3001;

console.log(`Blockland backend running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
  // SSE streams (e.g. /api/messages/stream) are long-lived connections. Bun's
  // default idleTimeout is 10s, which would kill the stream before the first
  // 25s heartbeat. 255s is Bun's max (equals HTTP/2 keepalive default).
  idleTimeout: 255,
};
