import {
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  http,
  isAddress,
  keccak256,
  parseEther,
  toBytes,
} from "viem";
import type { Address, EIP1193Provider, Hash } from "viem";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

type InjectedProvider = EIP1193Provider & {
  isMetaMask?: boolean;
  providers?: Array<EIP1193Provider & { isMetaMask?: boolean }>;
};

type EscrowStatus = "draft" | "funded" | "released" | "refunded";
type EscrowOutcome = "release" | "refund";

type EscrowRecord = {
  id: string;
  escrowId: Hash;
  seller: Address;
  amount: string;
  metadataURI: string;
  outcome: EscrowOutcome;
  status: EscrowStatus;
  contractAddress?: Address;
  fundingTxHash?: Hash;
  settlementTxHash?: Hash;
  createdAt: string;
  updatedAt: string;
};

type Artifact = {
  abi: unknown[];
  bytecode: Hash;
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

const CIRCLE_WALLET = "0x78131700be4a8f2d16eeb0cba3498d2e717f2cd3" as Address;
const DEFAULT_CONTRACT_ADDRESS = "0x679b3456100a3102e81ba60b54a400443fe20558" as Address;
const STORAGE_KEY = "arcEscrow.records";
const CONTRACT_KEY = "arcEscrow.contractAddress";

const arcEscrowAbi = [
  {
    inputs: [
      { internalType: "bytes32", name: "escrowId", type: "bytes32" },
      { internalType: "address", name: "seller", type: "address" },
      { internalType: "string", name: "metadataURI", type: "string" },
    ],
    name: "createEscrow",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "escrowId", type: "bytes32" }],
    name: "releaseEscrow",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "escrowId", type: "bytes32" }],
    name: "refundEscrow",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "escrowId", type: "bytes32" }],
    name: "getEscrow",
    outputs: [
      {
        components: [
          { internalType: "address", name: "buyer", type: "address" },
          { internalType: "address", name: "seller", type: "address" },
          { internalType: "uint256", name: "amount", type: "uint256" },
          { internalType: "enum ArcEscrow.Status", name: "status", type: "uint8" },
          { internalType: "string", name: "metadataURI", type: "string" },
        ],
        internalType: "struct ArcEscrow.Escrow",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http("https://rpc.testnet.arc.network"),
});

let walletClient: ReturnType<typeof createWalletClient> | null = null;
let selectedProvider: EIP1193Provider | null = null;
let account: Address | null = null;
let records: EscrowRecord[] = loadRecords();
let selectedId = records[0]?.id ?? "";
let contractAddress = (localStorage.getItem(CONTRACT_KEY) ?? DEFAULT_CONTRACT_ADDRESS) as Address | "";

const el = {
  connect: document.querySelector<HTMLButtonElement>("#connect")!,
  walletAddress: document.querySelector<HTMLElement>("#walletAddress")!,
  nativeBalance: document.querySelector<HTMLElement>("#nativeBalance")!,
  contractAddress: document.querySelector<HTMLInputElement>("#contractAddress")!,
  deployContract: document.querySelector<HTMLButtonElement>("#deployContract")!,
  saveContract: document.querySelector<HTMLButtonElement>("#saveContract")!,
  seller: document.querySelector<HTMLInputElement>("#seller")!,
  amount: document.querySelector<HTMLInputElement>("#amount")!,
  reference: document.querySelector<HTMLInputElement>("#reference")!,
  outcome: document.querySelector<HTMLSelectElement>("#outcome")!,
  createDraft: document.querySelector<HTMLButtonElement>("#createDraft")!,
  fundEscrow: document.querySelector<HTMLButtonElement>("#fundEscrow")!,
  releaseEscrow: document.querySelector<HTMLButtonElement>("#releaseEscrow")!,
  refundEscrow: document.querySelector<HTMLButtonElement>("#refundEscrow")!,
  refreshSelected: document.querySelector<HTMLButtonElement>("#refreshSelected")!,
  escrowRows: document.querySelector<HTMLElement>("#escrowRows")!,
  selectedStatus: document.querySelector<HTMLElement>("#selectedStatus")!,
  receipt: document.querySelector<HTMLElement>("#receipt")!,
  statusLine: document.querySelector<HTMLElement>("#statusLine")!,
};

