import { ArcTestnet } from "@circle-fin/app-kit/chains";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  isAddress,
  parseEther,
  parseUnits,
  stringToHex,
} from "viem";
import type { EIP1193Provider } from "viem";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

type BatchCall = {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
};

type EthereumRequest = {
  method: string;
  params?: unknown[];
};

const ARC_TESTNET = {
  chainId: "0x4cef52",
  chainName: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};

const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
} as const;

const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const CIRCLE_WALLET = "0x78131700be4a8f2d16eeb0cba3498d2e717f2cd3";

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

const client = createPublicClient({
  chain: arcTestnet,
  transport: http("https://rpc.testnet.arc.network"),
});

let adapter: Awaited<ReturnType<typeof createViemAdapterFromProvider>> | null = null;
let address = "";

const el = {
  connect: document.querySelector<HTMLButtonElement>("#connect")!,
  refresh: document.querySelector<HTMLButtonElement>("#refresh")!,
  memoSend: document.querySelector<HTMLButtonElement>("#memoSend")!,
  batchSend: document.querySelector<HTMLButtonElement>("#batchSend")!,
  sender: document.querySelector<HTMLInputElement>("#sender")!,
  memoRecipient: document.querySelector<HTMLInputElement>("#memoRecipient")!,
  memoAmount: document.querySelector<HTMLInputElement>("#memoAmount")!,
  memoText: document.querySelector<HTMLInputElement>("#memoText")!,
  batchRows: document.querySelector<HTMLTextAreaElement>("#batchRows")!,
  tryAtomic: document.querySelector<HTMLInputElement>("#tryAtomic")!,
  nativeBalance: document.querySelector<HTMLElement>("#nativeBalance")!,
  usdcBalance: document.querySelector<HTMLElement>("#usdcBalance")!,
  status: document.querySelector<HTMLElement>("#status")!,
  memoResult: document.querySelector<HTMLElement>("#memoResult")!,
  batchResult: document.querySelector<HTMLElement>("#batchResult")!,
};

el.memoRecipient.value = CIRCLE_WALLET;
el.memoAmount.value = "0.01";
el.memoText.value = `arc weekly memo ${new Date().toISOString().slice(0, 10)}`;
el.batchRows.value = `${CIRCLE_WALLET},0.10\n0x0000000000000000000000000000000000000000,0.10`;

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

