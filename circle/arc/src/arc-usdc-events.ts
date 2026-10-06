import { decodeEventLog, parseAbi, type Hex } from "viem";

export const USDC_SYSTEM = "0xfffffffffffffffffffffffffffffffffffffffe";
export const USDC_ERC20 = "0x3600000000000000000000000000000000000000";
const LEGACY_SYSTEM = "0x1800000000000000000000000000000000000000";
const ZERO = "0x0000000000000000000000000000000000000000";
export const USDC_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRANSFER_ABI = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const validHash = (value: string) => /^0x[\da-f]{64}$/i.test(value);
const validAddress = (value: string) => /^0x[\da-f]{40}$/i.test(value);

export type UsdcReceipt = {
  transactionHash: string; blockHash: string; blockNumber: bigint; status: string; from: string;
  gasUsed: bigint; effectiveGasPrice: bigint;
  logs: readonly {
    address: string; topics: readonly string[]; data: string; logIndex: number | null;
    transactionHash: string | null; blockHash: string | null; blockNumber: bigint | null; removed?: boolean;
  }[];
};
export type UsdcMovement = {
  from: string; to: string; units18: bigint; logIndex: number; erc20LogIndex?: number;
  kind: "transfer" | "mint" | "burn";
};

export function normalizeUsdcReceipt(receipt: UsdcReceipt, wallet?: string) {
  if (!validHash(receipt.transactionHash) || !validHash(receipt.blockHash) || !validAddress(receipt.from)
    || typeof receipt.blockNumber !== "bigint" || receipt.blockNumber < 0n || !Array.isArray(receipt.logs) || receipt.logs.length > 4096
    || !["success", "reverted"].includes(receipt.status) || (wallet !== undefined && !validAddress(wallet))) {
    throw new Error("Invalid confirmed receipt or wallet address.");
  }
  if (receipt.status === "reverted" && receipt.logs.length) throw new Error("Reverted receipt contains unexpected logs.");
  const native: UsdcMovement[] = [];
  const erc20: UsdcMovement[] = [];
  const seen = new Map<number, string>();
  let legacy = false;
  let ignoredNonMovements = 0;
  for (const log of receipt.logs) {
    if (!validAddress(log.address)) throw new Error("Invalid receipt log address.");
    const emitter = log.address.toLowerCase();
    if (!Number.isSafeInteger(log.logIndex) || log.logIndex! < 0 || log.removed
      || log.transactionHash?.toLowerCase() !== receipt.transactionHash.toLowerCase()
      || log.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() || log.blockNumber !== receipt.blockNumber) {
      throw new Error("USDC log identity does not match the confirmed receipt.");
    }
    const fingerprint = JSON.stringify([emitter, log.topics, log.data]).toLowerCase();
    const previous = seen.get(log.logIndex!);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error("Conflicting USDC logs share the same event index.");
      continue;
    }
    seen.set(log.logIndex!, fingerprint);
    if (emitter !== USDC_SYSTEM && emitter !== USDC_ERC20 && emitter !== LEGACY_SYSTEM) continue;
    if (emitter === LEGACY_SYSTEM) { legacy = true; continue; }
    if (!Array.isArray(log.topics) || !validHash(log.topics[0] ?? "")) throw new Error("Missing USDC event signature.");
    if (log.topics[0]!.toLowerCase() !== USDC_TRANSFER_TOPIC) continue;
    if (log.topics.length !== 3 || !log.topics.every(validHash) || !log.topics.slice(1).every((topic: string) => /^0x0{24}[\da-f]{40}$/i.test(topic)) || !/^0x[\da-f]{64}$/i.test(log.data)) {
      throw new Error("Malformed USDC Transfer event.");
    }
    const { args } = decodeEventLog({ abi: TRANSFER_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex, strict: true });
    const from = args.from.toLowerCase();
    const to = args.to.toLowerCase();
    if (args.value === 0n || from === to) { ignoredNonMovements++; continue; }
    const movement: UsdcMovement = {
      from, to, units18: args.value * (emitter === USDC_ERC20 ? 10n ** 12n : 1n), logIndex: log.logIndex!,
      kind: from === ZERO ? "mint" : to === ZERO ? "burn" : "transfer",
    };
    (emitter === USDC_SYSTEM ? native : erc20).push(movement);
  }
  native.sort((a, b) => a.logIndex - b.logIndex);
  erc20.sort((a, b) => a.logIndex - b.logIndex);
  const key = (movement: UsdcMovement) => `${movement.from}:${movement.to}:${movement.units18}`;
  const candidates = new Map<string, UsdcMovement[]>();
  for (const movement of native) {
    const group = candidates.get(key(movement)) ?? [];
    group.push(movement);
    candidates.set(key(movement), group);
  }
  let pairedLogs = 0;
  const unmatchedErc20: UsdcMovement[] = [];
  // Pair occurrences, not amounts alone: a batch may repeat the same payment.
  for (const movement of erc20) {
    const group = candidates.get(key(movement));
    const mirror = group?.[0];
    if (!mirror || mirror.logIndex >= movement.logIndex) { unmatchedErc20.push(movement); continue; }
    group!.shift();
    mirror.erc20LogIndex = movement.logIndex;
    pairedLogs++;
  }
  const complete = !legacy && unmatchedErc20.length === 0;
  const account = wallet?.toLowerCase();
  const movements = account ? native.filter(movement => movement.from === account || movement.to === account) : native;
  const sum = (values: UsdcMovement[]) => values.reduce((total, movement) => total + movement.units18, 0n);
  const gross = complete ? sum(movements) : null;
  const received = complete && account ? sum(movements.filter(movement => movement.to === account)) : null;
  const sent = complete && account ? sum(movements.filter(movement => movement.from === account)) : null;
  const gasFee = typeof receipt.gasUsed === "bigint" && receipt.gasUsed >= 0n
    && typeof receipt.effectiveGasPrice === "bigint" && receipt.effectiveGasPrice >= 0n
    ? receipt.gasUsed * receipt.effectiveGasPrice : null;
  return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, payer: receipt.from,
    status: receipt.status, complete, legacy, movements, unmatchedErc20, pairedLogs, ignoredNonMovements,
    gross, received, sent, net: received !== null && sent !== null ? received - sent : null, gasFee };
}
