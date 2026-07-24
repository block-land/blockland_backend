import { Hono } from "hono";
import { eq, and, gte, lte, desc, or, ilike } from "drizzle-orm";
import { latLngToCell } from "h3-js";
import {
  mintTile,
  TILE_PRICE_USD,
  usdToLamports,
  getSolUsdPrice,
  buildListToCustodyTx,
  transferCompressedTile,
  sendSolFromCustodian,
  devWalletAddress,
} from "../services/solana";
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
    const { buyer, lat, lng, imageBase64, rarity, placeName } = body;

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
      placeName: typeof placeName === "string" && placeName.trim() ? placeName.trim() : null,
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
        placeName: tileListing.placeName,
        priceLamports: tileListing.priceLamports,
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
          placeName: row.placeName ?? null,
          priceLamports: row.priceLamports?.toString() ?? null,
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
 * GET /api/tiles/offers-by-bidder/:wallet
 * Returns every offer made BY the given wallet (as a bidder), joined with the
 * tile's data + seller info. Powers the "My Offers" tab on the account page.
 */
tiles.get("/offers-by-bidder/:wallet", async (c) => {
  try {
    const bidder = c.req.param("wallet");

    const rows = await db
      .select({
        offerId: tileOffer.id,
        offerPriceLamports: tileOffer.priceLamports,
        offerStatus: tileOffer.status,
        offerCreatedAt: tileOffer.createdAt,
        tileId: tileListing.id,
        assetId: tileListing.assetId,
        lat: tileListing.lat,
        lng: tileListing.lng,
        rarity: tileListing.rarity,
        tileStatus: tileListing.status,
        seller: tileListing.seller,
        sellerUsername: clientDetails.username,
        sellerPhotoUrl: clientDetails.photoUrl,
      })
      .from(tileOffer)
      .innerJoin(tileListing, eq(tileListing.id, tileOffer.tileId))
      .leftJoin(clientDetails, eq(clientDetails.walletAddress, tileListing.seller))
      .where(eq(tileOffer.bidder, bidder))
      .orderBy(desc(tileOffer.createdAt));

    const safe = rows.map((r: any) => ({
      ...r,
      offerPriceLamports: r.offerPriceLamports?.toString() ?? null,
    }));

    return c.json({ ok: true, offers: safe });
  } catch (err) {
    console.error("Offers by bidder failed:", err);
    return c.json({ ok: false, error: "Failed to fetch offers" }, 500);
  }
});

/**
 * PUT /api/tiles/list
 * List a tile for sale in the marketplace.
 */
/**
 * PUT /api/tiles/list
 * Prepare a marketplace listing: build the on-chain transaction that transfers
 * the tile from the seller into the custodian (dev) wallet. The seller signs
 * this on the frontend, then calls POST /list/confirm with the signature.
 *
 * Returns the unsigned tx (base64) + the custodian address + listing price.
 */
