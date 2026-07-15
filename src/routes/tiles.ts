import { Hono } from "hono";
import { eq, and, gte, lte, desc, or, ilike } from "drizzle-orm";
import { latLngToCell } from "h3-js";
import { mintTile, TILE_PRICE_USD, usdToLamports, getSolUsdPrice } from "../services/solana";
import { db } from "../db/connection";
import { tileListing, saleEvent, clientDetails, tileOffer } from "../db/schema";

const H3_RESOLUTION = 7;

// Bounding box for the contiguous USA (approx).
// Used as a geofence to restrict tile purchases to USA only.
const USA_BOUNDS = {
  minLat: 24.396308, // south (Texas)
  maxLat: 49.384358, // north (Minnesota)
  minLng: -125.0, // west (California)
  maxLng: -66.93457, // east (Maine)
};

function isInUsaBounds(lat: number, lng: number): boolean {
  return (
    lat >= USA_BOUNDS.minLat &&
    lat <= USA_BOUNDS.maxLat &&
    lng >= USA_BOUNDS.minLng &&
    lng <= USA_BOUNDS.maxLng
  );
}

export const tiles = new Hono();

/**
 * GET /api/tiles/price
 * Returns the tile price in USD + current SOL equivalent.
 */
tiles.get("/price", async (c) => {
  try {
    const solPrice = await getSolUsdPrice();
    const lamports = await usdToLamports(TILE_PRICE_USD);
    return c.json({
      ok: true,
      usd: TILE_PRICE_USD,
      sol: lamports / 1_000_000_000,
      lamports,
      solPrice,
    });
  } catch {
    return c.json({ ok: false, error: "Failed to fetch price" }, 500);
  }
});

/**
 * POST /api/tiles/mint
 *
 * Mint a new compressed NFT tile to the buyer's wallet.
 * The backend co-signs the mint (holds tree authority).
 */
tiles.post("/mint", async (c) => {
  try {
    const body = await c.req.json();
    const { buyer, lat, lng, imageBase64, rarity } = body;

    // Basic validation
    if (!buyer || typeof buyer !== "string") {
      return c.json({ ok: false, error: "Invalid buyer address" }, 400);
    }
    if (typeof lat !== "number" || typeof lng !== "number") {
      return c.json({ ok: false, error: "Invalid coordinates" }, 400);
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return c.json({ ok: false, error: "Coordinates out of range" }, 400);
    }
    if (!isInUsaBounds(lat, lng)) {
      return c.json({ ok: false, error: "Purchases are currently restricted to the United States (USA) bounds" }, 400);
    }
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return c.json({ ok: false, error: "Missing image" }, 400);
    }

    // Compute H3 cell — this is the unique tile identity
    const h3Cell = latLngToCell(lat, lng, H3_RESOLUTION);

    // Check if this tile (cell) is already owned
    const existing = await db
      .select()
      .from(tileListing)
      .where(eq(tileListing.h3Cell, h3Cell))
      .limit(1);

    if (existing.length > 0) {
      return c.json(
        { ok: false, error: "Tile already owned by someone else" },
        409
      );
    }

    // Compute price on backend (never trust client) — $0.2 at live SOL rate
    const priceLamports = await usdToLamports(TILE_PRICE_USD);

    // Bubblegum limits metadata name to 32 bytes.
    const tileName = `BLT ${lat.toFixed(3)},${lng.toFixed(3)}`;

    const result = await mintTile({
      buyer,
      lat,
      lng,
      rarity: rarity ?? "Common",
      imageBase64,
      tileName,
      priceLamports,
    });

    // Record in DB
    const listingId = crypto.randomUUID();
    await db.insert(tileListing).values({
      id: listingId,
      assetId: result.assetId,
      h3Cell,
      lat: lat.toString(),
      lng: lng.toString(),
      rarity: rarity ?? "Common",
      status: "owned",
      owner: buyer,
      priceLamports: BigInt(priceLamports),
      metadataUri: result.metadataUri,
      imageUri: result.imageUri,
      txSignature: result.signature,
    });

    await db.insert(saleEvent).values({
      id: crypto.randomUUID(),
      assetId: result.assetId,
      type: "primary",
      priceLamports: BigInt(priceLamports),
      buyer,
      seller: null,
      txSignature: result.signature,
    });

    return c.json({
      ok: true,
      assetId: result.assetId,
      h3Cell,
      signature: result.signature,
      metadataUri: result.metadataUri,
    });
  } catch (err) {
    console.error("Mint failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ ok: false, error: message }, 500);
  }
});

