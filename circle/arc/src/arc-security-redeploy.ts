import {
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  http,
  isAddress,
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

type Artifact = { abi: unknown[]; bytecode: Hash };
type Deployment = { address: Address; transactionHash: Hash };
type DeploymentRecord = {
  name: string;
  envKey: string;
  storageKey: string;
  oldAddress: Address | "";
  deployment?: Deployment;
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

const SESSION_KEY = "arcSecurityRedeploy.v1";
const definitions: DeploymentRecord[] = [
  {
    name: "ArcExpenseSplitter",
    envKey: "ARCEXPENSE_CONTRACT",
    storageKey: "arcExpense.contractAddress",
    oldAddress: "0xccd4bad1f974fda2167a7060942916bf3c148d93",
  },
  {
    name: "ArcEventTickets",
    envKey: "ARCEVENTTICKETS_CONTRACT",
    storageKey: "arcEventTickets.contractAddress",
    oldAddress: "0xca0ef47f4ab7be8d0a290186666f8b37af9856d7",
  },
  {
    name: "ArcMarketplaceOrders",
    envKey: "ARCMARKETPLACE_V2_CONTRACT",
    storageKey: "arcMarketplace.v2.contractAddress",
    oldAddress: "0x899b12725e72e343d442a3ff628117cdda353b87",
  },
  {
    name: "ArcServiceBookings",
    envKey: "ARCSERVICEBOOKINGS_CONTRACT",
    storageKey: "arcServiceBookings.contractAddress",
    oldAddress: "0x1f99c4b86918d1b3ae6635392800dd1ecadf6352",
  },
  {
    name: "ArcDonationJar",
    envKey: "ARCDONATION_CONTRACT",
    storageKey: "arcDonationJar.contractAddress",
    oldAddress: "0x9a677c873ca846c55175aad7c0be8a299e325870",
  },
  {
    name: "ArcPreorderStore",
    envKey: "ARCPREORDER_CONTRACT",
    storageKey: "arcPreorderStore.contractAddress",
    oldAddress: "0x7c97d3eff8681ea4c7bb3354d1b4d827141934e9",
  },
  {
    name: "ArcRefundableDeposit",
    envKey: "ARCREFUNDABLEDEPOSIT_CONTRACT",
    storageKey: "arcRefundableDeposit.contractAddress",
    oldAddress: "0xcad7f2503eb90e38063aa2385fc4616db0e9f147",
  },
  {
    name: "ArcAuctionHouse",
    envKey: "ARCAUCTION_CONTRACT",
    storageKey: "ArcAuctionHouse.contractAddress",
    oldAddress: "",
  },
  {
    name: "ArcRentalEscrow",
    envKey: "ARCRENTAL_CONTRACT",
    storageKey: "ArcRentalEscrow.contractAddress",
    oldAddress: "0x69177a3ce61b80e28709a1a9f873ec1a23d77076",
  },
];

const publicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET.rpcUrls[0]) });
let records = restoreRecords();
let selectedProvider: EIP1193Provider | null = null;
let walletClient: ReturnType<typeof createWalletClient> | null = null;
let account: Address | null = null;

const el = {
  account: document.querySelector<HTMLElement>("#account")!,
  balance: document.querySelector<HTMLElement>("#balance")!,
  connect: document.querySelector<HTMLButtonElement>("#connect")!,
  deployNext: document.querySelector<HTMLButtonElement>("#deployNext")!,
  envOutput: document.querySelector<HTMLTextAreaElement>("#envOutput")!,
  exportManifest: document.querySelector<HTMLButtonElement>("#exportManifest")!,
  rows: document.querySelector<HTMLElement>("#deploymentRows")!,
  status: document.querySelector<HTMLElement>("#status")!,
};

function restoreRecords(): DeploymentRecord[] {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "[]") as DeploymentRecord[];
    return definitions.map((definition) => {
      const match = saved.find((item) => item.name === definition.name);
      return match?.deployment ? { ...definition, deployment: match.deployment } : definition;
    });
  } catch {
    return definitions;
  }
}

function persist(): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(records));
}

function explorerAddress(address: string): string {
  return `https://testnet.arcscan.app/address/${address}`;
}

function explorerTransaction(hash: string): string {
  return `https://testnet.arcscan.app/tx/${hash}`;
}

