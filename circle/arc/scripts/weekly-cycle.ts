const DEFAULT_METAMASK = "0x0000000000000000000000000000000000000000";
const DEFAULT_CIRCLE_WALLET = "0x78131700be4a8f2d16eeb0cba3498d2e717f2cd3";
const SKIPIO_CONTRACT = "0x724038D2B4c1EbE69DC8B29cc5d591C4caA21918";
const ARCP_CONTRACT = "0x7A30aad0AA76bF8D2C14B9Eef035C07EEFDcdA8f";
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const MEMO_CONTRACT = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
const MULTICALL3FROM_CONTRACT = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";
const DEFAULT_ARCINVOICE_CONTRACT = "0xda11c8b98f17164180eed93c4b62bc60407692d1";
const DEFAULT_ARCESCROW_CONTRACT = "0x679b3456100a3102e81ba60b54a400443fe20558";
const DEFAULT_ARCSUBSCRIPTION_CONTRACT = "0x89b7bde935505992bf33f838359613ed9cdfaed0";
const CCTP_BRIDGE_CONTRACT = "0xC5567a5E3370d4DBfB0540025078e283e36A363d";
const CCTP_MESSAGE_TRANSMITTER_V2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const BASE_URL = `http://localhost:${process.env.PORT ?? "4173"}`;

const metamaskAddress = process.env.METAMASK_ADDRESS?.trim() || DEFAULT_METAMASK;
const circleWalletAddress = process.env.WALLET_ADDRESS?.trim() || DEFAULT_CIRCLE_WALLET;
const arcInvoiceContract = process.env.ARCINVOICE_CONTRACT?.trim() || DEFAULT_ARCINVOICE_CONTRACT;
const arcEscrowContract = process.env.ARCESCROW_CONTRACT?.trim() || DEFAULT_ARCESCROW_CONTRACT;
const arcSubscriptionContract = process.env.ARCSUBSCRIPTION_CONTRACT?.trim() || DEFAULT_ARCSUBSCRIPTION_CONTRACT;

type DailyPlan = {
  sendAmount: string;
  swapAmount: string;
  swapTokenIn: "USDC" | "EURC";
  swapTokenOut: "USDC" | "EURC";
  bridgeAmount: string;
  bridgeTo: "Ethereum_Sepolia" | "Base_Sepolia";
  rawCctpAmount: string;
  rawCctpTo: "Ethereum_Sepolia" | "Base_Sepolia";
  unifiedDeposit: string;
  unifiedSpend: string;
  tokenPreset: "ARCP / ProofToken" | "SKIPIO";
  tokenAmount: string;
  allowanceAmount: string;
  delegatedTransferAmount: string;
  devWalletAmount: string;
};

type Step = {
  title: string;
  url?: string;
  command?: string;
  fields: string[];
  proof: string;
};

type ProductPlan = {
  memoAmount: string;
  batchCircleAmount: string;
  batchSelfAmount: string;
  invoiceAmount: string;
  escrowAmount: string;
  escrowOutcome: "release" | "refund";
  subscriptionPrice: string;
  subscriptionPeriodDays: string;
  subscriptionCycles: string;
};

