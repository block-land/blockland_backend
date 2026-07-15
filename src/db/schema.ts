import { pgTable, text, timestamp, boolean, integer, bigint, numeric } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

// ---- Blockland domain tables ----

/** A minted map tile (compressed NFT). */
export const tileListing = pgTable("tile_listing", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull().unique(),
  h3Cell: text("h3_cell").notNull().unique(), // H3 index (resolution 7)
  lat: numeric("lat", { precision: 9, scale: 6 }).notNull(),
  lng: numeric("lng", { precision: 9, scale: 6 }).notNull(),
  rarity: text("rarity").notNull(),
  status: text("status").notNull().default("owned"), // owned | listed | sold
  seller: text("seller"),
  owner: text("owner").notNull(),
  priceLamports: bigint("price_lamports", { mode: "bigint" }),
  listingPriceLamports: bigint("listing_price_lamports", { mode: "bigint" }),
  metadataUri: text("metadata_uri"),
  imageUri: text("image_uri"),
  txSignature: text("tx_signature"),
  listedAt: timestamp("listed_at"),
  soldAt: timestamp("sold_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** A log of every sale (primary or secondary). */
export const saleEvent = pgTable("sale_event", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull(),
  type: text("type").notNull(), // primary | secondary
  priceLamports: bigint("price_lamports", { mode: "bigint" }).notNull(),
  buyer: text("buyer").notNull(),
  seller: text("seller"),
  txSignature: text("tx_signature"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** User profile details mapped to their Solana wallet address. */
export const clientDetails = pgTable("client_details", {
  id: text("id").primaryKey(),
  walletAddress: text("wallet_address").notNull().unique(),
  username: text("username").notNull(),
  photoUrl: text("photo_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Active bids/offers on listed marketplace tiles. */
export const tileOffer = pgTable("tile_offer", {
  id: text("id").primaryKey(),
  tileId: text("tile_id")
    .notNull()
    .references(() => tileListing.id, { onDelete: "cascade" }),
  bidder: text("bidder").notNull(),
  priceLamports: bigint("price_lamports", { mode: "bigint" }).notNull(),
  txSignature: text("tx_signature"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
