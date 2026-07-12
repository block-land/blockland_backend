/**
 * Blockland Solana service: Irys upload + Bubblegum mint + SOL transfer.
 *
 * This runs on the backend (co-sign model): the backend holds the admin
 * keypair (tree authority) and co-signs the mint transaction. The buyer
 * also signs (for the SOL payment + as the cNFT recipient).
 */

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  mintV1,
  mplBubblegum,
  parseLeafFromMintV1Transaction,
  findLeafAssetIdPda,
} from "@metaplex-foundation/mpl-bubblegum";
import { publicKey, keypairIdentity, none } from "@metaplex-foundation/umi";
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "fs";
import path from "path";
import os from "os";

const RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

/**
 * Active Solana cluster. Controls Irys upload target (and any cluster-specific
 * behavior). Set via SOLANA_CLUSTER env: "devnet" | "mainnet-beta".
 * Defaults to devnet so forgetting the var never routes to mainnet by accident.
 */
const SOLANA_CLUSTER =
  process.env.SOLANA_CLUSTER ?? "devnet";
if (SOLANA_CLUSTER !== "devnet" && SOLANA_CLUSTER !== "mainnet-beta") {
  throw new Error(
    `Invalid SOLANA_CLUSTER="${SOLANA_CLUSTER}". Expected "devnet" or "mainnet-beta".`
  );
}
const IS_MAINNET = SOLANA_CLUSTER === "mainnet-beta";

const MERKLE_TREE =
  process.env.MERKLE_TREE ?? "89A62B9Bn45Nofa5CQXFUdyPPuo5Eth3rJkB288XWWGz";

const COLLECTION_MINT =
  process.env.COLLECTION_MINT ?? "FAtKx1TCQ9HZzoEfpo8DGatb9s6qUypQXJ7UvZWS1zSc";

const TREASURY =
  process.env.TREASURY ?? "4JDGwFWszhntY6N47r2u7QFjGRqeG8A8Pc3wgUkVY1mX";

/** Tile price in USD. */
export const TILE_PRICE_USD = 0.2;

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Fetch the current SOL/USD price from CoinGecko (free, no auth).
 * Returns the price as a number (e.g. 78.5).
 * Falls back to a sensible default if the API is unreachable.
 */
export async function getSolUsdPrice(): Promise<number> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json();
    const price = data?.solana?.usd;
    if (typeof price === "number" && price > 0) return price;
  } catch {
    // ignore — fall back
  }
  // Fallback: assume $78 if API fails (dev safety net)
  return 78;
}

/**
 * Convert a USD amount to lamports using the live SOL price.
 */
export async function usdToLamports(usd: number): Promise<number> {
  const solPrice = await getSolUsdPrice();
  const sol = usd / solPrice;
  return Math.round(sol * LAMPORTS_PER_SOL);
}

function getAdminWalletBytes(): Uint8Array {
  if (process.env.ADMIN_WALLET_JSON) {
    try {
      const raw = JSON.parse(process.env.ADMIN_WALLET_JSON);
      return Uint8Array.from(raw);
    } catch (e) {
      console.error("Failed to parse ADMIN_WALLET_JSON environment variable:", e);
    }
  }
  const walletPath =
    process.env.ADMIN_WALLET_PATH ??
    path.join("/Users/barra/Apps/blockland/dev.json");
  const raw = JSON.parse(readFileSync(walletPath, "utf-8"));
  return Uint8Array.from(raw);
}

function loadAdminKeypair(): Keypair {
  const bytes = getAdminWalletBytes();
  return Keypair.fromSecretKey(bytes);
}

/**
 * Upload image + metadata JSON to Irys.
 * Returns the metadata URI (arweave/irys gateway URL).
 *
 * Uses @irys/upload + @irys/upload-solana. Upload target follows the active
 * SOLANA_CLUSTER (devnet is free for small files; mainnet is paid).
 */