function toHexQuantity(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}`;
}

async function refreshBalances(): Promise<void> {
  if (!address) return;

  const [nativeBalance, tokenBalance] = await Promise.all([
    client.getBalance({ address: address as `0x${string}` }),
    client.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
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
    adapter = await createViemAdapterFromProvider({
      provider: window.ethereum,
      capabilities: { supportedChains: [ArcTestnet] },
    });

    el.sender.value = address;
    el.refresh.disabled = false;
    el.memoSend.disabled = false;
    el.batchSend.disabled = false;
    await refreshBalances();
    setStatus("Ready.");
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

async function waitForHash(hash: string): Promise<void> {
  await client.waitForTransactionReceipt({ hash: hash as `0x${string}` });
}

async function requestWallet(args: EthereumRequest): Promise<unknown> {
  if (!window.ethereum) {
    throw new Error("MetaMask provider not found.");
  }

  return window.ethereum.request(args as never);
}

async function sendMemo(): Promise<void> {
  if (!window.ethereum) {
    setStatus("MetaMask provider not found.");
    return;
  }
  if (!address) await connect();

  const recipient = el.memoRecipient.value.trim();
  if (!isAddress(recipient)) {
    setStatus("Memo recipient is not a valid address.");
    return;
  }

  el.memoSend.disabled = true;
  try {
    await ensureArc();
    setStatus("Waiting for MetaMask memo transaction signature...");
    const hash = (await requestWallet({
      method: "eth_sendTransaction",
      params: [
        {
          from: address,
          to: recipient,
          value: toHexQuantity(parseEther(el.memoAmount.value.trim())),
          data: el.memoText.value.trim() ? stringToHex(el.memoText.value.trim()) : "0x",
        },
      ],
    })) as string;

    await waitForHash(hash);
    el.memoResult.innerHTML = `
      <div><strong>txHash</strong><span>${hash}</span></div>
      <div><strong>explorer</strong><span><a href="${txUrl(hash)}" target="_blank" rel="noreferrer">${txUrl(hash)}</a></span></div>
    `;
    await refreshBalances();
    setStatus("Memo transaction confirmed.");
  } catch (error) {
    setStatus(`Memo send failed: ${errorMessage(error)}`);
  } finally {
    el.memoSend.disabled = false;
  }
}

function parseBatchRows(): Array<{ recipient: `0x${string}`; amount: string }> {
  return el.batchRows.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [recipientRaw, amountRaw] = line.split(",").map((part) => part.trim());
      if (!recipientRaw || !isAddress(recipientRaw)) {
        throw new Error(`Line ${index + 1}: invalid recipient.`);
      }
      if (!amountRaw || Number(amountRaw) <= 0) {
        throw new Error(`Line ${index + 1}: invalid amount.`);
      }
      return { recipient: recipientRaw, amount: amountRaw };
    });
}

function buildBatchCalls(rows: Array<{ recipient: `0x${string}`; amount: string }>): BatchCall[] {
  return rows.map((row) => ({
    to: USDC_ADDRESS,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [row.recipient, parseUnits(row.amount, 6)],
    }),
  }));
}

async function sendSequential(rows: Array<{ recipient: `0x${string}`; amount: string }>): Promise<string[]> {
  if (!window.ethereum) {
    throw new Error("MetaMask provider not found.");
  }

  const hashes: string[] = [];
  for (const row of rows) {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [row.recipient, parseUnits(row.amount, 6)],
    });

    setStatus(`Waiting for MetaMask signature: ${row.amount} USDC to ${row.recipient}`);
    const hash = (await requestWallet({
      method: "eth_sendTransaction",
      params: [{ from: address, to: USDC_ADDRESS, data }],
    })) as string;
    hashes.push(hash);
    await waitForHash(hash);
  }
  return hashes;
}

async function sendBatch(): Promise<void> {
  if (!adapter) await connect();
  if (!adapter) {
    setStatus("Adapter was not initialized.");
    return;
  }

  el.batchSend.disabled = true;
  try {
    await ensureArc();
    const rows = parseBatchRows();
    const calls = buildBatchCalls(rows);
    const canBatch = el.tryAtomic.checked && (await adapter.supportsAtomicBatch(ArcTestnet));

    if (canBatch) {
      setStatus("Submitting atomic batch via wallet_sendCalls...");
      const result = await adapter.batchExecute(calls, ArcTestnet);
      const receiptLinks = result.receipts
        .map((receipt) => receipt.txHash)
        .filter(Boolean)
        .map((hash) => `<a href="${txUrl(hash)}" target="_blank" rel="noreferrer">${hash}</a>`)
        .join("");
      el.batchResult.innerHTML = `
        <div><strong>mode</strong><span>atomic batch</span></div>
        <div><strong>batchId</strong><span>${result.batchId}</span></div>
        <div><strong>receipts</strong><span>${receiptLinks || "-"}</span></div>
      `;
    } else {
      setStatus("Wallet atomic batch unsupported or disabled. Sending sequential transfers...");
      const hashes = await sendSequential(rows);
      el.batchResult.innerHTML = hashes
        .map(
          (hash) => `
            <div>
              <strong>txHash</strong>
              <span>${hash}</span>
              <span><a href="${txUrl(hash)}" target="_blank" rel="noreferrer">explorer</a></span>
            </div>
          `,
        )
        .join("");
    }

    await refreshBalances();
    setStatus("Batch transfer flow confirmed.");
  } catch (error) {
    setStatus(`Batch send failed: ${errorMessage(error)}`);
  } finally {
    el.batchSend.disabled = false;
  }
}

el.connect.addEventListener("click", () => void connect());
el.refresh.addEventListener("click", () => void refreshBalances());
el.memoSend.addEventListener("click", () => void sendMemo());
el.batchSend.addEventListener("click", () => void sendBatch());