const dailyPlans: DailyPlan[] = [
  {
    sendAmount: "0.007",
    swapAmount: "0.01",
    swapTokenIn: "USDC",
    swapTokenOut: "EURC",
    bridgeAmount: "0.05",
    bridgeTo: "Ethereum_Sepolia",
    rawCctpAmount: "0.02",
    rawCctpTo: "Base_Sepolia",
    unifiedDeposit: "0.05",
    unifiedSpend: "0.005",
    tokenPreset: "ARCP / ProofToken",
    tokenAmount: "1",
    allowanceAmount: "1",
    delegatedTransferAmount: "0.25",
    devWalletAmount: "0.005",
  },
  {
    sendAmount: "0.009",
    swapAmount: "0.01",
    swapTokenIn: "EURC",
    swapTokenOut: "USDC",
    bridgeAmount: "0.06",
    bridgeTo: "Base_Sepolia",
    rawCctpAmount: "0.025",
    rawCctpTo: "Ethereum_Sepolia",
    unifiedDeposit: "0.06",
    unifiedSpend: "0.006",
    tokenPreset: "SKIPIO",
    tokenAmount: "2",
    allowanceAmount: "2",
    delegatedTransferAmount: "0.4",
    devWalletAmount: "0.006",
  },
  {
    sendAmount: "0.011",
    swapAmount: "0.015",
    swapTokenIn: "USDC",
    swapTokenOut: "EURC",
    bridgeAmount: "0.07",
    bridgeTo: "Ethereum_Sepolia",
    rawCctpAmount: "0.03",
    rawCctpTo: "Base_Sepolia",
    unifiedDeposit: "0.07",
    unifiedSpend: "0.007",
    tokenPreset: "ARCP / ProofToken",
    tokenAmount: "3",
    allowanceAmount: "3",
    delegatedTransferAmount: "0.75",
    devWalletAmount: "0.007",
  },
  {
    sendAmount: "0.013",
    swapAmount: "0.015",
    swapTokenIn: "EURC",
    swapTokenOut: "USDC",
    bridgeAmount: "0.08",
    bridgeTo: "Base_Sepolia",
    rawCctpAmount: "0.035",
    rawCctpTo: "Ethereum_Sepolia",
    unifiedDeposit: "0.08",
    unifiedSpend: "0.008",
    tokenPreset: "SKIPIO",
    tokenAmount: "1",
    allowanceAmount: "1",
    delegatedTransferAmount: "0.3",
    devWalletAmount: "0.008",
  },
  {
    sendAmount: "0.015",
    swapAmount: "0.02",
    swapTokenIn: "USDC",
    swapTokenOut: "EURC",
    bridgeAmount: "0.09",
    bridgeTo: "Ethereum_Sepolia",
    rawCctpAmount: "0.04",
    rawCctpTo: "Base_Sepolia",
    unifiedDeposit: "0.09",
    unifiedSpend: "0.009",
    tokenPreset: "ARCP / ProofToken",
    tokenAmount: "2",
    allowanceAmount: "2",
    delegatedTransferAmount: "0.5",
    devWalletAmount: "0.009",
  },
  {
    sendAmount: "0.017",
    swapAmount: "0.02",
    swapTokenIn: "EURC",
    swapTokenOut: "USDC",
    bridgeAmount: "0.10",
    bridgeTo: "Base_Sepolia",
    rawCctpAmount: "0.045",
    rawCctpTo: "Ethereum_Sepolia",
    unifiedDeposit: "0.10",
    unifiedSpend: "0.01",
    tokenPreset: "SKIPIO",
    tokenAmount: "3",
    allowanceAmount: "3",
    delegatedTransferAmount: "0.9",
    devWalletAmount: "0.01",
  },
  {
    sendAmount: "0.019",
    swapAmount: "0.012",
    swapTokenIn: "USDC",
    swapTokenOut: "EURC",
    bridgeAmount: "0.055",
    bridgeTo: "Ethereum_Sepolia",
    rawCctpAmount: "0.05",
    rawCctpTo: "Base_Sepolia",
    unifiedDeposit: "0.055",
    unifiedSpend: "0.0055",
    tokenPreset: "ARCP / ProofToken",
    tokenAmount: "5",
    allowanceAmount: "5",
    delegatedTransferAmount: "1.25",
    devWalletAmount: "0.0055",
  },
];

