import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  isAddress,
  keccak256,
  parseUnits,
  stringToHex,
} from "viem";
import type { Address, EIP1193Provider } from "viem";
import { readUsdcReceipt } from "./arc-usdc-receipt-reader.js";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

type EthereumRequest = {
  method: string;
  params?: unknown[];
};

type BatchRow = {
  recipient: Address;
  amount: string;
};

type MulticallInput = {
  target: Address;
  allowFailure: boolean;
  callData: `0x${string}`;
};

const ARC_TESTNET = {
  chainId: "0x4cef52",
  chainName: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.io"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};

const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
} as const;

const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as Address;
const MEMO_ADDRESS = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505" as Address;
const MULTICALL3FROM_ADDRESS = "0x522fAf9A91c41c443c66765030741e4AaCe147D0" as Address;
const CIRCLE_WALLET = "0x78131700be4a8f2d16eeb0cba3498d2e717f2cd3" as Address;
const METAMASK_WALLET = "0x0000000000000000000000000000000000000000" as Address;

const erc20Abi = [
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "value", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const memoAbi = [
  {
    type: "function",
    name: "memo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      { name: "memoId", type: "bytes32" },
      { name: "memoData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const multicall3FromAbi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

const client = createPublicClient({
  chain: arcTestnet,
  transport: http("https://rpc.testnet.arc.io", { timeout: 12_000, retryCount: 1 }),
});

let address = "";

const el = {
  connect: document.querySelector<HTMLButtonElement>("#connect")!,
  refresh: document.querySelector<HTMLButtonElement>("#refresh")!,
  memoSend: document.querySelector<HTMLButtonElement>("#memoSend")!,
  batchSend: document.querySelector<HTMLButtonElement>("#batchSend")!,
  sender: document.querySelector<HTMLInputElement>("#sender")!,
  memoContract: document.querySelector<HTMLInputElement>("#memoContract")!,
  batchContract: document.querySelector<HTMLInputElement>("#batchContract")!,
  memoRecipient: document.querySelector<HTMLInputElement>("#memoRecipient")!,
  memoAmount: document.querySelector<HTMLInputElement>("#memoAmount")!,
  memoReference: document.querySelector<HTMLInputElement>("#memoReference")!,
  memoText: document.querySelector<HTMLInputElement>("#memoText")!,
  batchRows: document.querySelector<HTMLTextAreaElement>("#batchRows")!,
  nativeBalance: document.querySelector<HTMLElement>("#nativeBalance")!,
  usdcBalance: document.querySelector<HTMLElement>("#usdcBalance")!,
  status: document.querySelector<HTMLElement>("#status")!,
  memoResult: document.querySelector<HTMLElement>("#memoResult")!,
  batchResult: document.querySelector<HTMLElement>("#batchResult")!,
  receiptForm: document.querySelector<HTMLFormElement>("#receiptForm")!,
  receiptHash: document.querySelector<HTMLInputElement>("#receiptHash")!,
  receiptWallet: document.querySelector<HTMLInputElement>("#receiptWallet")!,
  receiptCheck: document.querySelector<HTMLButtonElement>("#receiptCheck")!,
  receiptStatus: document.querySelector<HTMLElement>("#receiptStatus")!,
  receiptSummary: document.querySelector<HTMLElement>("#receiptSummary")!,
  receiptRows: document.querySelector<HTMLElement>("#receiptRows")!,
};

const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);

el.memoContract.value = MEMO_ADDRESS;
el.batchContract.value = MULTICALL3FROM_ADDRESS;
el.memoRecipient.value = CIRCLE_WALLET;
el.memoAmount.value = "0.003";
el.memoReference.value = `arc-receipt-${stamp}`;
el.memoText.value = `circle-arc-payment ${stamp}`;
el.batchRows.value = `${CIRCLE_WALLET},0.002\n${METAMASK_WALLET},0.001`;

function setStatus(message: string): void {
  el.status.textContent = message;
}

function errorMessage(error: unknown): string {
  console.error(error);
  return error instanceof Error ? error.message : "Unknown error.";
}

function txUrl(hash: string): string {
  return `https://testnet.arcscan.app/tx/${hash}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const replacements: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[char] ?? char;
  });
}

function renderTxLink(hash: string): string {
  const url = txUrl(hash);
  return `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`;
}

async function ensureArc(): Promise<void> {
  if (!window.ethereum) {
    throw new Error("MetaMask provider not found.");
  }

  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC_TESTNET.chainId }],
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [ARC_TESTNET],
    });
  }
}

async function assertContract(addressToCheck: Address, label: string): Promise<void> {
  const code = await client.getCode({ address: addressToCheck });
  if (!code || code === "0x") {
    throw new Error(`${label} contract is not deployed at ${addressToCheck}.`);
  }
}

async function refreshBalances(): Promise<void> {
  if (!address) return;

  const blockNumber = await client.getBlockNumber();
  const [nativeBalance, tokenBalance] = await Promise.all([
    client.getBalance({ address: address as Address, blockNumber }),
    client.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address as Address],
      blockNumber,
    }),
  ]);

  el.nativeBalance.textContent = `${formatEther(nativeBalance)} native USDC`;
  el.usdcBalance.textContent = `${formatUnits(tokenBalance, 6)} ERC-20 USDC`;
}

async function connect(): Promise<void> {
  if (!window.ethereum) {
    setStatus("MetaMask provider not found.");
    return;
  }

  try {
    setStatus("Connecting MetaMask...");
    await ensureArc();
    const accounts = (await window.ethereum.request({
      method: "eth_requestAccounts",
    })) as string[];

    address = accounts[0] ?? "";
    if (!el.receiptWallet.value && address) el.receiptWallet.value = address;
    el.sender.value = address || "Not connected";
    el.refresh.disabled = !address;
    el.memoSend.disabled = !address;
    el.batchSend.disabled = !address;
    await refreshBalances();
    setStatus("Ready.");
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

async function waitForHash(hash: string): Promise<Awaited<ReturnType<typeof client.waitForTransactionReceipt>>> {
  const receipt = await client.waitForTransactionReceipt({ hash: hash as `0x${string}` });
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted: ${hash}`);
  }
  return receipt;
}

async function requestWallet(args: EthereumRequest): Promise<unknown> {
  if (!window.ethereum) {
    throw new Error("MetaMask provider not found.");
  }

  return window.ethereum.request(args as never);
}

async function ensureConnectedAddress(): Promise<Address> {
  if (!address) {
    await connect();
  }
  if (!address || !isAddress(address)) {
    throw new Error("MetaMask account is not connected.");
  }
  return address as Address;
}

function parsePositiveAmount(raw: string, label: string): bigint {
  const amount = raw.trim();
  if (!amount || Number(amount) <= 0) {
    throw new Error(`${label} amount must be greater than zero.`);
  }
  return parseUnits(amount, 6);
}

async function sendMemo(): Promise<void> {
  el.memoSend.disabled = true;
  try {
    await ensureArc();
    const from = await ensureConnectedAddress();
    const recipientRaw = el.memoRecipient.value.trim();
    if (!isAddress(recipientRaw)) {
      throw new Error("Memo recipient is not a valid address.");
    }

    const amount = parsePositiveAmount(el.memoAmount.value, "Memo");
    const reference = el.memoReference.value.trim() || `arc-receipt-${Date.now()}`;
    const memoText = el.memoText.value.trim() || reference;
    const transferData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipientRaw, amount],
    });
    const memoId = keccak256(stringToHex(reference));
    const memoData = stringToHex(memoText);
    const data = encodeFunctionData({
      abi: memoAbi,
      functionName: "memo",
      args: [USDC_ADDRESS, transferData, memoId, memoData],
    });

    await assertContract(MEMO_ADDRESS, "Memo");
    setStatus("Waiting for MetaMask signature: Memo.memo -> USDC transfer...");
    const hash = (await requestWallet({
      method: "eth_sendTransaction",
      params: [{ from, to: MEMO_ADDRESS, data }],
    })) as string;

    const receipt = await waitForHash(hash);
    el.receiptHash.value = hash;
    void checkReceipt();
    el.memoResult.innerHTML = `
      <div><strong>mode</strong><span>Memo.memo -> USDC.transfer</span></div>
      <div><strong>txHash</strong><span>${escapeHtml(hash)}</span></div>
      <div><strong>explorer</strong><span>${renderTxLink(hash)}</span></div>
      <div><strong>memoId</strong><span>${escapeHtml(memoId)}</span></div>
      <div><strong>reference</strong><span>${escapeHtml(reference)}</span></div>
      <div><strong>block</strong><span>${receipt.blockNumber.toString()}</span></div>
    `;
    await refreshBalances();
    setStatus("Memo receipt confirmed.");
  } catch (error) {
    setStatus(`Memo receipt failed: ${errorMessage(error)}`);
  } finally {
    el.memoSend.disabled = false;
  }
}

