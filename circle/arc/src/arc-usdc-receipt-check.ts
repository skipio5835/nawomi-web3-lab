import { maxUint256, parseUnits } from "viem";
import type { ReceiptResult } from "./arc-usdc-receipt-reader.js";

export type ReceiptExpectation = { recipient: string; units18: bigint };
export class ReceiptExpectationError extends Error {
  constructor(readonly field: "recipient" | "amount") { super(field); }
}

export function parseReceiptExpectation(recipient: string, amount: string): ReceiptExpectation | undefined {
  const value = amount.trim();
  if (!value) return undefined;
  const address = recipient.trim().toLowerCase();
  if (!/^0x[\da-f]{40}$/.test(address) || /^0x0{40}$/.test(address)) throw new ReceiptExpectationError("recipient");
  // Validate before parseUnits: extra decimals must be rejected, never rounded.
  if (value.length > 96 || !/^\d+(?:\.\d{1,18})?$/.test(value)) throw new ReceiptExpectationError("amount");
  const units18 = parseUnits(value, 18);
  if (units18 <= 0n || units18 > maxUint256) throw new ReceiptExpectationError("amount");
  return { recipient: address, units18 };
}

export type ReceiptComparison = {
  state: "matched" | "short" | "over" | "no-inflow" | "reverted" | "incomplete" | "review";
  reason?: "outgoing" | "mint-burn";
  recipient: string;
  expected: bigint;
  received: bigint | null;
  sent: bigint | null;
  net: bigint | null;
  difference: bigint | null;
};

export function compareUsdcReceipt(data: ReceiptResult, expectation: ReceiptExpectation): ReceiptComparison {
  const recipient = expectation.recipient.toLowerCase();
  if (expectation.units18 <= 0n || expectation.units18 > maxUint256 || !/^0x[\da-f]{40}$/.test(recipient) || /^0x0{40}$/.test(recipient)) {
    throw new Error("Invalid receipt expectation.");
  }
  // A wallet-filtered ledger cannot answer questions about another recipient.
  if (data.wallet && data.wallet.toLowerCase() !== recipient) throw new Error("Receipt wallet does not match expectation.");
  const base: ReceiptComparison = { state: "incomplete", recipient, expected: expectation.units18,
    received: null, sent: null, net: null, difference: null };
  if (!data.ledger.complete) return base;
  if (data.ledger.status === "reverted") return { ...base, state: "reverted", received: 0n, sent: 0n, net: 0n, difference: -expectation.units18 };
  const movements = data.ledger.movements.filter(item => item.from === recipient || item.to === recipient);
  const received = movements.reduce((sum, item) => sum + (item.to === recipient ? item.units18 : 0n), 0n);
  const sent = movements.reduce((sum, item) => sum + (item.from === recipient ? item.units18 : 0n), 0n);
  const net = received - sent;
  const totals = { ...base, received, sent, net, difference: net - expectation.units18 };
  if (movements.some(item => item.kind !== "transfer")) return { ...totals, state: "review", reason: "mint-burn" };
  if (sent > 0n) return { ...totals, state: "review", reason: "outgoing" };
  return { ...totals, state: received === 0n ? "no-inflow" : net === expectation.units18 ? "matched" : net < expectation.units18 ? "short" : "over" };
}

export function receiptReport(data: ReceiptResult, comparison?: ReceiptComparison) {
  return { schemaVersion: 1, ...data, comparison: comparison ?? null,
    scope: "Single-transaction RPC observation; excludes gas from transfer amounts; not proof of invoice settlement, sender identity, or non-reuse.",
    units: "USDC base units, 18 decimals" };
}