const productPlans: ProductPlan[] = [
  {
    memoAmount: "0.003",
    batchCircleAmount: "0.002",
    batchSelfAmount: "0.001",
    invoiceAmount: "0.01",
    escrowAmount: "0.004",
    escrowOutcome: "release",
    subscriptionPrice: "0.003",
    subscriptionPeriodDays: "7",
    subscriptionCycles: "1",
  },
  {
    memoAmount: "0.004",
    batchCircleAmount: "0.002",
    batchSelfAmount: "0.002",
    invoiceAmount: "0.02",
    escrowAmount: "0.005",
    escrowOutcome: "refund",
    subscriptionPrice: "0.004",
    subscriptionPeriodDays: "14",
    subscriptionCycles: "1",
  },
  {
    memoAmount: "0.005",
    batchCircleAmount: "0.003",
    batchSelfAmount: "0.002",
    invoiceAmount: "0.01",
    escrowAmount: "0.006",
    escrowOutcome: "release",
    subscriptionPrice: "0.005",
    subscriptionPeriodDays: "7",
    subscriptionCycles: "2",
  },
  {
    memoAmount: "0.006",
    batchCircleAmount: "0.004",
    batchSelfAmount: "0.002",
    invoiceAmount: "0.03",
    escrowAmount: "0.007",
    escrowOutcome: "refund",
    subscriptionPrice: "0.006",
    subscriptionPeriodDays: "30",
    subscriptionCycles: "1",
  },
  {
    memoAmount: "0.007",
    batchCircleAmount: "0.004",
    batchSelfAmount: "0.003",
    invoiceAmount: "0.02",
    escrowAmount: "0.008",
    escrowOutcome: "release",
    subscriptionPrice: "0.007",
    subscriptionPeriodDays: "14",
    subscriptionCycles: "2",
  },
  {
    memoAmount: "0.008",
    batchCircleAmount: "0.005",
    batchSelfAmount: "0.003",
    invoiceAmount: "0.01",
    escrowAmount: "0.009",
    escrowOutcome: "refund",
    subscriptionPrice: "0.008",
    subscriptionPeriodDays: "7",
    subscriptionCycles: "1",
  },
  {
    memoAmount: "0.009",
    batchCircleAmount: "0.006",
    batchSelfAmount: "0.003",
    invoiceAmount: "0.02",
    escrowAmount: "0.01",
    escrowOutcome: "release",
    subscriptionPrice: "0.009",
    subscriptionPeriodDays: "30",
    subscriptionCycles: "1",
  },
];