el.contractAddress.value = contractAddress;
el.seller.value = CIRCLE_WALLET;
el.amount.value = "0.004";
el.reference.value = `arc-escrow-${new Date().toISOString().slice(0, 10)}`;

function loadRecords(): EscrowRecord[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];

  try {
    return JSON.parse(raw) as EscrowRecord[];
  } catch {
    return [];
  }
}

function saveRecords(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function selectedRecord(): EscrowRecord | undefined {
  return records.find((record) => record.id === selectedId);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char] ?? char;
  });
}

function shortHash(value?: string): string {
  if (!value) return "-";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function txUrl(hash: string): string {
  return `https://testnet.arcscan.app/tx/${hash}`;
}

function addressUrl(address: string): string {
  return `https://testnet.arcscan.app/address/${address}`;
}

function setStatus(message: string): void {
  el.statusLine.textContent = message;
}

function errorMessage(error: unknown): string {
  console.error(error);
  return error instanceof Error ? error.message : "Unknown error.";
}

async function getEthereumProvider(): Promise<EIP1193Provider> {
  const injected = window.ethereum as InjectedProvider | undefined;
  const legacyMetaMask = injected?.providers?.find((provider) => provider.isMetaMask);
  if (legacyMetaMask) return legacyMetaMask;
  if (injected?.isMetaMask) return injected;

  const announced: Array<{ provider: EIP1193Provider; name?: string; rdns?: string }> = [];
  const onAnnounce = (event: Event): void => {
    const detail = (event as CustomEvent).detail as
      | { info?: { name?: string; rdns?: string }; provider?: EIP1193Provider }
      | undefined;
    if (detail?.provider) {
      announced.push({
        provider: detail.provider,
        name: detail.info?.name,
        rdns: detail.info?.rdns,
      });
    }
  };

  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);

  const metaMask = announced.find((item) => {
    const label = `${item.name ?? ""} ${item.rdns ?? ""}`.toLowerCase();
    return label.includes("metamask");
  });
  if (metaMask) return metaMask.provider;

  if (injected) return injected;
  throw new Error("MetaMask provider not found.");
}

async function ensureArc(): Promise<void> {
  const provider = selectedProvider ?? (await getEthereumProvider());
  selectedProvider = provider;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC_TESTNET.chainId }],
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [ARC_TESTNET],
    });
  }
}

async function refreshBalance(): Promise<void> {
  if (!account) return;
  const balance = await publicClient.getBalance({ address: account });
  el.nativeBalance.textContent = `${formatEther(balance)} USDC`;
}

