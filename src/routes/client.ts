import { Hono } from "hono";
import { eq, or, ilike, and, ne } from "drizzle-orm";
import { db } from "../db/connection";
import { clientDetails } from "../db/schema";

export const clientRouter = new Hono();

// GET /api/client/search?q=<query>&exclude=<wallet>
// Search registered users by username OR wallet address, for starting a chat.
// `exclude` (the caller's own wallet) is always filtered out to prevent
// self-chat. MUST be defined before /:walletAddress so Hono matches the
// static path first.
clientRouter.get("/search", async (c) => {
  try {
    const q = c.req.query("q")?.trim();
    const exclude = c.req.query("exclude")?.trim();
    if (!q || q.length < 2) {
      return c.json({ ok: true, users: [] });
    }

    const pattern = `%${q}%`;
    const conditions = [
      or(
        ilike(clientDetails.username, pattern),
        ilike(clientDetails.walletAddress, pattern)
      ),
    ];
    if (exclude) {
      conditions.push(ne(clientDetails.walletAddress, exclude));
    }

    const rows = await db
      .select({
        walletAddress: clientDetails.walletAddress,
        username: clientDetails.username,
        photoUrl: clientDetails.photoUrl,
      })
      .from(clientDetails)
      .where(and(...conditions))
      .limit(20);

    return c.json({ ok: true, users: rows });
  } catch (err) {
    console.error("Search users error:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

// GET /api/client/:walletAddress
// Fetch user details by wallet address
clientRouter.get("/:walletAddress", async (c) => {
  try {
    const walletAddress = c.req.param("walletAddress");
    if (!walletAddress) {
      return c.json({ ok: false, error: "Missing wallet address" }, 400);
    }

    const rows = await db
      .select()
      .from(clientDetails)
      .where(eq(clientDetails.walletAddress, walletAddress))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ ok: false, error: "User not found" }, 404);
    }

    return c.json({ ok: true, client: rows[0] });
  } catch (err) {
    console.error("Fetch client error:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

// POST /api/client
// Register new user details
clientRouter.post("/", async (c) => {
  try {
    const { walletAddress, username, photoUrl } = await c.req.json();

    if (!walletAddress || !username) {
      return c.json({ ok: false, error: "walletAddress and username are required" }, 400);
    }

    // Check if wallet already registered
    const existing = await db
      .select()
      .from(clientDetails)
      .where(eq(clientDetails.walletAddress, walletAddress))
      .limit(1);

    if (existing.length > 0) {
      return c.json({ ok: false, error: "Wallet already registered" }, 409);
    }

    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(clientDetails).values({
      id,
      walletAddress,
      username,
      photoUrl: photoUrl || null,
      createdAt: now,
      updatedAt: now,
    });

    return c.json({
      ok: true,
      client: { id, walletAddress, username, photoUrl },
    });
  } catch (err) {
    console.error("Register client error:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

// PUT /api/client/:walletAddress
// Update user details
clientRouter.put("/:walletAddress", async (c) => {
  try {
    const walletAddress = c.req.param("walletAddress");
    const { username, photoUrl } = await c.req.json();

    if (!walletAddress) {
      return c.json({ ok: false, error: "Missing wallet address" }, 400);
    }

    const existing = await db
      .select()
      .from(clientDetails)
      .where(eq(clientDetails.walletAddress, walletAddress))
      .limit(1);

    if (existing.length === 0) {
      return c.json({ ok: false, error: "User not found" }, 404);
    }

    const now = new Date();
    await db
      .update(clientDetails)
      .set({
        username: username !== undefined ? username : existing[0].username,
        photoUrl: photoUrl !== undefined ? photoUrl : existing[0].photoUrl,
        updatedAt: now,
      })
      .where(eq(clientDetails.walletAddress, walletAddress));

    return c.json({
      ok: true,
      message: "Profile updated successfully",
    });
  } catch (err) {
    console.error("Update client error:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

// DELETE /api/client/:walletAddress
// Delete user details
clientRouter.delete("/:walletAddress", async (c) => {
  try {
    const walletAddress = c.req.param("walletAddress");
    if (!walletAddress) {
      return c.json({ ok: false, error: "Missing wallet address" }, 400);
    }

    const existing = await db
      .select()
      .from(clientDetails)
      .where(eq(clientDetails.walletAddress, walletAddress))
      .limit(1);

    if (existing.length === 0) {
      return c.json({ ok: false, error: "User not found" }, 404);
    }

    await db.delete(clientDetails).where(eq(clientDetails.walletAddress, walletAddress));

    return c.json({
      ok: true,
      message: "Profile deleted successfully",
    });
  } catch (err) {
    console.error("Delete client error:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});