function parseBatchRows(): BatchRow[] {
  const rows = el.batchRows.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [recipientRaw, amountRaw] = line.split(",").map((part) => part.trim());
      if (!recipientRaw || !isAddress(recipientRaw)) {
        throw new Error(`Line ${index + 1}: invalid recipient.`);
      }
      parsePositiveAmount(amountRaw ?? "", `Line ${index + 1}`);
      return { recipient: recipientRaw, amount: amountRaw };
    });

  if (rows.length === 0) {
    throw new Error("Add at least one batch row.");
  }
  return rows;
}

function buildMulticallInputs(rows: BatchRow[]): MulticallInput[] {
  return rows.map((row) => ({
    target: USDC_ADDRESS,
    allowFailure: false,
    callData: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [row.recipient, parseUnits(row.amount, 6)],
    }),
  }));
}

function batchTotal(rows: BatchRow[]): string {
  const total = rows.reduce((sum, row) => sum + parseUnits(row.amount, 6), 0n);
  return formatUnits(total, 6);
}

async function sendBatch(): Promise<void> {
  el.batchSend.disabled = true;
  try {
    await ensureArc();
    const from = await ensureConnectedAddress();
    const rows = parseBatchRows();
    const calls = buildMulticallInputs(rows);
    const data = encodeFunctionData({
      abi: multicall3FromAbi,
      functionName: "aggregate3",
      args: [calls],
    });

    await assertContract(MULTICALL3FROM_ADDRESS, "Multicall3From");
    setStatus(`Waiting for MetaMask signature: ${rows.length} transfers via Multicall3From...`);
    const hash = (await requestWallet({
      method: "eth_sendTransaction",
      params: [{ from, to: MULTICALL3FROM_ADDRESS, data }],
    })) as string;

    const receipt = await waitForHash(hash);
    el.receiptHash.value = hash;
    void checkReceipt();
    el.batchResult.innerHTML = `
      <div><strong>mode</strong><span>Multicall3From.aggregate3</span></div>
      <div><strong>txHash</strong><span>${escapeHtml(hash)}</span></div>
      <div><strong>explorer</strong><span>${renderTxLink(hash)}</span></div>
      <div><strong>rows</strong><span>${rows.length.toString()}</span></div>
      <div><strong>total</strong><span>${batchTotal(rows)} USDC</span></div>
      <div><strong>block</strong><span>${receipt.blockNumber.toString()}</span></div>
    `;
    await refreshBalances();
    setStatus("Batch payout confirmed.");
  } catch (error) {
    setStatus(`Batch payout failed: ${errorMessage(error)}`);
  } finally {
    el.batchSend.disabled = false;
  }
}

