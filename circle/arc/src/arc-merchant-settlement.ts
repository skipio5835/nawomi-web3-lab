import { createPublicClient, createWalletClient, custom, formatEther, formatUnits, http, isAddress, parseUnits } from "viem";
import type { Address, EIP1193Provider, Hash } from "viem";
import { arcScanLink, renderStatus } from "./dom-safety.js";

declare global { interface Window { ethereum?: EIP1193Provider; } }
const arc = { id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } }, blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } } } as const;
const tokens = {
  USDC: { address: "0x3600000000000000000000000000000000000000" as Address, decimals: 6 },
  EURC: { address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as Address, decimals: 6 },
} as const;
const abi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }, { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const publicClient = createPublicClient({ chain: arc, transport: http() });
let provider: EIP1193Provider | null = null; let wallet: ReturnType<typeof createWalletClient> | null = null; let account: Address | null = null;
const activityKey = "ArcMerchantSettlement.activity.v1";
type Entry = { kind: string; token: string; amount: string; counterparty: string; reference: string; hash: Hash; at: string };
const el = {
  connect: document.querySelector<HTMLButtonElement>("#connect")!, wallet: document.querySelector<HTMLElement>("#wallet")!, native: document.querySelector<HTMLElement>("#native")!, usdc: document.querySelector<HTMLElement>("#usdc")!, eurc: document.querySelector<HTMLElement>("#eurc")!,
  merchant: document.querySelector<HTMLInputElement>("#merchant")!, token: document.querySelector<HTMLSelectElement>("#token")!, amount: document.querySelector<HTMLInputElement>("#amount")!, reference: document.querySelector<HTMLInputElement>("#reference")!, kind: document.querySelector<HTMLSelectElement>("#kind")!, submit: document.querySelector<HTMLButtonElement>("#submit")!, status: document.querySelector<HTMLElement>("#status")!, ledger: document.querySelector<HTMLElement>("#ledger")!,
};
function setStatus(message: string, hash?: Hash): void { renderStatus(el.status, message, hash, "ArcScan receipt"); }
function ledger(): Entry[] { return JSON.parse(localStorage.getItem(activityKey) ?? "[]") as Entry[]; }
function renderLedger(): void {
  const rows = ledger();
  if (rows.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No settlement receipts recorded.";
    el.ledger.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const item = document.createElement("li");
    const heading = document.createElement("strong");
    const detail = document.createElement("span");
    const timestamp = document.createElement("small");
    heading.textContent = `${row.kind} · ${row.token} ${row.amount}`;
    detail.textContent = `${row.reference} · ${row.counterparty}`;
    timestamp.textContent = new Date(row.at).toLocaleString();
    item.append(heading, detail, arcScanLink("tx", row.hash), timestamp);
    fragment.append(item);
  }
  el.ledger.replaceChildren(fragment);
}
async function connect(): Promise<void> { provider = window.ethereum ?? null; if (!provider) throw new Error("MetaMask was not found."); await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x4cef52" }] }); const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[]; account = accounts[0] as Address; wallet = createWalletClient({ account, chain: arc, transport: custom(provider) }); el.wallet.textContent = account; el.merchant.value = account; setStatus("Merchant wallet connected."); await refresh(); }
async function refresh(): Promise<void> { if (!account) throw new Error("Connect MetaMask first."); const [native, usdc, eurc] = await Promise.all([publicClient.getBalance({ address: account }), ...Object.values(tokens).map((token) => publicClient.readContract({ address: token.address, abi, functionName: "balanceOf", args: [account!] }))]); el.native.textContent = `${formatEther(native)} USDC`; el.usdc.textContent = `${formatUnits(usdc, 6)} USDC`; el.eurc.textContent = `${formatUnits(eurc, 6)} EURC`; }
async function submitSettlement(): Promise<void> {
  if (!wallet || !account) await connect(); if (!wallet || !account) throw new Error("Wallet connection failed.");
  const merchant = el.merchant.value.trim(); const symbol = el.token.value as keyof typeof tokens; const amount = el.amount.value.trim(); const reference = el.reference.value.trim();
  if (!isAddress(merchant)) throw new Error("Enter a valid merchant or refund address."); if (!amount || Number(amount) <= 0) throw new Error("Enter a positive amount."); if (!reference) throw new Error("Enter a payment reference.");
  const token = tokens[symbol]; const kind = el.kind.value; setStatus(`Waiting for MetaMask: ${kind.toLowerCase()} ${symbol}...`);
  const hash = await wallet.writeContract({ chain: arc, account, address: token.address, abi, functionName: "transfer", args: [merchant as Address, parseUnits(amount, token.decimals)] });
  await publicClient.waitForTransactionReceipt({ hash }); const rows = ledger(); rows.unshift({ kind, token: symbol, amount, counterparty: merchant, reference, hash, at: new Date().toISOString() }); localStorage.setItem(activityKey, JSON.stringify(rows.slice(0, 20))); renderLedger(); await refresh(); setStatus(`${kind} confirmed.`, hash);
}
el.connect.addEventListener("click", () => void connect().catch((error) => setStatus(error instanceof Error ? error.message : "Connection failed.")));
el.submit.addEventListener("click", () => void submitSettlement().catch((error) => setStatus(error instanceof Error ? error.message : "Settlement failed.")));
renderLedger();
