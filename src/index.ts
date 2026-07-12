import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./lib/auth";
import { tiles } from "./routes/tiles";
import { clientRouter } from "./routes/client";
import "dotenv/config";

const app = new Hono();

// CORS — allow frontend (Next.js :3000) to call backend (:3001)
app.use(
  "*",
  cors({
    origin: ["http://localhost:3000", "http://localhost:3001"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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

const port = process.env.PORT ? parseInt(process.env.PORT) : 3001;

console.log(`Blockland backend running on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