/**
 * GET /api/tiles/bounds?minLng&minLat&maxLng&maxLat
 * Returns sold tiles within the viewport bounds as GeoJSON FeatureCollection.
 */
tiles.get("/bounds", async (c) => {
  try {
    const minLng = parseFloat(c.req.query("minLng") ?? "-180");
    const maxLng = parseFloat(c.req.query("maxLng") ?? "180");
    const minLat = parseFloat(c.req.query("minLat") ?? "-90");
    const maxLat = parseFloat(c.req.query("maxLat") ?? "90");

    const rows = await db
      .select({
        h3Cell: tileListing.h3Cell,
        owner: tileListing.owner,
        assetId: tileListing.assetId,
        lat: tileListing.lat,
        lng: tileListing.lng,
        username: clientDetails.username,
        photoUrl: clientDetails.photoUrl,
      })
      .from(tileListing)
      .leftJoin(
        clientDetails,
        eq(clientDetails.walletAddress, tileListing.owner)
      )
      .where(
        and(
          gte(tileListing.lat, minLat.toString()),
          lte(tileListing.lat, maxLat.toString()),
          gte(tileListing.lng, minLng.toString()),
          lte(tileListing.lng, maxLng.toString())
        )
      );

    // Build GeoJSON FeatureCollection
    const geojson: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: rows.map((row) => ({
        type: "Feature" as const,
        properties: {
          cell: row.h3Cell,
          owner: row.owner,
          username: row.username ?? null,
          photoUrl: row.photoUrl ?? null,
          assetId: row.assetId,
          status: "sold",
        },
        // Geometry computed lazily client-side via h3.cellToBoundary.
        // We send the cell index; frontend builds the polygon.
        geometry: {
          type: "Point",
          coordinates: [parseFloat(row.lng), parseFloat(row.lat)],
        },
      })),
    };

    return c.json(geojson);
  } catch (err) {
    console.error("Bounds query failed:", err);
    return c.json({ ok: false, error: "Failed to fetch tiles" }, 500);
  }
});

/**
 * GET /api/tiles
 * List all tiles with pagination, filtering (search, rarity, status), sorting, and publisher info.
 */
