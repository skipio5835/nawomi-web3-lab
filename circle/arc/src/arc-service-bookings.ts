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

type Artifact = {
  abi: unknown[];
  bytecode: Hash;
};

type ServiceSummary = {
  provider: Address;
  treasury: Address;
  price: bigint;
  maxBookings: bigint;
  booked: bigint;
  completed: bigint;
  refunded: bigint;
  settledAmount: bigint;
  createdAt: bigint;
  active: boolean;
  title: string;
  metadataURI: string;
};

type BookingSummary = {
  client: Address;
  amount: bigint;
  bookedAt: bigint;
  completed: boolean;
  refunded: boolean;
  completionURI: string;
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

const CONTRACT_KEY = "arcServiceBookings.contractAddress";
const DEFAULT_ACCOUNT = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const arcServiceBookingsAbi = [
  {
    inputs: [
      { internalType: "bytes32", name: "serviceId", type: "bytes32" },
      { internalType: "address", name: "treasury", type: "address" },
      { internalType: "uint256", name: "price", type: "uint256" },
      { internalType: "uint256", name: "maxBookings", type: "uint256" },
      { internalType: "string", name: "title", type: "string" },
      { internalType: "string", name: "metadataURI", type: "string" },
    ],
    name: "createService",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "serviceId", type: "bytes32" }],
    name: "bookService",
    outputs: [{ internalType: "uint256", name: "bookingId", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "serviceId", type: "bytes32" },
      { internalType: "uint256", name: "bookingId", type: "uint256" },
      { internalType: "string", name: "completionURI", type: "string" },
    ],
    name: "completeBooking",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "serviceId", type: "bytes32" },
      { internalType: "uint256", name: "bookingId", type: "uint256" },
      { internalType: "address payable", name: "refundTo", type: "address" },
    ],
    name: "refundBooking",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "serviceId", type: "bytes32" },
      { internalType: "address payable", name: "to", type: "address" },
    ],
    name: "settleService",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "serviceId", type: "bytes32" }],
    name: "getService",
    outputs: [
      {
        components: [
          { internalType: "address", name: "provider", type: "address" },
          { internalType: "address", name: "treasury", type: "address" },
          { internalType: "uint256", name: "price", type: "uint256" },
          { internalType: "uint256", name: "maxBookings", type: "uint256" },
          { internalType: "uint256", name: "booked", type: "uint256" },
          { internalType: "uint256", name: "completed", type: "uint256" },
          { internalType: "uint256", name: "refunded", type: "uint256" },
          { internalType: "uint256", name: "settledAmount", type: "uint256" },
          { internalType: "uint64", name: "createdAt", type: "uint64" },
          { internalType: "bool", name: "active", type: "bool" },
          { internalType: "string", name: "title", type: "string" },
          { internalType: "string", name: "metadataURI", type: "string" },
        ],
        internalType: "struct ArcServiceBookings.Service",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "serviceId", type: "bytes32" },
      { internalType: "uint256", name: "bookingId", type: "uint256" },
    ],
    name: "getBooking",
    outputs: [
      {
        components: [
          { internalType: "address", name: "client", type: "address" },
          { internalType: "uint256", name: "amount", type: "uint256" },
          { internalType: "uint64", name: "bookedAt", type: "uint64" },
          { internalType: "bool", name: "completed", type: "bool" },
          { internalType: "bool", name: "refunded", type: "bool" },
          { internalType: "string", name: "completionURI", type: "string" },
        ],
        internalType: "struct ArcServiceBookings.Booking",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "serviceId", type: "bytes32" },
      { internalType: "address", name: "client", type: "address" },
    ],
    name: "getBookingOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
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
let contractAddress = (localStorage.getItem(CONTRACT_KEY) ?? "") as Address | "";
let currentService: ServiceSummary | null = null;
let currentBooking: BookingSummary | null = null;
let currentBookingId = 0n;

