import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { readUsdcReceipt, ReceiptLookupError, type ReceiptClient } from "../src/arc-usdc-receipt-reader.js";
import { USDC_SYSTEM, USDC_ERC20, type UsdcReceipt } from "../src/arc-usdc-events.js";
import { compareUsdcReceipt, parseReceiptExpectation, receiptReport, ReceiptExpectationError } from "../src/arc-usdc-receipt-check.js";

const tx = `0x${"ab".repeat(32)}`;
const blockHash = `0x${"cd".repeat(32)}`;
const from = "0x1000000000000000000000000000000000000000";
const to = "0x2000000000000000000000000000000000000000";
const unit = 10n ** 18n;
const abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
function fixture() {
  const log = { address: USDC_SYSTEM, logIndex: 0, removed: false, transactionHash: tx, blockHash, blockNumber: 100n,
    data: encodeAbiParameters([{ type: "uint256" }], [unit]),
    topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from, to } }) as string[] };
  const receipt: UsdcReceipt = { transactionHash: tx, blockHash, blockNumber: 100n, status: "success", from,
    gasUsed: 21000n, effectiveGasPrice: 100n, logs: [log] };
  const transaction = { hash: tx, from, to, value: unit, blockHash, blockNumber: 100n as bigint | null };
  const block = { number: 100n, hash: blockHash, timestamp: 1789000000n, transactions: [tx] };
  const client: ReceiptClient = { getChainId: async () => 5042, getTransactionReceipt: async () => receipt,
    getTransaction: async () => transaction, getBlock: async () => block };
  return { client, receipt, transaction, block, log };
}
const code = (expected: string) => (error: unknown) => error instanceof ReceiptLookupError && error.code === expected;

test("mainnet native receipt cross-checks block and transaction, preserving exact units and gas", async () => {
  const f = fixture();
  const value = await readUsdcReceipt("arc-mainnet", tx, to, undefined, f.client);
  assert.equal(value.network.chainId, 5042);
  assert.equal(value.ledger.received, unit);
  assert.equal(value.ledger.net, unit);
  assert.equal(value.ledger.gasFee, 2100000n);
  assert.equal(value.blockTimestamp, Number(f.block.timestamp));
});

test("ERC20 mirrors are not credited twice and missing mirrors withhold all totals", async () => {
  const f = fixture(); f.transaction.value = 0n;
  const erc20 = { ...f.log, address: USDC_ERC20, logIndex: 1, data: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]) };
  f.receipt.logs = [f.log, erc20];
  const result = await readUsdcReceipt("arc-mainnet", tx, to, undefined, f.client);
  assert.equal(result.ledger.received, unit); assert.equal(result.ledger.pairedLogs, 1);
  f.receipt.logs = [erc20];
  const partial = await readUsdcReceipt("arc-mainnet", tx, to, undefined, f.client);
  assert.equal(partial.ledger.complete, false); assert.equal(partial.ledger.received, null);
});

test("mainnet native sends with missing system logs cannot become a successful zero-value ledger", async () => {
  const f = fixture(); f.receipt.logs = [];
  await assert.rejects(readUsdcReceipt("arc-mainnet", tx, "", undefined, f.client), code("integrity"));
  f.transaction.value = 0n;
  assert.equal((await readUsdcReceipt("arc-mainnet", tx, "", undefined, f.client)).ledger.gross, 0n);
});

test("chain mismatch fails before receipt reads and malformed input cannot start RPC work", async () => {
  const f = fixture(); let receiptReads = 0;
  f.client.getTransactionReceipt = async () => { receiptReads++; return f.receipt; };
  f.client.getChainId = async () => 5042002;
  await assert.rejects(readUsdcReceipt("arc-mainnet", tx, "", undefined, f.client), code("network"));
  assert.equal(receiptReads, 0);
  for (const bad of ["", "<script>", "0x123"]) await assert.rejects(readUsdcReceipt("arc-testnet", bad, "", undefined, f.client), code("input"));
  await assert.rejects(readUsdcReceipt("arc-testnet", tx, "invalid", undefined, f.client), code("input"));
  assert.equal(receiptReads, 0);
  const testnet = await readUsdcReceipt("arc-testnet", tx, "", undefined, f.client);
  assert.equal(testnet.network.chainId, 5042002);
});