async function connect(): Promise<void> {
  try {
    setStatus("Connecting wallet...");
    const provider = await getEthereumProvider();
    selectedProvider = provider;
    await ensureArc();
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
    account = accounts[0] ?? null;
    if (!account) throw new Error("No wallet account returned.");

    walletClient = createWalletClient({
      account,
      chain: arcTestnet,
      transport: custom(provider),
    });

    el.walletAddress.textContent = account;
    el.connect.textContent = "Connected";
    await refreshBalance();
    updateActions();
    setStatus("Wallet ready.");
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

function randomEscrowId(reference: string): Hash {
  const random = new Uint32Array(4);
  crypto.getRandomValues(random);
  return keccak256(toBytes(`${reference}:${Date.now()}:${Array.from(random).join(":")}`));
}

function statusLabel(status: EscrowStatus): string {
  return status;
}

function statusClass(status: EscrowStatus): string {
  return `status ${status}`;
}

function receiptField(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

function renderRows(): void {
  el.escrowRows.innerHTML = records
    .map((record) => {
      const selected = record.id === selectedId ? "true" : "false";
      return `
        <tr data-selected="${selected}">
          <td>${escapeHtml(record.id)}</td>
          <td>${escapeHtml(record.amount)} USDC</td>
          <td><span class="${statusClass(record.status)}">${statusLabel(record.status)}</span></td>
          <td>${escapeHtml(record.outcome)}</td>
          <td><button class="select-row secondary" data-id="${escapeHtml(record.id)}" type="button">Select</button></td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll<HTMLButtonElement>(".select-row").forEach((button) => {
    button.addEventListener("click", () => {
      selectedId = button.dataset.id ?? "";
      render();
    });
  });
}

function renderReceipt(): void {
  const record = selectedRecord();
  if (!record) {
    el.selectedStatus.className = "status draft";
    el.selectedStatus.textContent = "draft";
    el.receipt.innerHTML = receiptField("Escrow", "-") + receiptField("Amount", "-");
    return;
  }

  const contract = record.contractAddress ?? contractAddress;
  const funding = record.fundingTxHash
    ? `<a href="${txUrl(record.fundingTxHash)}" target="_blank" rel="noreferrer">${shortHash(record.fundingTxHash)}</a>`
    : "-";
  const settlement = record.settlementTxHash
    ? `<a href="${txUrl(record.settlementTxHash)}" target="_blank" rel="noreferrer">${shortHash(record.settlementTxHash)}</a>`
    : "-";
  const contractLink = contract
    ? `<a href="${addressUrl(contract)}" target="_blank" rel="noreferrer">${shortHash(contract)}</a>`
    : "-";

  el.selectedStatus.className = statusClass(record.status);
  el.selectedStatus.textContent = statusLabel(record.status);
  el.receipt.innerHTML = [
    receiptField("Escrow ID", `<code>${record.escrowId}</code>`),
    receiptField("Contract", contractLink),
    receiptField("Seller", `<code>${record.seller}</code>`),
    receiptField("Amount", `${escapeHtml(record.amount)} USDC`),
    receiptField("Outcome", escapeHtml(record.outcome)),
    receiptField("Fund tx", funding),
    receiptField("Settle tx", settlement),
    receiptField("Metadata", escapeHtml(record.metadataURI)),
  ].join("");
}

function updateActions(): void {
  const record = selectedRecord();
  const hasWallet = Boolean(walletClient && account);
  const hasContract = Boolean(contractAddress && isAddress(contractAddress));

  el.deployContract.disabled = !hasWallet;
  el.saveContract.disabled = false;
  el.createDraft.disabled = !hasWallet;
  el.fundEscrow.disabled = !hasWallet || !hasContract || !record || record.status !== "draft";
  el.releaseEscrow.disabled = !hasWallet || !hasContract || !record || record.status !== "funded";
  el.refundEscrow.disabled = !hasWallet || !hasContract || !record || record.status !== "funded";
  el.refreshSelected.disabled = !hasContract || !record;
}

function render(): void {
  renderRows();
  renderReceipt();
  updateActions();
}

function createDraft(): void {
  if (!account) {
    setStatus("Connect MetaMask first.");
    return;
  }

  const seller = el.seller.value.trim();
  const amount = el.amount.value.trim();
  const reference = el.reference.value.trim();
  const outcome = el.outcome.value as EscrowOutcome;

  if (!isAddress(seller)) {
    setStatus("Seller must be a valid EVM address.");
    return;
  }
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    setStatus("Amount must be a positive number.");
    return;
  }
  if (!reference) {
    setStatus("Reference is required.");
    return;
  }

  const now = new Date().toISOString();
  const record: EscrowRecord = {
    id: reference,
    escrowId: randomEscrowId(reference),
    seller,
    amount,
    metadataURI: `local:${reference}`,
    outcome,
    status: "draft",
    contractAddress: contractAddress || undefined,
    createdAt: now,
    updatedAt: now,
  };

  records = [record, ...records.filter((item) => item.id !== reference)];
  selectedId = record.id;
  saveRecords();
  render();
  setStatus("Escrow draft created.");
}

async function deployContract(): Promise<void> {
  if (!walletClient || !account) {
    await connect();
  }
  if (!walletClient || !account) return;

  try {
    el.deployContract.disabled = true;
    setStatus("Deploying ArcEscrow contract...");
    const artifact = (await fetch("/public/artifacts/ArcEscrow.json").then((response) => response.json())) as Artifact;
    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      account,
      chain: arcTestnet,
    });
    setStatus(`Deploy submitted: ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) {
      throw new Error("Deployment receipt did not include a contract address.");
    }

    contractAddress = receipt.contractAddress;
    el.contractAddress.value = contractAddress;
    localStorage.setItem(CONTRACT_KEY, contractAddress);
    updateActions();
    setStatus(`ArcEscrow deployed at ${contractAddress}.`);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    el.deployContract.disabled = false;
  }
}

function saveContract(): void {
  const value = el.contractAddress.value.trim();
  if (!value) {
    contractAddress = "" as Address;
    localStorage.removeItem(CONTRACT_KEY);
    updateActions();
    setStatus("Contract address cleared.");
    return;
  }
  if (!isAddress(value)) {
    setStatus("Contract address must be valid.");
    return;
  }

  contractAddress = value as Address;
  localStorage.setItem(CONTRACT_KEY, contractAddress);
  updateActions();
  setStatus("Contract address saved.");
}

function statusFromChain(value: number): EscrowStatus {
  if (value === 1) return "funded";
  if (value === 2) return "released";
  if (value === 3) return "refunded";
  return "draft";
}

async function refreshSelected(): Promise<void> {
  const record = selectedRecord();
  if (!record || !contractAddress) return;

  try {
    setStatus("Reading escrow state...");
    const chainRecord = (await publicClient.readContract({
      address: contractAddress,
      abi: arcEscrowAbi,
      functionName: "getEscrow",
      args: [record.escrowId],
    })) as unknown;
    const chainValue = chainRecord as { status?: number } | readonly [Address, Address, bigint, number, string];
    const rawStatus = Array.isArray(chainValue) ? chainValue[3] : (chainValue as { status?: number }).status;
    const status = statusFromChain(Number(rawStatus ?? 0));

    record.status = status;
    record.updatedAt = new Date().toISOString();
    saveRecords();
    render();
    setStatus("Escrow state refreshed.");
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

async function fundEscrow(): Promise<void> {
  const record = selectedRecord();
  if (!record || !walletClient || !account || !contractAddress) return;

  try {
    el.fundEscrow.disabled = true;
    setStatus("Funding escrow...");
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi: arcEscrowAbi,
      functionName: "createEscrow",
      args: [record.escrowId, record.seller, record.metadataURI],
      account,
      chain: arcTestnet,
      value: parseEther(record.amount),
    });
    setStatus(`Fund submitted: ${hash}`);
    await publicClient.waitForTransactionReceipt({ hash });

    record.status = "funded";
    record.contractAddress = contractAddress;
    record.fundingTxHash = hash;
    record.updatedAt = new Date().toISOString();
    saveRecords();
    await refreshBalance();
    render();
    setStatus(`Escrow funded: ${hash}`);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    updateActions();
  }
}

async function settleEscrow(outcome: EscrowOutcome): Promise<void> {
  const record = selectedRecord();
  if (!record || !walletClient || !account || !contractAddress) return;

  try {
    el.releaseEscrow.disabled = true;
    el.refundEscrow.disabled = true;
    const functionName = outcome === "release" ? "releaseEscrow" : "refundEscrow";
    setStatus(`${outcome === "release" ? "Releasing" : "Refunding"} escrow...`);
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi: arcEscrowAbi,
      functionName,
      args: [record.escrowId],
      account,
      chain: arcTestnet,
    });
    setStatus(`Settlement submitted: ${hash}`);
    await publicClient.waitForTransactionReceipt({ hash });

    record.status = outcome === "release" ? "released" : "refunded";
    record.settlementTxHash = hash;
    record.updatedAt = new Date().toISOString();
    saveRecords();
    await refreshBalance();
    render();
    setStatus(`Escrow ${record.status}: ${hash}`);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    updateActions();
  }
}

el.connect.addEventListener("click", () => void connect());
el.deployContract.addEventListener("click", () => void deployContract());
el.saveContract.addEventListener("click", saveContract);
el.createDraft.addEventListener("click", createDraft);
el.fundEscrow.addEventListener("click", () => void fundEscrow());
el.releaseEscrow.addEventListener("click", () => void settleEscrow("release"));
el.refundEscrow.addEventListener("click", () => void settleEscrow("refund"));
el.refreshSelected.addEventListener("click", () => void refreshSelected());
el.contractAddress.addEventListener("input", updateActions);

render();