const el = {
  buyBooking: document.querySelector<HTMLButtonElement>("#buyBooking")!,
  connect: document.querySelector<HTMLButtonElement>("#connect")!,
  contractAddress: document.querySelector<HTMLInputElement>("#contractAddress")!,
  createService: document.querySelector<HTMLButtonElement>("#createService")!,
  deployContract: document.querySelector<HTMLButtonElement>("#deployContract")!,
  completeBooking: document.querySelector<HTMLButtonElement>("#completeBooking")!,
  completionURI: document.querySelector<HTMLInputElement>("#completionURI")!,
  serviceId: document.querySelector<HTMLElement>("#serviceId")!,
  serviceStatus: document.querySelector<HTMLElement>("#serviceStatus")!,
  maxBookings: document.querySelector<HTMLInputElement>("#maxBookings")!,
  metadataURI: document.querySelector<HTMLInputElement>("#metadataURI")!,
  nativeBalance: document.querySelector<HTMLElement>("#nativeBalance")!,
  bookingId: document.querySelector<HTMLElement>("#bookingId")!,
  bookingStatus: document.querySelector<HTMLElement>("#bookingStatus")!,
  price: document.querySelector<HTMLInputElement>("#price")!,
  refresh: document.querySelector<HTMLButtonElement>("#refresh")!,
  refundBooking: document.querySelector<HTMLButtonElement>("#refundBooking")!,
  refundTo: document.querySelector<HTMLInputElement>("#refundTo")!,
  saveContract: document.querySelector<HTMLButtonElement>("#saveContract")!,
  providerAddress: document.querySelector<HTMLElement>("#providerAddress")!,
  settleService: document.querySelector<HTMLButtonElement>("#settleService")!,
  settlementTo: document.querySelector<HTMLInputElement>("#settlementTo")!,
  statusLine: document.querySelector<HTMLElement>("#statusLine")!,
  supplyStatus: document.querySelector<HTMLElement>("#supplyStatus")!,
  title: document.querySelector<HTMLInputElement>("#title")!,
  treasury: document.querySelector<HTMLInputElement>("#treasury")!,
  walletAddress: document.querySelector<HTMLElement>("#walletAddress")!,
};

const today = new Date().toISOString().slice(0, 10);
el.contractAddress.value = contractAddress;
el.completionURI.value = `local:arc-service-booking-${today}:completed`;
el.maxBookings.value = "5";
el.metadataURI.value = `local:arc-service-${today}`;
el.price.value = "0.005";
el.refundTo.value = DEFAULT_ACCOUNT;
el.settlementTo.value = DEFAULT_ACCOUNT;
el.title.value = `arc-service-${today}`;
el.treasury.value = DEFAULT_ACCOUNT;

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

function txUrl(hash: string): string {
  return `https://testnet.arcscan.app/tx/${hash}`;
}

function addressUrl(address: string): string {
  return `https://testnet.arcscan.app/address/${address}`;
}

