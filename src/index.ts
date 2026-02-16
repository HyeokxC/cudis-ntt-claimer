import "dotenv/config";

import * as fs from "node:fs";
import * as path from "node:path";
import { getAccount } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { deserialize, signSendWait, toNative, toUniversal, type VAA, wormhole } from "@wormhole-foundation/sdk";
import { getSolanaSignAndSendSigner } from "@wormhole-foundation/sdk-solana";
import solana from "@wormhole-foundation/sdk/solana";
import "@wormhole-foundation/sdk-solana-ntt";

interface Config {
  solanaRpcUrl: string;
  solanaPrivateKey: string;
  custodyAddress: string;
  requiredAmountRaw: bigint;
  requiredAmountDisplay: string;
  nttProgramId: string;
  tokenMint: string;
  emitterChain: number;
  emitterAddress: string;
  sequence: bigint;
  pollIntervalMs: number;
}

const CUDIS_DECIMALS = 9;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
type NttAttestation = VAA<"Ntt:WormholeTransfer"> | VAA<"Ntt:WormholeTransferStandardRelayer">;

type LogLevel = "INFO" | "WARN" | "ERROR";

const LOG_DIR = path.resolve(process.cwd(), "logs");

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `claimer-${date}.log`);
}

function log(message: string, level: LogLevel = "INFO"): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}`;
  console.log(line);

  try {
    ensureLogDir();
    fs.appendFileSync(getLogFilePath(), line + "\n", "utf-8");
  } catch (_fileWriteError: unknown) {
    void _fileWriteError;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePositiveInteger(name: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

function decimalToRawAmount(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }

  const [wholePart, fractionalPart = ""] = value.split(".");
  if (fractionalPart.length > decimals) {
    throw new Error(`Amount ${value} has more than ${decimals} decimal places`);
  }

  const paddedFraction = fractionalPart.padEnd(decimals, "0");
  const normalized = `${wholePart}${paddedFraction}`.replace(/^0+/, "") || "0";
  return BigInt(normalized);
}

function normalizeEmitterAddressForSdk(emitterHex32: string): string {
  const clean = emitterHex32.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`EMITTER_ADDRESS must be 20-byte or 32-byte hex: ${emitterHex32}`);
  }
  const evm20 = clean.slice(-40);
  return `0x${evm20}`;
}

function loadConfig(): Config {
  const requiredAmountDisplay = requireEnv("REQUIRED_AMOUNT");
  const requiredAmountRaw = decimalToRawAmount(requiredAmountDisplay, CUDIS_DECIMALS);

  const sequenceRaw = requireEnv("SEQUENCE");
  if (!/^\d+$/.test(sequenceRaw)) {
    throw new Error(`SEQUENCE must be an unsigned integer, got: ${sequenceRaw}`);
  }

  return {
    solanaRpcUrl: requireEnv("SOLANA_RPC_URL"),
    solanaPrivateKey: requireEnv("SOLANA_PRIVATE_KEY"),
    custodyAddress: requireEnv("CUSTODY_ADDRESS"),
    requiredAmountRaw,
    requiredAmountDisplay,
    nttProgramId: requireEnv("NTT_PROGRAM_ID"),
    tokenMint: requireEnv("TOKEN_MINT"),
    emitterChain: parsePositiveInteger("EMITTER_CHAIN", requireEnv("EMITTER_CHAIN")),
    emitterAddress: requireEnv("EMITTER_ADDRESS"),
    sequence: BigInt(sequenceRaw),
    pollIntervalMs: parsePositiveInteger("POLL_INTERVAL_MS", requireEnv("POLL_INTERVAL_MS")),
  };
}

async function getCustodyBalance(
  connection: Connection,
  custodyAddress: string,
): Promise<{ rawAmount: bigint; uiAmountString: string }> {
  const account = new PublicKey(custodyAddress);
  const balance = await connection.getTokenAccountBalance(account, "confirmed");
  return {
    rawAmount: BigInt(balance.value.amount),
    uiAmountString: balance.value.uiAmountString ?? "0",
  };
}

async function validateCustodyTokenAccount(
  connection: Connection,
  custodyAddress: string,
  tokenMint: string,
): Promise<void> {
  const custodyAccount = await getAccount(connection, new PublicKey(custodyAddress), "confirmed");
  const onChainMint = custodyAccount.mint.toBase58();
  if (onChainMint !== tokenMint) {
    throw new Error(
      `Custody account mint mismatch. expected=${tokenMint}, onchain=${onChainMint}`,
    );
  }
}

function decodeNttAttestation(vaaBytes: Uint8Array): NttAttestation {
  try {
    return deserialize("Ntt:WormholeTransfer", vaaBytes);
  } catch {
    return deserialize("Ntt:WormholeTransferStandardRelayer", vaaBytes);
  }
}

async function fetchSignedVaaAttestation(
  wh: Awaited<ReturnType<typeof wormhole>>,
  config: Config,
): Promise<NttAttestation> {

  const emitter = normalizeEmitterAddressForSdk(config.emitterAddress);
  const messageId = {
    chain: "Bsc" as const,
    emitter: toUniversal("Bsc", emitter),
    sequence: config.sequence,
  };

  log(
    `Fetching signed VAA from Wormhole SDK (chain=${config.emitterChain}, emitter=${config.emitterAddress}, sequence=${config.sequence.toString()})`,
  );

  const sdkVaa = await wh.getVaa(messageId, "Ntt:WormholeTransfer", 60_000);
  if (sdkVaa) {
    log("Fetched signed VAA from Wormhole SDK");
    return sdkVaa;
  }

  const url = `https://api.wormholescan.io/api/v1/vaas/${config.emitterChain}/${config.emitterAddress}/${config.sequence.toString()}`;
  log(`SDK did not return VAA within timeout, falling back to Wormholescan API: ${url}`);

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Wormholescan API request failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { data?: { vaa?: string } };
  const vaaBase64 = body.data?.vaa;
  if (!vaaBase64) {
    throw new Error("Wormholescan API response missing data.vaa");
  }

  const bytes = Uint8Array.from(Buffer.from(vaaBase64, "base64"));
  if (bytes.length === 0) {
    throw new Error("Decoded VAA bytes are empty");
  }

  log("Fetched and decoded signed VAA from Wormholescan API fallback");
  return decodeNttAttestation(bytes);
}