test("changed block, missing block membership and mismatched transaction identities fail closed", async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.block.hash = tx; }, f => { f.block.number = 101n; }, f => { f.block.transactions = []; },
    f => { f.transaction.hash = blockHash; }, f => { f.transaction.from = to; }, f => { f.transaction.blockNumber = null; },
    f => { f.receipt.transactionHash = blockHash; }, f => { f.block.timestamp = BigInt(Date.now()); },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await assert.rejects(readUsdcReceipt("arc-mainnet", tx, "", undefined, f.client), code("integrity"));
  }
});

test("reverted transactions keep gas separate and never claim that value was delivered", async () => {
  const f = fixture(); f.receipt.status = "reverted"; f.receipt.logs = [];
  const value = await readUsdcReceipt("arc-mainnet", tx, to, undefined, f.client);
  assert.equal(value.ledger.received, 0n);
  assert.equal(value.ledger.status, "reverted");
  assert.equal(value.ledger.gasFee, 2100000n);
});

test("unknown receipts and provider errors are distinct and do not leak raw errors", async () => {
  const f = fixture();
  f.client.getTransactionReceipt = async () => { throw Object.assign(new Error("provider detail"), { name: "TransactionReceiptNotFoundError" }); };
  await assert.rejects(readUsdcReceipt("arc-mainnet", tx, "", undefined, f.client), code("not-found"));
  f.client.getTransactionReceipt = async () => { throw new Error("https://private.invalid/?secret=redacted"); };
  await assert.rejects(readUsdcReceipt("arc-mainnet", tx, "", undefined, f.client), error => code("unavailable")(error) && !String(error).includes("secret"));
});

test("cancelled lookups cannot return a result even if a transport ignores abort", async () => {
  const f = fixture(), controller = new AbortController();
  f.client.getBlock = async () => { controller.abort(); return f.block; };
  await assert.rejects(readUsdcReceipt("arc-mainnet", tx, "", controller.signal, f.client));
});