function shortValue(value?: string): string {
  if (!value || value === ZERO_ADDRESS) return "-";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function setStatus(message: string, hash?: Hash): void {
  el.statusLine.innerHTML = hash
    ? `${escapeHtml(message)} <a href="${txUrl(hash)}" target="_blank" rel="noreferrer">${hash}</a>`
    : escapeHtml(message);
}

function errorMessage(error: unknown): string {
  console.error(error);
  return error instanceof Error ? error.message : "Unknown error.";
}

function serviceId(): Hash {
  const title = el.title.value.trim();
  if (!title) throw new Error("Title is required.");
  const provider = account?.toLowerCase() ?? DEFAULT_ACCOUNT.toLowerCase();
  return keccak256(toBytes(`${provider}:${title}`));
}

function serviceFromRaw(value: unknown): ServiceSummary {
  if (!Array.isArray(value)) {
    const object = value as Partial<ServiceSummary>;
    return {
      provider: object.provider ?? ZERO_ADDRESS,
      treasury: object.treasury ?? ZERO_ADDRESS,
      price: object.price ?? 0n,
      maxBookings: object.maxBookings ?? 0n,
      booked: object.booked ?? 0n,
      completed: object.completed ?? 0n,
      refunded: object.refunded ?? 0n,
      settledAmount: object.settledAmount ?? 0n,
      createdAt: object.createdAt ?? 0n,
      active: Boolean(object.active),
      title: object.title ?? "",
      metadataURI: object.metadataURI ?? "",
    };
  }

  return {
    provider: value[0] as Address,
    treasury: value[1] as Address,
    price: value[2] as bigint,
    maxBookings: value[3] as bigint,
    booked: value[4] as bigint,
    completed: value[5] as bigint,
    refunded: value[6] as bigint,
    settledAmount: value[7] as bigint,
    createdAt: value[8] as bigint,
    active: Boolean(value[9]),
    title: value[10] as string,
    metadataURI: value[11] as string,
  };
}

function bookingFromRaw(value: unknown): BookingSummary {
  if (!Array.isArray(value)) {
    const object = value as Partial<BookingSummary>;
    return {
      client: object.client ?? ZERO_ADDRESS,
      amount: object.amount ?? 0n,
      bookedAt: object.bookedAt ?? 0n,
      completed: Boolean(object.completed),
      refunded: Boolean(object.refunded),
      completionURI: object.completionURI ?? "",
    };
  }

  return {
    client: value[0] as Address,
    amount: value[1] as bigint,
    bookedAt: value[2] as bigint,
    completed: Boolean(value[3]),
    refunded: Boolean(value[4]),
    completionURI: value[5] as string,
  };
}

function updateServiceIdDisplay(): void {
  try {
    el.serviceId.textContent = serviceId();
  } catch {
    el.serviceId.textContent = "-";
  }
}

function renderService(): void {
  updateServiceIdDisplay();

  if (!currentService || currentService.provider === ZERO_ADDRESS) {
    el.serviceStatus.textContent = "not created";
    el.bookingId.textContent = "-";
    el.bookingStatus.textContent = "none";
    el.providerAddress.textContent = "-";
    el.supplyStatus.textContent = "0 / 0";
    updateActions();
    return;
  }

  const gross = currentService.price * currentService.booked;
  const available = gross - currentService.refunded - currentService.settledAmount;
  el.serviceStatus.textContent = currentService.active ? "active" : "inactive";
  el.providerAddress.innerHTML = `<a href="${addressUrl(currentService.provider)}" target="_blank" rel="noreferrer">${shortValue(
    currentService.provider,
  )}</a>`;
  el.supplyStatus.textContent = `${currentService.booked.toString()} / ${currentService.maxBookings.toString()}, ${formatEther(
    available,
  )} USDC available`;
  el.bookingId.textContent = currentBookingId > 0n ? currentBookingId.toString() : "-";
  el.bookingStatus.textContent = currentBooking
    ? currentBooking.refunded
      ? "refunded"
      : currentBooking.completed
        ? "completed"
        : "booked"
    : "none";
  updateActions();
}

function updateActions(): void {
  const hasWallet = Boolean(walletClient && account);
  const hasContract = Boolean(contractAddress && isAddress(contractAddress));
  const hasService = Boolean(currentService && currentService.provider !== ZERO_ADDRESS);
  const active = hasService && Boolean(currentService?.active);
  const hasBooking = Boolean(currentBooking && currentBooking.client !== ZERO_ADDRESS);
  const canComplete = active && hasBooking && !currentBooking?.completed && !currentBooking?.refunded;
  const gross = currentService ? currentService.price * currentService.booked : 0n;
  const available = currentService ? gross - currentService.refunded - currentService.settledAmount : 0n;

  el.buyBooking.disabled = !hasWallet || !hasContract || !active || hasBooking;
  el.createService.disabled = !hasWallet || !hasContract || hasService;
  el.deployContract.disabled = !hasWallet;
  el.completeBooking.disabled = !hasWallet || !hasContract || !canComplete;
  el.refresh.disabled = !hasContract;
  el.refundBooking.disabled = !hasWallet || !hasContract || !active || !hasBooking || Boolean(currentBooking?.completed);
  el.settleService.disabled = !hasWallet || !hasContract || !hasService || available === 0n;
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
      announced.push({ provider: detail.provider, name: detail.info?.name, rdns: detail.info?.rdns });
    }
  };

  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);

  const metaMask = announced.find((item) => `${item.name ?? ""} ${item.rdns ?? ""}`.toLowerCase().includes("metamask"));
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
    el.refundTo.value = account;
    el.settlementTo.value = account;
    el.treasury.value = account;
    el.connect.textContent = "Connected";
    updateServiceIdDisplay();
    await refreshBalance();
    updateActions();
    setStatus("Wallet ready.");
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