tiles.put("/list", async (c) => {
  try {
    const { assetId, priceSol, seller } = await c.req.json();

    if (!assetId || !seller || priceSol === undefined || parseFloat(priceSol) <= 0) {
      return c.json({ ok: false, error: "Invalid inputs" }, 400);
    }

    // The tile must currently be owned by the seller.
    const [row] = await db
      .select({ id: tileListing.id, owner: tileListing.owner, status: tileListing.status })
      .from(tileListing)
      .where(eq(tileListing.assetId, assetId))
      .limit(1);
    if (!row) {
      return c.json({ ok: false, error: "Tile not found" }, 404);
    }
    if (row.owner !== seller) {
      return c.json({ ok: false, error: "Not the tile owner" }, 403);
    }
    if (row.status === "listed") {
      return c.json({ ok: false, error: "Tile already listed" }, 400);
    }

    const custodian = devWalletAddress();
    const tx = await buildListToCustodyTx({ assetId, seller, custodian });
    const priceLamports = BigInt(Math.round(parseFloat(priceSol) * 1_000_000_000));

    return c.json({
      ok: true,
      tx,
      custodian,
      priceLamports: priceLamports.toString(),
    });
  } catch (err) {
    console.error("Failed to prepare listing:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

/**
 * POST /api/tiles/list/confirm
 * Called by the frontend AFTER the seller signed + submitted the custody
 * transfer on-chain. Records the listing + custodian in the DB.
 *
 * Body: { assetId, seller, priceSol, signature }
 */
tiles.post("/list/confirm", async (c) => {
  try {
    const { assetId, seller, priceSol, signature } = await c.req.json();

    if (!assetId || !seller || !signature || priceSol === undefined || parseFloat(priceSol) <= 0) {
      return c.json({ ok: false, error: "Invalid inputs" }, 400);
    }

    const priceLamports = BigInt(Math.round(parseFloat(priceSol) * 1_000_000_000));
    const custodian = devWalletAddress();

    // Record the listing. The custodian now holds the tile on-chain; the
    // original owner is kept in `seller` so settlement knows who to pay.
    await db
      .update(tileListing)
      .set({
        status: "listed",
        seller,
        custodian,
        listingPriceLamports: priceLamports,
        listedAt: new Date(),
      })
      .where(and(eq(tileListing.assetId, assetId), eq(tileListing.owner, seller)));

    return c.json({ ok: true });
  } catch (err) {
    console.error("Failed to confirm listing:", err);
    return c.json({ ok: false, error: "Internal server error" }, 500);
  }
});

/**
 * POST /api/tiles/list/cancel
 * Delist a tile: transfer the tile back from the custodian to the seller and
 * refund every pending offer's escrowed SOL. Seller triggers this.
 *
 * Body: { assetId, seller }
 */
tiles.post("/list/cancel", async (c) => {
  try {
    const { assetId, seller } = await c.req.json();
    if (!assetId || !seller) {
      return c.json({ ok: false, error: "Invalid inputs" }, 400);
    }

    const [row] = await db
      .select()
      .from(tileListing)
      .where(eq(tileListing.assetId, assetId))
      .limit(1);
    if (!row) {
      return c.json({ ok: false, error: "Tile not found" }, 404);
    }
    if (row.seller !== seller || row.status !== "listed") {
      return c.json({ ok: false, error: "Not allowed" }, 403);
    }

    // 1. Return the tile to the seller (custodian signs).
    await transferCompressedTile({ assetId, to: seller });

    // 2. Refund every pending offer's escrowed SOL.
    const pendingOffers = await db
      .select()
      .from(tileOffer)
      .where(and(eq(tileOffer.tileId, row.id), eq(tileOffer.status, "pending")));
    for (const off of pendingOffers) {
      const refundSig = await sendSolFromCustodian({
        to: off.bidder,
        lamports: off.priceLamports,
      });
      await db
        .update(tileOffer)
        .set({ status: "cancelled", refundTx: refundSig })
        .where(eq(tileOffer.id, off.id));
    }

    // 3. Clear the listing.
    await db
      .update(tileListing)
      .set({
        status: "owned",
        seller: null,
        custodian: null,
        listingPriceLamports: null,
        listedAt: null,
      })
      .where(eq(tileListing.id, row.id));

    return c.json({ ok: true });
  } catch (err) {
    console.error("Failed to delist tile:", err);
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
    const param = c.req.param("id");

    // The param may be either the database id (tileListing.id, a UUID) or the
    // assetId (compressed-NFT mint address). Resolve it to the canonical DB id
    // before querying offers, since tile_offer.tile_id references tileListing.id.
    // Mirrors the fallback used by GET /:id.
    const listingRows = await db
      .select({ id: tileListing.id })
      .from(tileListing)
      .where(or(eq(tileListing.id, param), eq(tileListing.assetId, param)))
      .limit(1);

    if (listingRows.length === 0) {
      return c.json({ ok: true, offers: [] });
    }
    const tileId = listingRows[0].id;

    // Fetch offers joined with clientDetails for user info
    const rows = await db
      .select({
        id: tileOffer.id,
        bidder: tileOffer.bidder,
        priceLamports: tileOffer.priceLamports,
        txSignature: tileOffer.txSignature,
        status: tileOffer.status,
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
      status: r.status ?? "pending",
    }));

    return c.json({ ok: true, offers: safe });
  } catch (err) {
    console.error("Get offers failed:", err);
    return c.json({ ok: false, error: "Failed to fetch offers" }, 500);
  }
});

/**
 * GET /api/tiles/:id/escrow-address
 * Returns the custodian (dev wallet) address where a bidder must escrow SOL
 * when making an offer, plus the resolved tile db id.
 */
tiles.get("/:id/escrow-address", async (c) => {
  try {
    const param = c.req.param("id");
    const listingRows = await db
      .select({ id: tileListing.id, status: tileListing.status })
      .from(tileListing)
      .where(or(eq(tileListing.id, param), eq(tileListing.assetId, param)))
      .limit(1);

    if (listingRows.length === 0) {
      return c.json({ ok: false, error: "Tile not found" }, 404);
    }
    return c.json({ ok: true, escrowAddress: devWalletAddress() });
  } catch (err) {
    console.error("Get escrow address failed:", err);
    return c.json({ ok: false, error: "Failed to fetch escrow address" }, 500);
  }
});

/**
 * POST /api/tiles/:id/offers
 * Place a new offer on a tile. The bidder must have ALREADY transferred SOL
 * into the custodian (dev wallet) on-chain; that signature is passed as
 * `escrowTx` and recorded so it can be refunded if the offer is declined /
 * cancelled / loses to another offer.
 *
 * Body: { bidder, priceSol, escrowTx }
 */
tiles.post("/:id/offers", async (c) => {
  try {
    const param = c.req.param("id");
    const { bidder, priceSol, escrowTx } = await c.req.json();

    if (!bidder || priceSol === undefined || parseFloat(priceSol) <= 0) {
      return c.json({ ok: false, error: "Invalid inputs" }, 400);
    }
    if (!escrowTx) {
      return c.json({ ok: false, error: "Missing escrowTx (SOL lock signature)" }, 400);
    }

    // Resolve the param (which may be either the DB id or the assetId) to the
    // canonical DB id, since tile_offer.tile_id references tileListing.id.
    const listingRows = await db
      .select({
        id: tileListing.id,
        status: tileListing.status,
        seller: tileListing.seller,
        owner: tileListing.owner,
      })
      .from(tileListing)
      .where(or(eq(tileListing.id, param), eq(tileListing.assetId, param)))
      .limit(1);

    if (listingRows.length === 0) {
      return c.json({ ok: false, error: "Tile not found" }, 404);
    }
    const tileId = listingRows[0].id;
    if (listingRows[0].status !== "listed") {
      return c.json({ ok: false, error: "Tile is not listed" }, 400);
    }

    // The bidder must not be the seller/owner of this tile.
    if (bidder === listingRows[0].seller || bidder === listingRows[0].owner) {
      return c.json(
        { ok: false, error: "You cannot make an offer on your own tile." },
        403
      );
    }

    // A bidder may only have ONE pending offer per tile. They can offer again
    // after their current offer is cancelled or declined.
    const existing = await db
      .select({ id: tileOffer.id })
      .from(tileOffer)
      .where(
        and(
          eq(tileOffer.tileId, tileId),
          eq(tileOffer.bidder, bidder),
          eq(tileOffer.status, "pending")
        )
      )
      .limit(1);
    if (existing.length > 0) {
      return c.json(
        {
          ok: false,
          error:
            "You already have an active offer on this tile. Cancel it first to make a new one.",
        },
        409
      );
    }

    const priceLamports = BigInt(Math.round(parseFloat(priceSol) * 1_000_000_000));
    const id = crypto.randomUUID();

    await db.insert(tileOffer).values({
      id,
      tileId,
      bidder,
      priceLamports,
      escrowTx,
      status: "pending",
      createdAt: new Date(),
    });

    return c.json({ ok: true, offerId: id });
  } catch (err) {
    console.error("Place offer failed:", err);
    return c.json({ ok: false, error: "Failed to place offer" }, 500);
  }
});

/**
 * Resolve the :id param (DB id or assetId) to a full listing row + db id.
 */
async function resolveListing(param: string) {
  const rows = await db
    .select()
    .from(tileListing)
    .where(or(eq(tileListing.id, param), eq(tileListing.assetId, param)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Refund a single pending offer's escrowed SOL back to its bidder.
 * Sets the offer status to `newStatus` and records the refund signature.
 */
async function refundOffer(
  off: typeof tileOffer.$inferSelect,
  newStatus: "declined" | "cancelled"
): Promise<void> {
  const refundSig = await sendSolFromCustodian({
    to: off.bidder,
    lamports: off.priceLamports,
  });
  await db
    .update(tileOffer)
    .set({ status: newStatus, refundTx: refundSig })
    .where(eq(tileOffer.id, off.id));
}

/**
 * POST /api/tiles/:id/offers/:offerId/approve
 * Seller approves an offer:
 *   1. Transfer the tile (from custodian) to the bidder.
 *   2. Send the escrowed SOL to the seller.
 *   3. Refund every OTHER pending offer on this tile (rule 6).
 *   4. Mark the listing sold.
 *
 * Body: { seller }  (the original owner, for authorization + payout)
 */
tiles.post("/:id/offers/:offerId/approve", async (c) => {
  try {
    const param = c.req.param("id");
    const offerId = c.req.param("offerId");
    const { seller } = await c.req.json();

    const listing = await resolveListing(param);
    if (!listing) return c.json({ ok: false, error: "Tile not found" }, 404);
    if (listing.seller !== seller || listing.status !== "listed") {
      return c.json({ ok: false, error: "Not allowed" }, 403);
    }

    const [offer] = await db
      .select()
      .from(tileOffer)
      .where(and(eq(tileOffer.id, offerId), eq(tileOffer.tileId, listing.id)))
      .limit(1);
    if (!offer) return c.json({ ok: false, error: "Offer not found" }, 404);
    if (offer.status !== "pending") {
      return c.json({ ok: false, error: `Offer already ${offer.status}` }, 400);
    }

    // The custodian must hold the tile on-chain to be able to transfer it. If
    // the listing predates the custody flow (custodian is null), the seller
    // must cancel the listing and re-list so the tile enters custody.
    if (!listing.custodian) {
      return c.json(
        {
          ok: false,
          error:
            "This listing was created before custody support. Cancel the listing and re-list it, then approve the offer.",
        },
        409
      );
    }

    // 1. Tile -> bidder (custodian signs).
    await transferCompressedTile({ assetId: listing.assetId, to: offer.bidder });
    // 2. Escrowed SOL -> seller (custodian signs).
    await sendSolFromCustodian({ to: seller, lamports: offer.priceLamports });

    // 3. Refund every other pending offer.
    const others = await db
      .select()
      .from(tileOffer)
      .where(and(eq(tileOffer.tileId, listing.id), eq(tileOffer.status, "pending")));
    for (const off of others) {
      if (off.id === offer.id) continue;
      await refundOffer(off, "declined");
    }

    // 4. Transfer ownership to the bidder. The tile becomes "owned" by the new
    //    owner (so it shows up in their account). priceLamports is updated to
    //    the purchase price so the account page reflects what they actually
    //    paid; soldAt is the purchase date. The saleEvent row is the durable log.
    await db
      .update(tileListing)
      .set({
        status: "owned",
        owner: offer.bidder,
        priceLamports: offer.priceLamports,
        seller: null,
        custodian: null,
        listingPriceLamports: null,
        listedAt: null,
        soldAt: new Date(),
      })
      .where(eq(tileListing.id, listing.id));
    await db
      .update(tileOffer)
      .set({ status: "accepted" })
      .where(eq(tileOffer.id, offer.id));

    // Record the secondary sale.
    await db.insert(saleEvent).values({
      id: crypto.randomUUID(),
      assetId: listing.assetId,
      type: "secondary",
      priceLamports: offer.priceLamports,
      buyer: offer.bidder,
      seller,
      createdAt: new Date(),
    });

    return c.json({ ok: true });
  } catch (err) {
    console.error("Approve offer failed:", err);
    return c.json({ ok: false, error: "Failed to approve offer" }, 500);
  }
});

/**
 * POST /api/tiles/:id/offers/:offerId/decline
 * Seller declines an offer: refund the escrowed SOL to the bidder.
 *
 * Body: { seller }
 */
tiles.post("/:id/offers/:offerId/decline", async (c) => {
  try {
    const param = c.req.param("id");
    const offerId = c.req.param("offerId");
    const { seller } = await c.req.json();

    const listing = await resolveListing(param);
    if (!listing) return c.json({ ok: false, error: "Tile not found" }, 404);
    if (listing.seller !== seller || listing.status !== "listed") {
      return c.json({ ok: false, error: "Not allowed" }, 403);
    }

    const [offer] = await db
      .select()
      .from(tileOffer)
      .where(and(eq(tileOffer.id, offerId), eq(tileOffer.tileId, listing.id)))
      .limit(1);
    if (!offer) return c.json({ ok: false, error: "Offer not found" }, 404);
    if (offer.status !== "pending") {
      return c.json({ ok: false, error: `Offer already ${offer.status}` }, 400);
    }

    await refundOffer(offer, "declined");
    return c.json({ ok: true });
  } catch (err) {
    console.error("Decline offer failed:", err);
    return c.json({ ok: false, error: "Failed to decline offer" }, 500);
  }
});

/**
 * POST /api/tiles/:id/offers/:offerId/cancel
 * Bidder cancels their own offer: refund the escrowed SOL back to them.
 *
 * Body: { bidder }
 */
tiles.post("/:id/offers/:offerId/cancel", async (c) => {
  try {
    const param = c.req.param("id");
    const offerId = c.req.param("offerId");
    const { bidder } = await c.req.json();

    const listing = await resolveListing(param);
    if (!listing) return c.json({ ok: false, error: "Tile not found" }, 404);

    const [offer] = await db
      .select()
      .from(tileOffer)
      .where(and(eq(tileOffer.id, offerId), eq(tileOffer.tileId, listing.id)))
      .limit(1);
    if (!offer) return c.json({ ok: false, error: "Offer not found" }, 404);
    if (offer.bidder !== bidder) {
      return c.json({ ok: false, error: "Not allowed" }, 403);
    }
    if (offer.status !== "pending") {
      return c.json({ ok: false, error: `Offer already ${offer.status}` }, 400);
    }

    await refundOffer(offer, "cancelled");
    return c.json({ ok: true });
  } catch (err) {
    console.error("Cancel offer failed:", err);
    return c.json({ ok: false, error: "Failed to cancel offer" }, 500);
  }
});

/**
 * POST /api/tiles/:id/buy
 * Instant buy: a buyer purchases a listed tile at its listing price without
 * waiting for seller approval. The buyer must have ALREADY transferred the
 * listing price (in SOL) into the custodian (dev wallet) on-chain; that
 * signature is passed here as `signature`.
 *
 * Settlement (custodian-driven, no seller online required):
 *   1. Transfer the tile to the buyer.
 *   2. Send the listing SOL to the seller.
 *   3. Refund every pending offer on this tile (rule 6).
 *   4. Mark the listing owned by the buyer + record the sale.
 *
 * Body: { buyer, signature }
 */
tiles.post("/:id/buy", async (c) => {
  try {
    const param = c.req.param("id");
    const { buyer, signature } = await c.req.json();

    if (!buyer || !signature) {
      return c.json({ ok: false, error: "Invalid inputs" }, 400);
    }

    const listing = await resolveListing(param);
    if (!listing) return c.json({ ok: false, error: "Tile not found" }, 404);
    if (listing.status !== "listed") {
      return c.json({ ok: false, error: "Tile is not listed" }, 400);
    }
    // The custodian must hold the tile on-chain to transfer it.
    if (!listing.custodian) {
      return c.json(
        {
          ok: false,
          error:
            "This listing was created before custody support and cannot be bought.",
        },
        409
      );
    }
    if (!listing.seller) {
      return c.json({ ok: false, error: "Listing has no seller" }, 400);
    }
    const seller = listing.seller;
    if (!listing.listingPriceLamports) {
      return c.json({ ok: false, error: "Listing has no price" }, 400);
    }
    const priceLamports = listing.listingPriceLamports;

    // The buyer must not already own the tile.
    if (listing.owner === buyer) {
      return c.json({ ok: false, error: "You already own this tile" }, 400);
    }

    // Narrow the race window: re-check the listing is still "listed" right
    // before the expensive on-chain transfer. If another buyer just purchased
    // it, refund this buyer's locked SOL instead of settling.
    const [fresh] = await db
      .select({ status: tileListing.status })
      .from(tileListing)
      .where(eq(tileListing.id, listing.id))
      .limit(1);
    if (!fresh || fresh.status !== "listed") {
      await sendSolFromCustodian({ to: buyer, lamports: priceLamports }).catch(
        (e) => console.error("Failed to refund after race loss:", e)
      );
      return c.json(
        { ok: false, error: "Tile was just purchased by someone else." },
        409
      );
    }

    // 1. Tile -> buyer (custodian signs).
    await transferCompressedTile({ assetId: listing.assetId, to: buyer });
    // 2. Listing SOL -> seller (custodian signs).
    await sendSolFromCustodian({ to: seller, lamports: priceLamports });

    // 3. Refund every pending offer.
    const pendingOffers = await db
      .select()
      .from(tileOffer)
      .where(and(eq(tileOffer.tileId, listing.id), eq(tileOffer.status, "pending")));
    for (const off of pendingOffers) {
      await refundOffer(off, "declined");
    }

    // 4. Transfer ownership to the buyer + record the sale.
    await db
      .update(tileListing)
      .set({
        status: "owned",
        owner: buyer,
        priceLamports,
        seller: null,
        custodian: null,
        listingPriceLamports: null,
        listedAt: null,
        soldAt: new Date(),
      })
      .where(eq(tileListing.id, listing.id));

    await db.insert(saleEvent).values({
      id: crypto.randomUUID(),
      assetId: listing.assetId,
      type: "secondary",
      priceLamports,
      buyer,
      seller,
      txSignature: signature,
      createdAt: new Date(),
    });

    return c.json({ ok: true });
  } catch (err) {
    console.error("Buy tile failed:", err);
    return c.json({ ok: false, error: "Failed to buy tile" }, 500);
  }
});
