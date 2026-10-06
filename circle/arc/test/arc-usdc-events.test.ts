import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { normalizeUsdcReceipt, USDC_ERC20, USDC_SYSTEM, type UsdcReceipt } from "../src/arc-usdc-events.js";

const from = "0x1000000000000000000000000000000000000000";
const to = "0x2000000000000000000000000000000000000000";
const tx = `0x${"ab".repeat(32)}`;
const blockHash = `0x${"cd".repeat(32)}`;
const UNIT = 10n ** 18n;
const abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
function log(address = USDC_SYSTEM, value = UNIT, logIndex = 1, sender = from, recipient = to): UsdcReceipt["logs"][number] {
  return { address, data: encodeAbiParameters([{ type: "uint256" }], [value]),
    topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from: sender as `0x${string}`, to: recipient as `0x${string}` } }).filter((topic): topic is `0x${string}` => typeof topic === "string"),
    logIndex, transactionHash: tx, blockHash, blockNumber: 100n, removed: false };
}
function receipt(logs: UsdcReceipt["logs"]): UsdcReceipt {
  return { transactionHash: tx, blockHash, blockNumber: 100n, status: "success", from, gasUsed: 21000n, effectiveGasPrice: 100n, logs };
}

test("USDC native/ERC20 mirror logs count once with exact 18/6 decimal conversion", () => {
  const result = normalizeUsdcReceipt(receipt([log(), log(USDC_ERC20, 1_000_000n, 2)]), from);
  assert.equal(result.complete, true);
  assert.equal(result.movements.length, 1);
  assert.equal(result.pairedLogs, 1);
  assert.equal(result.gross, UNIT);
  assert.equal(result.sent, UNIT);
  assert.equal(result.received, 0n);
  assert.equal(result.net, -UNIT);
  assert.equal(result.gasFee, 2_100_000n);
});

test("identical payments in a batch remain distinct; native-only movements are retained", () => {
  const result = normalizeUsdcReceipt(receipt([
    log(USDC_SYSTEM, UNIT, 5), log(USDC_ERC20, 1_000_000n, 4), log(), log(USDC_ERC20, 1_000_000n, 2), log(USDC_SYSTEM, UNIT, 3),
  ]));
  assert.equal(result.complete, true);
  assert.equal(result.gross, 3n * UNIT);
  assert.equal(result.movements.length, 3);
  assert.equal(result.pairedLogs, 2);
  assert.equal(result.received, null);
});

test("missing, mismatched or incorrectly ordered mirrors withhold totals", () => {
  for (const logs of [[log(USDC_ERC20, 1_000_000n, 2)], [log(), log(USDC_ERC20, 2_000_000n, 2)],
    [log(USDC_ERC20, 1_000_000n, 0), log()]]) {
    const result = normalizeUsdcReceipt(receipt(logs), to);
    assert.equal(result.complete, false);
    assert.equal(result.gross, null);
    assert.equal(result.received, null);
    assert.equal(result.net, null);
  }
});

test("integer accounting retains sub-micro USDC and amounts above Number safe precision", () => {
  const value = 9007199254740993123456789n;
  const result = normalizeUsdcReceipt(receipt([log(USDC_SYSTEM, value), log(USDC_SYSTEM, 1n, 2)]), to);
  assert.equal(result.received, value + 1n);
  assert.equal(result.gross, value + 1n);
});

test("foreign token Transfer events and USDC Approval events do not become USDC movements", () => {
  const result = normalizeUsdcReceipt(receipt([log(from), { ...log(USDC_ERC20, 1n, 2), topics: [`0x${"ef".repeat(32)}`] }]));
  assert.equal(result.gross, 0n);
  assert.equal(result.complete, true);
});

test("duplicate indexed logs are ignored but conflicting copies fail", () => {
  const first = log();
  assert.equal(normalizeUsdcReceipt(receipt([first, first])).gross, UNIT);
  assert.throws(() => normalizeUsdcReceipt(receipt([first, log(USDC_SYSTEM, 2n)])), /Conflicting/);
});

test("receipt integrity rejects removed, pending, wrong-block and wrong-transaction logs", () => {
  for (const invalid of [{ removed: true }, { logIndex: null }, { logIndex: -1 }, { blockHash: tx },
    { blockNumber: 101n }, { transactionHash: blockHash }]) {
    assert.throws(() => normalizeUsdcReceipt(receipt([{ ...log(), ...invalid }])), /identity/);
  }
  assert.throws(() => normalizeUsdcReceipt({ ...receipt([]), status: "pending" }), /confirmed/);
  assert.throws(() => normalizeUsdcReceipt(receipt([]), "invalid"), /wallet/);
});

test("zero/self transfers do not imply movements; mint and burn retain their meaning", () => {
  const zero = "0x0000000000000000000000000000000000000000";
  const result = normalizeUsdcReceipt(receipt([
    log(USDC_ERC20, 0n), log(USDC_ERC20, 1n, 2, from, from),
    log(USDC_SYSTEM, UNIT, 3, zero, to), log(USDC_SYSTEM, UNIT, 4, to, zero),
  ]), to);
  assert.equal(result.ignoredNonMovements, 2);
  assert.deepEqual(result.movements.map(movement => movement.kind), ["mint", "burn"]);
  assert.equal(result.net, 0n);
});

test("reverted receipts have no movements but retain gas; malformed logs never become zero totals", () => {
  const result = normalizeUsdcReceipt({ ...receipt([]), status: "reverted" });
  assert.equal(result.gross, 0n);
  assert.equal(result.gasFee, 2_100_000n);
  assert.throws(() => normalizeUsdcReceipt({ ...receipt([log()]), status: "reverted" }), /Reverted/);
  for (const invalid of [{ data: "0x" }, { topics: [] }, { topics: [...log().topics, tx] }]) {
    assert.throws(() => normalizeUsdcReceipt(receipt([{ ...log(), ...invalid }])));
  }
});

test("legacy system events mark coverage unsupported, not an empty successful ledger", () => {
  const result = normalizeUsdcReceipt(receipt([log("0x1800000000000000000000000000000000000000")]));
  assert.equal(result.complete, false);
  assert.equal(result.legacy, true);
  assert.equal(result.gross, null);
});

test("foreign-log collisions, noncanonical addresses and oversized receipts fail closed", () => {
  assert.throws(() => normalizeUsdcReceipt(receipt([log(from), log()])), /Conflicting/);
  const topics = [...log().topics]; topics[1] = `0x01${"0".repeat(22)}${from.slice(2)}`;
  assert.throws(() => normalizeUsdcReceipt(receipt([{ ...log(), topics }])), /Malformed/);
  assert.throws(() => normalizeUsdcReceipt(receipt(Array.from({ length: 4097 }, () => log()))), /confirmed/);
});