function todayKey(): string {
  const override = process.env.CYCLE_DATE?.trim();
  if (override) {
    return override;
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function dayOfYear(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error("CYCLE_DATE must use YYYY-MM-DD format.");
  }

  const start = Date.UTC(year, 0, 1);
  const current = Date.UTC(year, month - 1, day);
  return Math.floor((current - start) / 86_400_000) + 1;
}

function devWalletCommand(amount: string): string {
  return `$env:DEV_WALLET_TRANSFER_AMOUNT="${amount}"; npm.cmd run dev-wallet-usdc-transfer; Remove-Item Env:\\DEV_WALLET_TRANSFER_AMOUNT`;
}

function issuedTokenContract(tokenPreset: DailyPlan["tokenPreset"]): string {
  return tokenPreset === "SKIPIO" ? SKIPIO_CONTRACT : ARCP_CONTRACT;
}

function devWalletTransferFromCommand(tokenPreset: DailyPlan["tokenPreset"], amount: string): string {
  return [
    `$env:DELEGATED_TOKEN_CONTRACT="${issuedTokenContract(tokenPreset)}"`,
    `$env:DELEGATED_TRANSFER_AMOUNT="${amount}"`,
    "npm.cmd run dev-wallet-transfer-from",
    "Remove-Item Env:\\DELEGATED_TOKEN_CONTRACT",
    "Remove-Item Env:\\DELEGATED_TRANSFER_AMOUNT",
  ].join("; ");
}

const cycleDate = todayKey();
const planIndex = (dayOfYear(cycleDate) - 1) % dailyPlans.length;
const plan = dailyPlans[planIndex];
const productPlan = productPlans[planIndex];
const memoReference = `arc-receipt-${cycleDate}-v${planIndex + 1}`;
const invoiceLabel = `Arc Daily Invoice ${cycleDate} v${planIndex + 1}`;
const cancelInvoiceLabel = `Arc Cancel Invoice ${cycleDate} v${planIndex + 1}`;
const escrowReference = `arc-escrow-${cycleDate}-v${planIndex + 1}`;
const subscriptionReference = `arc-subscription-${cycleDate}-v${planIndex + 1}`;

const steps: Step[] = [
  {
    title: "1. App Kit Send",
    url: `${BASE_URL}/public/appkit-send.html`,
    fields: [
      `Recipient: ${circleWalletAddress}`,
      `Token: ${USDC_ADDRESS}`,
      `Amount: ${plan.sendAmount}`,
    ],
    proof: "Save txHash/explorer after MetaMask signs.",
  },
  {
    title: "2. App Kit Swap",
    url: `${BASE_URL}/public/appkit-swap.html?proxy=1`,
    fields: [
      "KIT_KEY: paste manually in the page. Do not save it in chat.",
      `Token in: ${plan.swapTokenIn}`,
      `Token out: ${plan.swapTokenOut}`,
      `Amount in: ${plan.swapAmount}`,
      "Fallback if balance/liquidity is short: USDC -> EURC, Amount in: 0.01",
    ],
    proof: "Save txHash/explorer after swap confirms.",
  },
  {
    title: "3. App Kit Bridge",
    url: `${BASE_URL}/public/appkit-bridge.html?proxy=1`,
    fields: [
      `Expected account: ${metamaskAddress}`,
      "From: Arc_Testnet",
      `To: ${plan.bridgeTo}`,
      `Recipient: ${metamaskAddress}`,
      `Amount: ${plan.bridgeAmount}`,
      "Forwarder: checked",
    ],
    proof: "Save burn/bridge txHash and explorer link.",
  },
  {
    title: "4. Unified Balance",
    url: `${BASE_URL}/public/appkit-unified-balance.html?proxy=1`,
    fields: [
      `Expected account: ${metamaskAddress}`,
      "Source chain: Arc_Testnet",
      "Destination chain: Arc_Testnet",
      `Deposit amount: ${plan.unifiedDeposit}`,
      `Spend amount: ${plan.unifiedSpend}`,
      `Recipient: ${metamaskAddress}`,
      "Allowance: approve",
      "Forwarder: unchecked for Arc_Testnet -> Arc_Testnet spend",
    ],
    proof: "Save deposit tx and spend tx.",
  },
  {
    title: "5. Issued Token Transfer",
    url: `${BASE_URL}/public/skipio-transfer.html`,
    fields: [
      `Token preset: ${plan.tokenPreset}`,
      `ARCP contract: ${ARCP_CONTRACT}`,
      `SKIPIO contract: ${SKIPIO_CONTRACT}`,
      `Recipient: ${circleWalletAddress}`,
      `Amount: ${plan.tokenAmount}`,
    ],
    proof: "Save txHash/explorer after MetaMask signs.",
  },
  {
    title: "6. Circle Dev Wallet Transfer",
    command: devWalletCommand(plan.devWalletAmount),
    fields: [
      `From: Circle Dev Wallet (${circleWalletAddress})`,
      `To: MetaMask (${metamaskAddress})`,
      "Token: Arc Testnet USDC",
      `Amount: ${plan.devWalletAmount}`,
    ],
    proof: "Save txHash/explorer from terminal output.",
  },
  {
    title: "7. Memo Receipt",
    url: `${BASE_URL}/public/arc-usdc-tools.html`,
    fields: [
      `Memo contract: ${MEMO_CONTRACT}`,
      `Recipient: ${circleWalletAddress}`,
      `ERC-20 USDC amount: ${productPlan.memoAmount}`,
      `Memo reference: ${memoReference}`,
      `Memo data: circle-arc-payment ${memoReference}`,
    ],
    proof: "Save Memo.memo txHash/explorer and memoId.",
  },
  {
    title: "8. Batch Payout",
    url: `${BASE_URL}/public/arc-usdc-tools.html`,
    fields: [
      `Multicall3From contract: ${MULTICALL3FROM_CONTRACT}`,
      "Payout rows:",
      `  ${circleWalletAddress},${productPlan.batchCircleAmount}`,
      `  ${metamaskAddress},${productPlan.batchSelfAmount}`,
    ],
    proof: "Save Multicall3From.aggregate3 txHash/explorer.",
  },
  {
    title: "9. ArcInvoice Register",
    url: `${BASE_URL}/public/arc-invoice.html`,
    fields: [
      `Contract: ${arcInvoiceContract}`,
      "Create a new invoice first.",
      `Merchant wallet: ${metamaskAddress}`,
      `Customer: ${invoiceLabel}`,
      `Amount: ${productPlan.invoiceAmount}`,
      "Then select that invoice and click Register on Arc.",
    ],
    proof: "Save createInvoice/register txHash and explorer link.",
  },
  {
    title: "10. ArcInvoice Payment",
    url: `${BASE_URL}/public/arc-invoice.html`,
    fields: [
      `Select the registered invoice for: ${invoiceLabel}`,
      `Payment amount: ${productPlan.invoiceAmount} native USDC`,
      "Click Pay USDC and sign in MetaMask.",
    ],
    proof: "Save payInvoice txHash and explorer link.",
  },
  {
    title: "11. ArcInvoice Cancel",
    url: `${BASE_URL}/public/arc-invoice.html`,
    fields: [
      `Contract: ${arcInvoiceContract}`,
      "Create a separate new invoice first; do not use the paid invoice.",
      `Merchant wallet: ${metamaskAddress}`,
      `Customer: ${cancelInvoiceLabel}`,
      `Amount: ${productPlan.invoiceAmount}`,
      "Click Register on Arc, then click Cancel Invoice before paying it.",
    ],
    proof: "Save register txHash and cancelInvoice txHash/explorer link.",
  },
  {
    title: "12. Issued Token Approve",
    url: `${BASE_URL}/public/skipio-transfer.html`,
    fields: [
      `Token preset: ${plan.tokenPreset}`,
      `Spender: ${circleWalletAddress}`,
      `Approve amount: ${plan.allowanceAmount}`,
      "Click Check Allowance first if you want a baseline, then Approve Allowance.",
    ],
    proof: "Save approve txHash/explorer link.",
  },
  {
    title: "13. Dev Wallet transferFrom",
    command: devWalletTransferFromCommand(plan.tokenPreset, plan.delegatedTransferAmount),
    fields: [
      `Token preset: ${plan.tokenPreset}`,
      `Token contract: ${issuedTokenContract(plan.tokenPreset)}`,
      `Spender/Circle Dev Wallet: ${circleWalletAddress}`,
      `From: ${metamaskAddress}`,
      `To: ${metamaskAddress}`,
      `Amount: ${plan.delegatedTransferAmount}`,
      "This consumes part of the allowance without draining the issued-token balance.",
    ],
    proof: "Save transferFrom txHash/explorer link from terminal output.",
  },
  {
    title: "14. Issued Token Revoke",
    url: `${BASE_URL}/public/skipio-transfer.html`,
    fields: [
      `Token preset: ${plan.tokenPreset}`,
      `Spender: ${circleWalletAddress}`,
      "Revoke amount: approve spender for 0",
      "Click Revoke Allowance after the transferFrom command completes.",
    ],
    proof: "Save revoke txHash/explorer link and final allowance = 0.",
  },
  {
    title: "15. ArcEscrow Fund",
    url: `${BASE_URL}/public/arc-escrow.html`,
    fields: [
      `Contract: ${arcEscrowContract}`,
      `Seller: ${circleWalletAddress}`,
      `Amount: ${productPlan.escrowAmount} native USDC`,
      `Reference: ${escrowReference}`,
      `Outcome: ${productPlan.escrowOutcome}`,
      "Create Draft, select it, then click Fund Escrow.",
    ],
    proof: "Save createEscrow/fund txHash.",
  },
  {
    title: "16. ArcEscrow Settle",
    url: `${BASE_URL}/public/arc-escrow.html`,
    fields: [
      `Select funded escrow: ${escrowReference}`,
      `Settlement action: ${productPlan.escrowOutcome}`,
      productPlan.escrowOutcome === "release"
        ? `Release sends ${productPlan.escrowAmount} native USDC to seller ${circleWalletAddress}.`
        : `Refund returns ${productPlan.escrowAmount} native USDC to buyer ${metamaskAddress}.`,
      "Click Release or Refund and sign in MetaMask.",
    ],
    proof: "Save releaseEscrow/refundEscrow txHash and final status.",
  },
  {
    title: "17. ArcSubscription Plan",
    url: `${BASE_URL}/public/arc-subscription.html`,
    fields: [
      `Contract: ${arcSubscriptionContract}`,
      `Merchant: ${circleWalletAddress}`,
      `Price: ${productPlan.subscriptionPrice} native USDC`,
      `Period days: ${productPlan.subscriptionPeriodDays}`,
      `Cycles: ${productPlan.subscriptionCycles}`,
      `Reference: ${subscriptionReference}`,
      "If no ArcSubscription contract is saved yet, deploy it once and save the address before creating the plan.",
      "Create Draft, select it, then click Create Plan.",
    ],
    proof: "Save deploy tx if new, then save createPlan txHash.",
  },
  {
    title: "18. ArcSubscription Subscribe",
    url: `${BASE_URL}/public/arc-subscription.html`,
    fields: [
      `Select plan: ${subscriptionReference}`,
      `Subscription payment: ${productPlan.subscriptionPrice} native USDC x ${productPlan.subscriptionCycles} cycle(s)`,
      "Click Subscribe and sign in MetaMask.",
    ],
    proof: "Save subscribe txHash and paidThrough value.",
  },
  {
    title: "19. ArcSubscription Cancel",
    url: `${BASE_URL}/public/arc-subscription.html`,
    fields: [
      `Select subscribed plan: ${subscriptionReference}`,
      "Click Cancel and sign in MetaMask.",
    ],
    proof: "Save cancelSubscription txHash and final status.",
  },
  {
    title: "20. Raw CCTP Approve",
    url: `${BASE_URL}/public/raw-cctp.html`,
    fields: [
      "Source: Arc_Testnet / CCTP domain 26",
      `Destination: ${plan.rawCctpTo}`,
      `Recipient: ${metamaskAddress}`,
      `Amount: ${plan.rawCctpAmount}`,
      "Speed: STANDARD",
      `Approve spender / Bridge contract: ${CCTP_BRIDGE_CONTRACT}`,
      "Click Fetch Fee, then Approve.",
    ],
    proof: "Save approve txHash and allowance value.",
  },
  {
    title: "21. Raw CCTP Burn + Attestation",
    url: `${BASE_URL}/public/raw-cctp.html`,
    fields: [
      `Destination: ${plan.rawCctpTo}`,
      `Burn amount: ${plan.rawCctpAmount} Arc ERC-20 USDC`,
      "Click Bridge Burn, sign in MetaMask, then click Poll Iris.",
      "Iris: /v2/messages/26?transactionHash={burnTxHash}",
    ],
    proof: "Save burn txHash, event nonce, message, and attestation status.",
  },
  {
    title: "22. Raw CCTP Mint",
    url: `${BASE_URL}/public/raw-cctp.html`,
    fields: [
      `Switch MetaMask to: ${plan.rawCctpTo}`,
      `MessageTransmitterV2: ${CCTP_MESSAGE_TRANSMITTER_V2}`,
      "Click Mint after Iris status is complete.",
    ],
    proof: "Save destination receiveMessage txHash and final destination USDC balance.",
  },
];

function printStep(step: Step): void {
  console.log(step.title);
  if (step.url) {
    console.log(`  URL: ${step.url}`);
  }
  if (step.command) {
    console.log(`  Command: ${step.command}`);
  }
  for (const field of step.fields) {
    console.log(`  - ${field}`);
  }
  console.log(`  Proof: ${step.proof}`);
  console.log("");
}

console.log("Arc daily cycle quick sheet");
console.log(`Date: ${cycleDate}`);
console.log(`Variant: ${planIndex + 1}/${dailyPlans.length}`);
console.log("Purpose: vary real Circle/Arc feature usage with small, affordable amounts and product-style state changes.");
console.log("Server: npm.cmd run start-deployer");
console.log(`ArcScan: https://testnet.arcscan.app/address/${metamaskAddress}`);
console.log("");

for (const step of steps) {
  printStep(step);
}

console.log("After each run, keep txHash/explorer links together in one note.");