function short(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function setStatus(message: string, hash?: Hash): void {
  el.status.innerHTML = hash
    ? `${escapeHtml(message)} <a href="${explorerTransaction(hash)}" target="_blank" rel="noreferrer">${hash}</a>`
    : escapeHtml(message);
}

function render(): void {
  el.rows.innerHTML = records
    .map((record, index) => {
      const oldAddress = record.oldAddress
        ? `<a href="${explorerAddress(record.oldAddress)}" target="_blank" rel="noreferrer">${short(record.oldAddress)}</a>`
        : "-";
      const deployment = record.deployment;
      const next = !deployment && records.findIndex((item) => !item.deployment) === index;
      const status = deployment ? "deployed" : next ? "next" : "pending";
      const newAddress = deployment
        ? `<a href="${explorerAddress(deployment.address)}" target="_blank" rel="noreferrer">${short(deployment.address)}</a>`
        : "-";
      return `<tr><td>${index + 1}</td><td>${record.name}</td><td>${oldAddress}</td><td>${newAddress}</td><td><span class="state ${status}">${status}</span></td></tr>`;
    })
    .join("");

  el.envOutput.value = records
    .filter((record) => record.deployment)
    .map((record) => `${record.envKey}=${record.deployment?.address}`)
    .join("\n");

  const next = records.find((record) => !record.deployment);
  el.deployNext.textContent = next ? `Deploy ${next.name}` : "Deployment complete";
  el.deployNext.disabled = !walletClient || !account || !next;
  el.exportManifest.disabled = records.every((record) => !record.deployment);
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
    if (detail?.provider) announced.push({ provider: detail.provider, name: detail.info?.name, rdns: detail.info?.rdns });
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

async function ensureArc(provider: EIP1193Provider): Promise<void> {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC_TESTNET.chainId }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [ARC_TESTNET] });
  }
}

async function connect(): Promise<void> {
  try {
    setStatus("Connecting MetaMask...");
    selectedProvider = await getEthereumProvider();
    await ensureArc(selectedProvider);
    const accounts = (await selectedProvider.request({ method: "eth_requestAccounts" })) as Address[];
    account = accounts[0] ?? null;
    if (!account || !isAddress(account)) throw new Error("No wallet account returned.");
    walletClient = createWalletClient({ account, chain: arcTestnet, transport: custom(selectedProvider) });
    el.account.textContent = account;
    el.balance.textContent = `${formatEther(await publicClient.getBalance({ address: account }))} USDC`;
    el.connect.textContent = "Connected";
    setStatus("Wallet ready. Each deployment requires one MetaMask confirmation.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Wallet connection failed.");
  } finally {
    render();
  }
}

async function deployNext(): Promise<void> {
  if (!walletClient || !account) await connect();
  if (!walletClient || !account) return;
  const index = records.findIndex((record) => !record.deployment);
  if (index < 0) return;
  const record = records[index];

  try {
    el.deployNext.disabled = true;
    setStatus(`Loading ${record.name} artifact...`);
    const artifact = (await fetch(`/public/artifacts/${record.name}.json`).then((response) => {
      if (!response.ok) throw new Error(`Artifact not found: ${record.name}`);
      return response.json();
    })) as Artifact;

    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      account,
      chain: arcTestnet,
    });
    setStatus(`${record.name} deployment submitted:`, hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${record.name} deployment reverted.`);
    const code = await publicClient.getCode({ address: receipt.contractAddress });
    if (!code || code === "0x") throw new Error(`${record.name} deployed without runtime code.`);

    records[index] = { ...record, deployment: { address: receipt.contractAddress, transactionHash: hash } };
    localStorage.setItem(record.storageKey, receipt.contractAddress);
    persist();
    setStatus(`${record.name} deployed and runtime code verified:`, hash);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : `${record.name} deployment failed.`);
  } finally {
    render();
  }
}

function exportManifest(): void {
  const payload = {
    chainId: arcTestnet.id,
    chain: arcTestnet.name,
    deployer: account,
    exportedAt: new Date().toISOString(),
    contracts: records.filter((record) => record.deployment),
  };
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "arc-security-deployments.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

el.connect.addEventListener("click", () => void connect());
el.deployNext.addEventListener("click", () => void deployNext());
el.exportManifest.addEventListener("click", exportManifest);
render();