test("standalone mainnet receipt UI has no wallet access, arbitrary endpoints or send controls", () => {
  const ui = readFileSync(new URL("../src/arc-usdc-receipt.ts", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/arc-usdc-receipt.html", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /ethereum|eth_send|wallet_|innerHTML|localStorage/);
  assert.match(ui, /controller\?\.abort\(\)/);
  assert.match(ui, /request !== generation/);
  assert.match(ui, /expected\.addEventListener\("input", reset\)/);
  assert.match(ui, /print\.disabled = true/);
  assert.match(ui, /receiptReport\(result, comparison\)/);
  assert.match(html, /connect-src https:\/\/rpc\.mainnet\.arc\.io https:\/\/rpc\.testnet\.arc\.io/);
  assert.match(html, /<script type="module" src="\.\/arc-usdc-receipt\.bundle\.js"/, "module scope prevents collisions with window.status");
  assert.doesNotMatch(html, /arc-usdc-tools\.bundle|id="connect"|id="memoSend"|id="batchSend"/);
});

test("expectations use exact 18-decimal arithmetic, rejecting rounding and ambiguous input", () => {
  assert.equal(parseReceiptExpectation("", ""), undefined);
  assert.equal(parseReceiptExpectation(to, " "), undefined);
  assert.equal(parseReceiptExpectation(to, "0.000000000000000001")!.units18, 1n);
  assert.equal(parseReceiptExpectation(to, "9007199254740993.000001")!.units18, 9007199254740993000001000000000000n);
  for (const invalid of ["0", "-1", "+1", "1e3", "1,000", "1.", ".1", "NaN", "Infinity", "0.0000000000000000001", "1".repeat(97), "9".repeat(78)]) {
    assert.throws(() => parseReceiptExpectation(to, invalid), error => error instanceof ReceiptExpectationError && error.field === "amount", invalid);
  }
  for (const invalid of ["", "0x123", `0x${"0".repeat(40)}`]) {
    assert.throws(() => parseReceiptExpectation(invalid, "1"), error => error instanceof ReceiptExpectationError && error.field === "recipient");
  }
});

test("receipt comparison distinguishes exact, short, over and absent recipient without float rounding", async () => {
  const data = await readUsdcReceipt("arc-mainnet", tx, "", undefined, fixture().client);
  assert.equal(compareUsdcReceipt(data, parseReceiptExpectation(to, "1")!).state, "matched");
  const short = compareUsdcReceipt(data, parseReceiptExpectation(to, "1.000000000000000001")!);
  assert.equal(short.state, "short"); assert.equal(short.difference, -1n);
  const over = compareUsdcReceipt(data, parseReceiptExpectation(to, "0.999999999999999999")!);
  assert.equal(over.state, "over"); assert.equal(over.difference, 1n);
  assert.equal(compareUsdcReceipt(data, parseReceiptExpectation("0x3000000000000000000000000000000000000000", "1")!).state, "no-inflow");
});

test("gas payer and transaction sender are not substituted for actual event recipient or payment amount", async () => {
  const data = await readUsdcReceipt("arc-mainnet", tx, "", undefined, fixture().client);
  data.ledger.payer = to;
  data.ledger.gasFee = unit;
  assert.equal(compareUsdcReceipt(data, parseReceiptExpectation(to, "1")!).net, unit);
  assert.equal(compareUsdcReceipt(data, parseReceiptExpectation(from, "1")!).state, "review");
});

test("round trips and forwarding require review even when gross or net could match", async () => {
  const data = await readUsdcReceipt("arc-mainnet", tx, "", undefined, fixture().client);
  data.ledger.movements.push({ from: to, to: from, units18: unit / 2n, logIndex: 2, kind: "transfer" });
  const partialReturn = compareUsdcReceipt(data, parseReceiptExpectation(to, "0.5")!);
  assert.equal(partialReturn.net, unit / 2n); assert.equal(partialReturn.state, "review");
  assert.equal(partialReturn.reason, "outgoing");
  data.ledger.movements[1]!.units18 = unit;
  const returned = compareUsdcReceipt(data, parseReceiptExpectation(to, "1")!);
  assert.equal(returned.net, 0n); assert.equal(returned.state, "review");
});

test("mint and burn do not become ordinary invoice payments", async () => {
  const data = await readUsdcReceipt("arc-mainnet", tx, "", undefined, fixture().client);
  data.ledger.movements[0] = { from: `0x${"0".repeat(40)}`, to, units18: unit, logIndex: 0, kind: "mint" };
  assert.equal(compareUsdcReceipt(data, parseReceiptExpectation(to, "1")!).reason, "mint-burn");
  data.ledger.movements.push({ from: to, to: `0x${"0".repeat(40)}`, units18: 1n, logIndex: 2, kind: "burn" });
  assert.equal(compareUsdcReceipt(data, parseReceiptExpectation(to, "1")!).state, "review");
});

test("incomplete events and reverted receipts cannot produce a successful reconciliation", async () => {
  const f = fixture();
  const data = await readUsdcReceipt("arc-mainnet", tx, to, undefined, f.client);
  data.ledger.complete = false;
  const incomplete = compareUsdcReceipt(data, parseReceiptExpectation(to, "1")!);
  assert.equal(incomplete.state, "incomplete"); assert.equal(incomplete.net, null); assert.equal(incomplete.difference, null);
  f.receipt.status = "reverted"; f.receipt.logs = [];
  const reverted = await readUsdcReceipt("arc-mainnet", tx, to, undefined, f.client);
  assert.equal(compareUsdcReceipt(reverted, parseReceiptExpectation(to, "1")!).state, "reverted");
});

test("mirror deduplication remains effective during recipient reconciliation", async () => {
  const f = fixture(); f.transaction.value = 0n;
  f.receipt.logs = [f.log, { ...f.log, address: USDC_ERC20, logIndex: 1, data: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]) }];
  const data = await readUsdcReceipt("arc-mainnet", tx, to, undefined, f.client);
  assert.equal(compareUsdcReceipt(data, parseReceiptExpectation(to, "1")!).state, "matched");
  assert.equal(compareUsdcReceipt(data, parseReceiptExpectation(to, "2")!).state, "short");
  assert.throws(() => compareUsdcReceipt(data, parseReceiptExpectation(from, "1")!), /wallet does not match/);
  assert.throws(() => compareUsdcReceipt(data, { recipient: to, units18: 0n }), /Invalid/);
});

test("report preserves chain, checked time, exact units, scope and comparison, without inventing one", async () => {
  const data = await readUsdcReceipt("arc-mainnet", tx, to, undefined, fixture().client);
  const comparison = compareUsdcReceipt(data, parseReceiptExpectation(to, "1")!);
  const report = JSON.parse(JSON.stringify(receiptReport(data, comparison), (_, value: unknown) => typeof value === "bigint" ? value.toString() : value));
  assert.equal(report.network.chainId, 5042);
  assert.equal(report.checkedAt, data.checkedAt);
  assert.equal(report.comparison.expected, unit.toString());
  assert.equal(report.comparison.state, "matched");
  assert.match(report.scope, /not proof of invoice settlement/);
  assert.equal(receiptReport(data).comparison, null);
});