async function deployContract(): Promise<void> {
  if (!walletClient || !account) await connect();
  if (!walletClient || !account) return;

  try {
    el.deployContract.disabled = true;
    setStatus("Deploying ArcServiceBookings...");
    const artifact = (await fetch("/public/artifacts/ArcServiceBookings.json").then((response) =>
      response.json(),
    )) as Artifact;
    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      account,
      chain: arcTestnet,
    });
    setStatus("Deploy submitted:", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("Deployment receipt did not include a contract address.");

    contractAddress = receipt.contractAddress;
    el.contractAddress.value = contractAddress;
    localStorage.setItem(CONTRACT_KEY, contractAddress);
    setStatus(`ArcServiceBookings deployed at ${contractAddress}.`);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    updateActions();
  }
}

function saveContract(): void {
  const value = el.contractAddress.value.trim();
  if (!value) {
    contractAddress = "" as Address;
    localStorage.removeItem(CONTRACT_KEY);
    currentService = null;
    currentBooking = null;
    currentBookingId = 0n;
    renderService();
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

async function refreshService(): Promise<void> {
  if (!contractAddress || !isAddress(contractAddress)) {
    setStatus("Deploy or paste a valid contract address first.");
    return;
  }

  try {
    setStatus("Reading service state...");
    const id = serviceId();
    const rawService = await publicClient.readContract({
      address: contractAddress,
      abi: arcServiceBookingsAbi,
      functionName: "getService",
      args: [id],
    });
    currentService = serviceFromRaw(rawService);

    currentBookingId = 0n;
    currentBooking = null;
    if (account) {
      currentBookingId = await publicClient.readContract({
        address: contractAddress,
        abi: arcServiceBookingsAbi,
        functionName: "getBookingOf",
        args: [id, account],
      });

      if (currentBookingId > 0n) {
        const rawBooking = await publicClient.readContract({
          address: contractAddress,
          abi: arcServiceBookingsAbi,
          functionName: "getBooking",
          args: [id, currentBookingId],
        });
        currentBooking = bookingFromRaw(rawBooking);
      }
    }

    renderService();
    setStatus("Service state refreshed.");
  } catch (error) {
    setStatus(errorMessage(error));
  }
}

async function createService(): Promise<void> {
  if (!walletClient || !account) await connect();
  if (!walletClient || !account || !contractAddress) return;

  try {
    el.createService.disabled = true;
    const title = el.title.value.trim();
    const metadataURI = el.metadataURI.value.trim();
    const treasury = el.treasury.value.trim();
    if (!title) throw new Error("Title is required.");
    if (!metadataURI) throw new Error("Metadata URI is required.");
    if (!isAddress(treasury)) throw new Error("Treasury must be a valid EVM address.");
    const price = parseEther(el.price.value.trim());
    const maxBookings = BigInt(el.maxBookings.value.trim());

    setStatus("Creating service...");
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi: arcServiceBookingsAbi,
      functionName: "createService",
      args: [serviceId(), treasury as Address, price, maxBookings, title, metadataURI],
      account,
      chain: arcTestnet,
    });
    setStatus("Create submitted:", hash);
    await publicClient.waitForTransactionReceipt({ hash });
    await refreshService();
    setStatus("Service created:", hash);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    updateActions();
  }
}