tiles.get("/", async (c) => {
  try {
    const limitQuery = c.req.query("limit");
    const offsetQuery = c.req.query("offset");
    const search = c.req.query("search");
    const rarity = c.req.query("rarity");
    const sort = c.req.query("sort") ?? "price-desc"; // price-desc | price-asc

    // Filter by status: in a marketplace, we show listed tiles.
    // If not specified, we can show listed tiles by default, but let's allow showing all or listed.
    const statusFilter = c.req.query("status") ?? "listed";

    let conditions: any[] = [];

    if (statusFilter !== "all") {
      conditions.push(eq(tileListing.status, statusFilter));
    }

    if (rarity && rarity !== "All") {
      conditions.push(eq(tileListing.rarity, rarity));
    }

    if (search) {
      conditions.push(
        or(
          ilike(tileListing.h3Cell, `%${search}%`),
          ilike(tileListing.lat, `%${search}%`),
          ilike(tileListing.lng, `%${search}%`),
          ilike(tileListing.owner, `%${search}%`)
        )
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count matching conditions
    const countQuery = db
      .select({ id: tileListing.id })
      .from(tileListing);
    
    if (whereClause) {
      countQuery.where(whereClause);
    }
    const totalRows = await countQuery;
    const total = totalRows.length;

    // Build the main query with clientDetails joined (publisher info)
    let queryBuilder = db
      .select({
        id: tileListing.id,
        assetId: tileListing.assetId,
        h3Cell: tileListing.h3Cell,
        lat: tileListing.lat,
        lng: tileListing.lng,
        rarity: tileListing.rarity,
        status: tileListing.status,
        seller: tileListing.seller,
        owner: tileListing.owner,
        priceLamports: tileListing.priceLamports,
        listingPriceLamports: tileListing.listingPriceLamports,
        metadataUri: tileListing.metadataUri,
        imageUri: tileListing.imageUri,
        txSignature: tileListing.txSignature,
        listedAt: tileListing.listedAt,
        soldAt: tileListing.soldAt,
        createdAt: tileListing.createdAt,
        publisherUsername: clientDetails.username,
        publisherPhotoUrl: clientDetails.photoUrl,
      })
      .from(tileListing)
      .leftJoin(
        clientDetails,
        eq(clientDetails.walletAddress, tileListing.owner)
      );

    if (whereClause) {
      queryBuilder.where(whereClause) as any;
    }

    // Sorting by price desimal (listingPriceLamports)
    if (sort === "price-asc") {
      queryBuilder.orderBy(tileListing.listingPriceLamports) as any;
    } else {
      queryBuilder.orderBy(desc(tileListing.listingPriceLamports)) as any;
    }

    if (limitQuery !== undefined) {
      const limit = parseInt(limitQuery);
      queryBuilder.limit(limit) as any;
    }
    if (offsetQuery !== undefined) {
      const offset = parseInt(offsetQuery);
      queryBuilder.offset(offset) as any;
    }

    const rows = await queryBuilder;

    // Convert BigInt columns to string for JSON serialization
    const safe = rows.map((r: any) => ({
      ...r,
      priceLamports: r.priceLamports?.toString() ?? null,
      listingPriceLamports: r.listingPriceLamports?.toString() ?? null,
    }));

    return c.json({ ok: true, tiles: safe, total });
  } catch (err) {
    console.error("List tiles failed:", err);
    return c.json({ ok: false, error: "Failed to list tiles" }, 500);
  }
});

/**
 * GET /api/tiles/owner/:wallet
 * Get tiles owned by a wallet (from DB index).
 * Solana addresses are base58 and case-sensitive — compare exactly.
 */
tiles.get("/owner/:wallet", async (c) => {
  try {
    const wallet = c.req.param("wallet");
    const limitQuery = c.req.query("limit");
    const offsetQuery = c.req.query("offset");
    const search = c.req.query("search");
    const status = c.req.query("status"); // listed | owned | all

    let conditions: any[] = [eq(tileListing.owner, wallet)];

    if (status === "all") {
      // "all" tab should only show tiles that are owned but NOT listed.
      // So status should be "owned"
      conditions.push(eq(tileListing.status, "owned"));
    } else if (status) {
      conditions.push(eq(tileListing.status, status));
    }

    if (search) {
      // Find by coordinate string or cell ID
      conditions.push(
        or(
          ilike(tileListing.h3Cell, `%${search}%`),
          ilike(tileListing.lat, `%${search}%`),
          ilike(tileListing.lng, `%${search}%`)
        )
      );
    }

    const whereClause = and(...conditions);

    // Fetch total count of owned tiles matching filters
    const totalRows = await db
      .select({ id: tileListing.id })
      .from(tileListing)
      .where(whereClause);
    const total = totalRows.length;

    // Build the main query with clientDetails joined (publisher info)
    let queryBuilder = db
      .select()
      .from(tileListing)
      .where(whereClause)
      .orderBy(desc(tileListing.createdAt));

    if (limitQuery !== undefined) {
      const limit = parseInt(limitQuery);
      queryBuilder = queryBuilder.limit(limit);
    }
    if (offsetQuery !== undefined) {
      const offset = parseInt(offsetQuery);
      queryBuilder = queryBuilder.offset(offset);
    }

    const rows = await queryBuilder;

    // Fetch offers count for each tile to return to frontend
    const safe = await Promise.all(rows.map(async (r: any) => {
      const countRes = await db
        .select({ id: tileOffer.id })
        .from(tileOffer)
        .where(eq(tileOffer.tileId, r.id));
      
      return {
        ...r,
        priceLamports: r.priceLamports?.toString() ?? null,
        listingPriceLamports: r.listingPriceLamports?.toString() ?? null,
        offersCount: countRes.length,
      };
    }));

    return c.json({ ok: true, tiles: safe, total });
  } catch (err) {
    console.error("Owner tiles failed:", err);
    return c.json({ ok: false, error: "Failed to fetch owner tiles" }, 500);
  }
});

/**
 * PUT /api/tiles/list
 * List a tile for sale in the marketplace.
 */
tiles.put("/list", async (c) => {
  try {
    const { assetId, priceSol, seller } = await c.req.json();

    if (!assetId || !seller || priceSol === undefined || parseFloat(priceSol) <= 0) {
      return c.json({ ok: false, error: "Invalid inputs" }, 400);
    }

    const priceLamports = BigInt(Math.round(parseFloat(priceSol) * 1_000_000_000));

    // Update status, seller, listingPriceLamports, and listedAt
    const result = await db
      .update(tileListing)
      .set({
        status: "listed",
        seller,
        listingPriceLamports: priceLamports,
        listedAt: new Date(),
      })
      .where(and(eq(tileListing.assetId, assetId), eq(tileListing.owner, seller)));

    return c.json({ ok: true });
  } catch (err) {
    console.error("Failed to list tile:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

/**
 * GET /api/tiles/:id
 * Get details of a single tile by ID or assetId.
 */
tiles.get("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    
    // Find by database id first, fallback to assetId
    const rows = await db
      .select({
        id: tileListing.id,
        assetId: tileListing.assetId,
        h3Cell: tileListing.h3Cell,
        lat: tileListing.lat,
        lng: tileListing.lng,
        rarity: tileListing.rarity,
        status: tileListing.status,
        seller: tileListing.seller,
        owner: tileListing.owner,
        priceLamports: tileListing.priceLamports,
        listingPriceLamports: tileListing.listingPriceLamports,
        metadataUri: tileListing.metadataUri,
        imageUri: tileListing.imageUri,
        txSignature: tileListing.txSignature,
        listedAt: tileListing.listedAt,
        soldAt: tileListing.soldAt,
        createdAt: tileListing.createdAt,
        publisherUsername: clientDetails.username,
        publisherPhotoUrl: clientDetails.photoUrl,
      })
      .from(tileListing)
      .leftJoin(
        clientDetails,
        eq(clientDetails.walletAddress, tileListing.owner)
      )
      .where(or(eq(tileListing.id, id), eq(tileListing.assetId, id)))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ ok: false, error: "Tile not found" }, 404);
    }

    const tile = rows[0];
    const safe = {
      ...tile,
      priceLamports: tile.priceLamports?.toString() ?? null,
      listingPriceLamports: tile.listingPriceLamports?.toString() ?? null,
    };

    return c.json({ ok: true, tile: safe });
  } catch (err) {
    console.error("Get tile detail failed:", err);
    return c.json({ ok: false, error: "Failed to fetch tile details" }, 500);
  }
});

/**
 * GET /api/tiles/:id/offers
 * Get active offers for a tile.
 */
tiles.get("/:id/offers", async (c) => {
  try {
    const tileId = c.req.param("id");

    // Fetch offers joined with clientDetails for user info
    const rows = await db
      .select({
        id: tileOffer.id,
        bidder: tileOffer.bidder,
        priceLamports: tileOffer.priceLamports,
        txSignature: tileOffer.txSignature,
        createdAt: tileOffer.createdAt,
        bidderUsername: clientDetails.username,
        bidderPhotoUrl: clientDetails.photoUrl,
      })
      .from(tileOffer)
      .leftJoin(
        clientDetails,
        eq(clientDetails.walletAddress, tileOffer.bidder)
      )
      .where(eq(tileOffer.tileId, tileId))
      .orderBy(desc(tileOffer.priceLamports));

    const safe = rows.map((r: any) => ({
      ...r,
      priceLamports: r.priceLamports.toString(),
    }));

    return c.json({ ok: true, offers: safe });
  } catch (err) {
    console.error("Get offers failed:", err);
    return c.json({ ok: false, error: "Failed to fetch offers" }, 500);
  }
});

/**
 * POST /api/tiles/:id/offers
 * Place a new offer on a tile.
 */
tiles.post("/:id/offers", async (c) => {
  try {
    const tileId = c.req.param("id");
    const { bidder, priceSol, txSignature } = await c.req.json();

    if (!bidder || priceSol === undefined || parseFloat(priceSol) <= 0) {
      return c.json({ ok: false, error: "Invalid inputs" }, 400);
    }

    const priceLamports = BigInt(Math.round(parseFloat(priceSol) * 1_000_000_000));
    const id = crypto.randomUUID();

    await db.insert(tileOffer).values({
      id,
      tileId,
      bidder,
      priceLamports,
      txSignature: txSignature || null,
      createdAt: new Date(),
    });

    return c.json({ ok: true, offerId: id });
  } catch (err) {
    console.error("Place offer failed:", err);
    return c.json({ ok: false, error: "Failed to place offer" }, 500);
  }
});
