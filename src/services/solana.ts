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
  getAssetWithProof,
  transfer as transferInstruction,
} from "@metaplex-foundation/mpl-bubblegum";
import { dasApi } from "@metaplex-foundation/digital-asset-standard-api";
import {
  publicKey,
  keypairIdentity,
  none,
  createNoopSigner,
} from "@metaplex-foundation/umi";
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
 * Dev (custodian) wallet that holds tiles + escrowed SOL while a tile is listed
 * on the marketplace. This lets the backend transfer the tile and settle offers
 * without the seller being online.
 *
 * Configurable via DEV_WALLET_JSON (raw key array) or DEV_WALLET_PATH (file).
 * Falls back to the admin wallet so the app still works in a single-key dev setup.
 */
function getDevWalletBytes(): Uint8Array {
  if (process.env.DEV_WALLET_JSON) {
    try {
      return Uint8Array.from(JSON.parse(process.env.DEV_WALLET_JSON));
    } catch (e) {
      console.error("Failed to parse DEV_WALLET_JSON:", e);
    }
  }
  if (process.env.DEV_WALLET_PATH) {
    return Uint8Array.from(JSON.parse(readFileSync(process.env.DEV_WALLET_PATH, "utf-8")));
  }
  // Fallback: reuse the admin wallet (single-key dev setup).
  return getAdminWalletBytes();
}

export function loadDevKeypair(): Keypair {
  return Keypair.fromSecretKey(getDevWalletBytes());
}

/** Public address of the custodian (dev) wallet. */
export function devWalletAddress(): string {
  return loadDevKeypair().publicKey.toBase58();
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
  const imageUri = `https://gateway.irys.xyz/${imageId}`;

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
  const metadataUri = `https://gateway.irys.xyz/${metaId}`;

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

/**
 * Build a Umi instance wired with the Bubblegum program + DAS RPC, identified
 * by the given secret-key bytes (used for backend-driven cNFT transfers).
 */
function umiWithBubblegum(secretKey: Uint8Array) {
  const umi = createUmi(RPC_URL);
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(secretKey);
  umi.use(keypairIdentity(umiKeypair));
  umi.use(mplBubblegum());
  umi.use(dasApi());
  return umi;
}

/**
 * Transfer a compressed NFT (tile) to a new owner, signed by the custodian
 * (dev wallet). The dev wallet must currently be the leaf owner — i.e. the
 * seller must have listed the tile into custody first.
 *
 * Returns the transaction signature.
 */
export async function transferCompressedTile(params: {
  assetId: string;
  to: string; // new owner (bidder/buyer) public key
}): Promise<string> {
  const umi = umiWithBubblegum(getDevWalletBytes());
  const devPk = loadDevKeypair().publicKey.toBase58();

  const assetWithProof = await getAssetWithProof(
    umi,
    publicKey(params.assetId)
  );

  const builder = transferInstruction(umi, {
    merkleTree: publicKey(MERKLE_TREE),
    root: assetWithProof.root,
    dataHash: assetWithProof.dataHash,
    creatorHash: assetWithProof.creatorHash,
    nonce: assetWithProof.nonce,
    index: assetWithProof.index,
    proof: assetWithProof.proof,
    leafOwner: publicKey(devPk),
    newLeafOwner: publicKey(params.to),
  });

  const result = await builder.sendAndConfirm(umi, { send: { commitment: "confirmed" } });
  return result.signature.toString();
}

/**
 * Build (but do NOT sign/submit) a transaction that transfers a tile from the
 * seller into the custodian (dev) wallet. This is the on-chain "listing" step.
 *
 * The returned base64 transaction bytes are sent to the frontend, where the
 * seller signs with their wallet (they are the current leaf owner). After the
 * frontend submits it, the backend records the custodian and listing price.
 */
export async function buildListToCustodyTx(params: {
  assetId: string;
  seller: string; // current owner, must sign on the frontend
  custodian: string; // dev wallet that will hold the tile
}): Promise<string> {
  const umi = createUmi(RPC_URL);
  umi.use(mplBubblegum());
  umi.use(dasApi());

  const assetWithProof = await getAssetWithProof(
    umi,
    publicKey(params.assetId)
  );

  const sellerSigner = createNoopSigner(publicKey(params.seller));

  // Seller is the leaf owner and must sign on the client — use a noop signer
  // so the builder leaves their signature slot open for the wallet to fill.
  const builder = transferInstruction(umi, {
    merkleTree: publicKey(MERKLE_TREE),
    root: assetWithProof.root,
    dataHash: assetWithProof.dataHash,
    creatorHash: assetWithProof.creatorHash,
    nonce: assetWithProof.nonce,
    index: assetWithProof.index,
    proof: assetWithProof.proof,
    leafOwner: sellerSigner,
    newLeafOwner: publicKey(params.custodian),
  })
    .setFeePayer(sellerSigner)
    .setBlockhash((await umi.rpc.getLatestBlockhash()).blockhash);

  // Build the unsigned transaction, then fully serialize it as base64 so the
  // frontend wallet can sign + submit it.
  const transaction = builder.build(umi);
  const serialized = umi.transactions.serialize(transaction);
  return Buffer.from(serialized).toString("base64");
}

/**
 * Move SOL from the custodian (dev wallet) to a recipient. Used to settle an
 * accepted offer (SOL -> seller) and to refund cancelled/declined/lost offers
 * (SOL -> bidder). The dev wallet signs and pays the fee.
 *
 * Returns the transaction signature.
 */
export async function sendSolFromCustodian(params: {
  to: string;
  lamports: bigint;
}): Promise<string> {
  const dev = loadDevKeypair();
  const { Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } =
    await import("@solana/web3.js");
  const connection = new Connection(RPC_URL, "confirmed");

  const ix = SystemProgram.transfer({
    fromPubkey: dev.publicKey,
    toPubkey: new PublicKey(params.to),
    lamports: Number(params.lamports),
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: dev.publicKey, blockhash, lastValidBlockHeight });
  tx.add(ix);

  const sig = await sendAndConfirmTransaction(connection, tx, [dev]);
  return sig;
}