async function fetchAndRedeem(config: Config, connection: Connection): Promise<string[]> {
  log("Initializing Wormhole SDK and Solana NTT protocol");
  const wh = await wormhole("Mainnet", [solana]);
  const chain = wh.getChain("Solana");

  const ntt = await chain.getProtocol("Ntt", {
    ntt: {
      manager: config.nttProgramId,
      token: config.tokenMint,
      transceiver: {
        wormhole: config.nttProgramId,
      },
    },
  });

  const vaa = await fetchSignedVaaAttestation(wh, config);

  log("Creating Solana signer from base58 private key");
  const signer = await getSolanaSignAndSendSigner(connection, config.solanaPrivateKey);
  const payerAddress = toNative("Solana", signer.address());

  log("Submitting redeem flow (postVaa, redeem, releaseInboundUnlock)");
  const txids = await signSendWait(chain, ntt.redeem([vaa], payerAddress), signer);
  const txidStrings = txids.map((tx) => tx.txid);

  log(`Redeem flow completed with ${txidStrings.length} transaction(s): ${txidStrings.join(", ")}`);
  return txidStrings;
}

async function redeemWithRetry(config: Config, connection: Connection): Promise<void> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      log(`Redeem attempt ${attempt}`);
      await fetchAndRedeem(config, connection);
      log("Redeem succeeded");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Redeem attempt ${attempt} failed: ${message}`, "ERROR");

      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      log(`Waiting ${delay}ms before next retry`, "WARN");
      await sleep(delay);
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const connection = new Connection(config.solanaRpcUrl, "confirmed");

  await validateCustodyTokenAccount(connection, config.custodyAddress, config.tokenMint);

  log("Starting CUDIS NTT claimer");
  log(`Custody account: ${config.custodyAddress}`);
  log(`Required amount: ${config.requiredAmountDisplay} CUDIS`);
  log(`Poll interval: ${config.pollIntervalMs}ms`);

  let running = true;
  const handleShutdown = (signal: NodeJS.Signals): void => {
    if (!running) {
      return;
    }
    running = false;
    log(`Received ${signal}, shutting down after current cycle`);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  while (running) {
    try {
      const balance = await getCustodyBalance(connection, config.custodyAddress);
      const hasEnough = balance.rawAmount >= config.requiredAmountRaw;
      log(
        `Custody balance: ${balance.uiAmountString} CUDIS (raw=${balance.rawAmount.toString()}) | threshold raw=${config.requiredAmountRaw.toString()} | sufficient=${hasEnough}`,
      );

      if (hasEnough) {
        log("Balance threshold reached; beginning redeem sequence");
        await redeemWithRetry(config, connection);
        log("Claim completed successfully; exiting");
        process.exit(0);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Polling cycle error: ${message}`, "ERROR");
    }

    if (!running) {
      break;
    }

    await sleep(config.pollIntervalMs);
  }

  log("Exited without claiming due to shutdown signal");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  log(`Fatal error: ${message}`, "ERROR");
  process.exit(1);
});