async function buyBooking(): Promise<void> {
  if (!walletClient || !account) await connect();
  if (!walletClient || !account || !contractAddress || !currentService) return;

  try {
    el.buyBooking.disabled = true;
    setStatus("Booking service...");
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi: arcServiceBookingsAbi,
      functionName: "bookService",
      args: [serviceId()],
      account,
      chain: arcTestnet,
      value: currentService.price,
    });
    setStatus("Booking submitted:", hash);
    await publicClient.waitForTransactionReceipt({ hash });
    await refreshBalance();
    await refreshService();
    setStatus("Service booked:", hash);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    updateActions();
  }
}

async function completeBooking(): Promise<void> {
  if (!walletClient || !account) await connect();
  if (!walletClient || !account || !contractAddress || currentBookingId === 0n) return;

  try {
    el.completeBooking.disabled = true;
    const completionURI = el.completionURI.value.trim();
    if (!completionURI) throw new Error("Completion URI is required.");

    setStatus("Completing booking...");
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi: arcServiceBookingsAbi,
      functionName: "completeBooking",
      args: [serviceId(), currentBookingId, completionURI],
      account,
      chain: arcTestnet,
    });
    setStatus("Complete submitted:", hash);
    await publicClient.waitForTransactionReceipt({ hash });
    await refreshService();
    setStatus("Booking completed:", hash);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    updateActions();
  }
}

async function refundBooking(): Promise<void> {
  if (!walletClient || !account) await connect();
  if (!walletClient || !account || !contractAddress || currentBookingId === 0n) return;

  try {
    el.refundBooking.disabled = true;
    const refundTo = el.refundTo.value.trim();
    if (!isAddress(refundTo)) throw new Error("Refund address must be a valid EVM address.");

    setStatus("Refunding booking...");
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi: arcServiceBookingsAbi,
      functionName: "refundBooking",
      args: [serviceId(), currentBookingId, refundTo as Address],
      account,
      chain: arcTestnet,
    });
    setStatus("Refund submitted:", hash);
    await publicClient.waitForTransactionReceipt({ hash });
    await refreshBalance();
    await refreshService();
    setStatus("Booking refunded:", hash);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    updateActions();
  }
}

async function settleService(): Promise<void> {
  if (!walletClient || !account) await connect();
  if (!walletClient || !account || !contractAddress) return;

  try {
    el.settleService.disabled = true;
    const settlementTo = el.settlementTo.value.trim();
    if (!isAddress(settlementTo)) throw new Error("Settlement address must be a valid EVM address.");

    setStatus("Settling service revenue...");
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi: arcServiceBookingsAbi,
      functionName: "settleService",
      args: [serviceId(), settlementTo as Address],
      account,
      chain: arcTestnet,
    });
    setStatus("Settle submitted:", hash);
    await publicClient.waitForTransactionReceipt({ hash });
    await refreshBalance();
    await refreshService();
    setStatus("Service settled:", hash);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    updateActions();
  }
}

el.buyBooking.addEventListener("click", () => void buyBooking());
el.connect.addEventListener("click", () => void connect());
el.contractAddress.addEventListener("input", updateActions);
el.createService.addEventListener("click", () => void createService());
el.deployContract.addEventListener("click", () => void deployContract());
el.completeBooking.addEventListener("click", () => void completeBooking());
el.refresh.addEventListener("click", () => void refreshService());
el.refundBooking.addEventListener("click", () => void refundBooking());
el.saveContract.addEventListener("click", saveContract);
el.settleService.addEventListener("click", () => void settleService());
el.title.addEventListener("input", () => {
  currentService = null;
  currentBooking = null;
  currentBookingId = 0n;
  renderService();
});

renderService();

