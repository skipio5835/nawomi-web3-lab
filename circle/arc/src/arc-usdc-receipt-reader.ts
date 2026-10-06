import { createPublicClient, http, type Hex } from "viem";
import { normalizeUsdcReceipt, type UsdcReceipt } from "./arc-usdc-events.js";

export const RECEIPT_NETWORKS = {
  "arc-mainnet": { name: "Arc Mainnet", chainId: 5042, rpc: "https://rpc.mainnet.arc.io", explorer: "https://explorer.arc.io" },
  "arc-testnet": { name: "Arc Testnet", chainId: 5042002, rpc: "https://rpc.testnet.arc.io", explorer: "https://explorer.testnet.arc.io" },
} as const;
export type ReceiptNetwork = keyof typeof RECEIPT_NETWORKS;
export type ReceiptErrorCode = "input" | "network" | "integrity" | "not-found" | "unavailable";
export class ReceiptLookupError extends Error {
  constructor(readonly code: ReceiptErrorCode) { super(code); }
}
type ReceiptTransaction = { hash: string; from: string; to: string | null; value: bigint; blockHash: string | null; blockNumber: bigint | null };
export type ReceiptClient = {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: Hex }): Promise<UsdcReceipt & { contractAddress?: string | null }>;
  getTransaction(args: { hash: Hex }): Promise<ReceiptTransaction>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: string | null; number: bigint | null; timestamp: bigint; transactions: readonly (string | { hash: string })[] }>;
};
const hashValid = (value: string) => /^0x[\da-f]{64}$/i.test(value);
const addressValid = (value: string) => /^0x[\da-f]{40}$/i.test(value);
const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

export async function readUsdcReceipt(networkId: ReceiptNetwork, hash: string, wallet = "", signal?: AbortSignal, suppliedClient?: ReceiptClient) {
  if (!Object.hasOwn(RECEIPT_NETWORKS, networkId) || !hashValid(hash) || wallet && !addressValid(wallet)) throw new ReceiptLookupError("input");
  const network = RECEIPT_NETWORKS[networkId];
  const client: ReceiptClient = suppliedClient ?? createPublicClient({ transport: http(network.rpc, {
    retryCount: 0, timeout: 10_000, fetchOptions: { signal, credentials: "omit", referrerPolicy: "no-referrer" },
  }) });
  try {
    signal?.throwIfAborted();
    if (await client.getChainId() !== network.chainId) throw new ReceiptLookupError("network");
    const [receipt, transaction] = await Promise.all([
      client.getTransactionReceipt({ hash: hash as Hex }), client.getTransaction({ hash: hash as Hex }),
    ]);
    if (!same(receipt.transactionHash, hash) || !same(transaction.hash, hash)
      || !same(transaction.from, receipt.from) || !same(transaction.blockHash, receipt.blockHash)
      || transaction.blockNumber !== receipt.blockNumber || typeof transaction.value !== "bigint" || transaction.value < 0n) throw new ReceiptLookupError("integrity");
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (!same(block.hash, receipt.blockHash) || block.number !== receipt.blockNumber
      || !block.transactions.some(item => same(typeof item === "string" ? item : item.hash, hash))
      || typeof block.timestamp !== "bigint" || block.timestamp < 0n || block.timestamp > BigInt(Math.floor(Date.now() / 1000) + 30)) throw new ReceiptLookupError("integrity");
    const full = normalizeUsdcReceipt(receipt);
    // A successful native-value send cannot be reported as zero if its system log is missing.
    const recipient = transaction.to ?? receipt.contractAddress;
    if (receipt.status === "success" && transaction.value > 0n && !same(recipient, transaction.from)) {
      if (!recipient || !addressValid(recipient) || !full.movements.some(movement => same(movement.from, transaction.from)
        && same(movement.to, recipient) && movement.units18 === transaction.value)) throw new ReceiptLookupError("integrity");
    }
    signal?.throwIfAborted();
    return { networkId, network, blockTimestamp: Number(block.timestamp), checkedAt: Date.now(), wallet,
      ledger: wallet ? normalizeUsdcReceipt(receipt, wallet) : full };
  } catch (error) {
    if (error instanceof ReceiptLookupError || signal?.aborted) throw error;
    if (error instanceof Error && ["TransactionReceiptNotFoundError", "TransactionNotFoundError"].includes(error.name)) throw new ReceiptLookupError("not-found");
    throw new ReceiptLookupError("unavailable");
  }
}
export type ReceiptResult = Awaited<ReturnType<typeof readUsdcReceipt>>;