export async function uploadToIrys(
  imageBase64: string,
  metadata: {
    name: string;
    description: string;
    lat: number;
    lng: number;
    rarity: string;
  }
): Promise<{ metadataUri: string; imageUri: string }> {
  const { Uploader } = await import("@irys/upload");
  const { Solana } = await import("@irys/upload-solana");
  const { writeFileSync, unlinkSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");

  // Load admin keypair as raw bytes for the Irys wallet
  const walletBytes = getAdminWalletBytes();

  // Irys upload target follows the active cluster (devnet free / mainnet paid).
  const irysBuilder = Uploader(Solana)
    .withWallet(walletBytes)
    .withRpc(RPC_URL)
    .network(IS_MAINNET ? "mainnet" : "devnet");
  const irys = await irysBuilder;

  // 1. Write image to temp file + upload
  const imagePath = join(tmpdir(), `blockland-tile-${Date.now()}.png`);
  writeFileSync(imagePath, Buffer.from(imageBase64, "base64"));

  let imageId: string;
  try {
    const imageReceipt = await irys.uploadFile(imagePath, [
      { name: "Content-Type", value: "image/png" },
    ]);
    imageId = imageReceipt.id;
  } finally {
    unlinkSync(imagePath);
  }
  const imageUri = `https://arweave.net/${imageId}`;

  // 2. Build metadata JSON + upload
  const metadataJson = {
    name: metadata.name,
    symbol: "BLT",
    description: metadata.description,
    image: imageUri,
    attributes: [
      { trait_type: "latitude", value: metadata.lat },
      { trait_type: "longitude", value: metadata.lng },
      { trait_type: "rarity", value: metadata.rarity },
    ],
    properties: {
      files: [{ uri: imageUri, type: "image/png" }],
      category: "image",
    },
  };

  const metaPath = join(tmpdir(), `blockland-meta-${Date.now()}.json`);
  writeFileSync(metaPath, JSON.stringify(metadataJson));

  let metaId: string;
  try {
    const metaReceipt = await irys.uploadFile(metaPath, [
      { name: "Content-Type", value: "application/json" },
      { name: "App-Name", value: "Blockland" },
    ]);
    metaId = metaReceipt.id;
  } finally {
    unlinkSync(metaPath);
  }
  const metadataUri = `https://arweave.net/${metaId}`;

  return { metadataUri, imageUri };
}

/**
 * Mint a compressed NFT to the buyer's wallet via Bubblegum.
 * The admin (backend) co-signs as the tree authority.
 */
export async function mintCompressedTile(
  buyerWallet: string,
  metadataUri: string,
  tileName: string
): Promise<{ assetId: string; signature: string }> {
  const admin = loadAdminKeypair();

  const umi = createUmi(RPC_URL);
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(admin.secretKey);
  umi.use(keypairIdentity(umiKeypair));
  umi.use(mplBubblegum());

  const buyerPk = publicKey(buyerWallet);

  const builder = await mintV1(umi, {
    leafOwner: buyerPk,
    merkleTree: publicKey(MERKLE_TREE),
    metadata: {
      name: tileName,
      symbol: "BLT",
      uri: metadataUri,
      sellerFeeBasisPoints: 0,
      collection: none(),
      creators: [],
    },
  });

  const result = await builder.sendAndConfirm(umi);
  const signature = result.signature.toString();

  // Parse the leaf from the tx to derive the unique asset ID
  let leaf;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      leaf = await parseLeafFromMintV1Transaction(umi, result.signature);
      if (leaf) break;
    } catch (e) {
      if (attempt === 5) throw e;
      console.warn(`Attempt ${attempt} to parse leaf failed, retrying...`);
    }
  }

  if (!leaf) {
    throw new Error("Could not parse leaf from transaction after multiple attempts");
  }

  const [assetPda] = findLeafAssetIdPda(umi, {
    merkleTree: publicKey(MERKLE_TREE),
    leafIndex: leaf.nonce,
  });

  return {
    assetId: assetPda.toString(),
    signature,
  };
}

/**
 * Full mint flow: upload to Irys + mint cNFT.
 */
export async function mintTile(params: {
  buyer: string;
  lat: number;
  lng: number;
  rarity: string;
  imageBase64: string;
  tileName: string;
  priceLamports: number;
}): Promise<{
  assetId: string;
  signature: string;
  metadataUri: string;
  imageUri: string;
}> {
  const { metadataUri, imageUri } = await uploadToIrys(
    params.imageBase64,
    {
      name: params.tileName,
      description: `Map coordinate at ${params.lat}, ${params.lng}`,
      lat: params.lat,
      lng: params.lng,
      rarity: params.rarity,
    }
  );

  const { assetId, signature } = await mintCompressedTile(
    params.buyer,
    metadataUri,
    params.tileName
  );

  return { assetId, signature, metadataUri, imageUri };
}