let receiptRequest = 0;
function clearReceipt(): void {
  receiptRequest++;
  el.receiptSummary.replaceChildren();
  el.receiptRows.replaceChildren();
  el.receiptStatus.textContent = "Not checked.";
  el.receiptCheck.disabled = false;
}

async function checkReceipt(): Promise<void> {
  clearReceipt();
  const request = receiptRequest;
  const hash = el.receiptHash.value.trim();
  const wallet = el.receiptWallet.value.trim();
  const current = () => request === receiptRequest && hash === el.receiptHash.value.trim() && wallet === el.receiptWallet.value.trim();
  el.receiptCheck.disabled = true;
  try {
    if (!/^0x[\da-f]{64}$/i.test(hash)) throw new Error("Enter a 32-byte transaction hash.");
    if (wallet && !isAddress(wallet)) throw new Error("Invalid wallet filter.");
    el.receiptStatus.textContent = "Reading Arc Testnet receipt...";
    const checked = await readUsdcReceipt("arc-testnet", hash, wallet, undefined, client);
    const result = checked.ledger;
    if (!current()) return;
    const amount = (units: bigint | null) => units === null ? "Unavailable" : `${formatUnits(units, 18)} USDC`;
    const summary: Array<[string, string]> = [
      ["Transaction", result.transactionHash], ["Block", `${result.blockNumber} · ${new Date(checked.blockTimestamp * 1000).toISOString()}`],
      ["Receipt", result.status], ["Paired ERC-20 logs (whole receipt)", String(result.pairedLogs)],
      ["Gross routed movements (not payment amount; gas excluded)", amount(result.gross)], ["Receipt gas", amount(result.gasFee)], ["Gas payer", result.payer],
    ];
    if (wallet) summary.push(["Wallet filter", wallet], ["Received", amount(result.received)], ["Sent", amount(result.sent)], ["Net (gas excluded)", amount(result.net)]);
    for (const [label, value] of summary) {
      const term = document.createElement("dt"); term.textContent = label;
      const detail = document.createElement("dd"); detail.textContent = value;
      el.receiptSummary.append(term, detail);
    }
    for (const movement of result.movements) {
      const row = document.createElement("tr");
      for (const value of [movement.kind, movement.from, movement.to, formatUnits(movement.units18, 18), movement.erc20LogIndex === undefined ? "System" : "System + ERC-20"]) {
        const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
      }
      el.receiptRows.append(row);
    }
    el.receiptStatus.textContent = !result.complete
      ? `Incomplete coverage: ${result.unmatchedErc20.length} unpaired ERC-20 movement(s)${result.legacy ? "; legacy system events are unsupported" : ""}. Totals withheld.`
      : result.status === "reverted" ? "Transaction reverted. No USDC movements; gas is reported separately."
        : `${result.movements.length} USDC movement(s). Mirrored events counted once. ${result.ignoredNonMovements} zero/self log(s) excluded. Receipt scope only; not wallet history or proof of invoice payment.`;
  } catch (error) {
    if (current()) el.receiptStatus.textContent = `Receipt unavailable: ${error instanceof Error ? error.message : "Unknown error"}`;
  } finally {
    if (request === receiptRequest) el.receiptCheck.disabled = false;
  }
}

el.receiptForm.addEventListener("submit", event => { event.preventDefault(); void checkReceipt(); });
el.receiptHash.addEventListener("input", clearReceipt);
el.receiptWallet.addEventListener("input", clearReceipt);
el.connect.addEventListener("click", () => void connect());
el.refresh.addEventListener("click", () => void refreshBalances());
el.memoSend.addEventListener("click", () => void sendMemo());
el.batchSend.addEventListener("click", () => void sendBatch());
