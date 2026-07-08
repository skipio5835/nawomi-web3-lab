import { spawn } from "node:child_process";

type ComboKey = "reward" | "coupon" | "referral" | "cashback" | "auction";

type ComboPlan = {
  cashbackAmount: string;
  cashbackClaim: string;
  auctionMinBid: string;
  auctionRaiseBid: string;
  auctionSettlement: string;
  couponAmount: string;
  couponClaim: string;
  referralAmount: string;
  referralClaim: string;
  rewardAmount: string;
  rewardClaim: string;
};

type ComboSpec = {
  amount: string;
  claim: string;
  contract: string;
  label: string;
  page: string;
  title: string;
};

const DEFAULT_METAMASK = "0x0000000000000000000000000000000000000000";
const DEFAULT_ARCREWARD_CONTRACT = "0x6da434b13e24ae1507687179ac57980776f11d2c";
const DEFAULT_ARCCOUPON_CONTRACT = "0x689f5c5447b1f0505d49af73bc85475970e690e2";
const DEFAULT_ARCREFERRAL_CONTRACT = "0xa2eaf480143d01ae4d9e9d9d880aff1c60d80396";
const DEFAULT_ARCCASHBACK_CONTRACT = "0xe30af52b7da6a23e8ced04473290f57b8964fef8";
const DEFAULT_ARCAUCTION_CONTRACT = "";
const BASE_URL = `http://localhost:${process.env.PORT ?? "4173"}`;

const productPlans: ComboPlan[] = [
  {
    rewardAmount: "0.003",
    rewardClaim: "claimed-weekly-reward",
    couponAmount: "0.003",
    couponClaim: "claimed-weekly-coupon",
    referralAmount: "0.003",
    referralClaim: "claimed-weekly-referral",
    cashbackAmount: "0.003",
    cashbackClaim: "claimed-weekly-cashback",
    auctionMinBid: "0.003",
    auctionRaiseBid: "0.004",
    auctionSettlement: "settled-weekly-auction",
  },
  {
    rewardAmount: "0.0035",
    rewardClaim: "claimed-product-reward",
    couponAmount: "0.0035",
    couponClaim: "claimed-product-coupon",
    referralAmount: "0.0035",
    referralClaim: "claimed-product-referral",
    cashbackAmount: "0.0035",
    cashbackClaim: "claimed-product-cashback",
    auctionMinBid: "0.0035",
    auctionRaiseBid: "0.0045",
    auctionSettlement: "settled-product-auction",
  },
  {
    rewardAmount: "0.004",
    rewardClaim: "claimed-ops-reward",
    couponAmount: "0.004",
    couponClaim: "claimed-ops-coupon",
    referralAmount: "0.004",
    referralClaim: "claimed-ops-referral",
    cashbackAmount: "0.004",
    cashbackClaim: "claimed-ops-cashback",
    auctionMinBid: "0.004",
    auctionRaiseBid: "0.005",
    auctionSettlement: "settled-ops-auction",
  },
  {
    rewardAmount: "0.0045",
    rewardClaim: "claimed-alt-reward",
    couponAmount: "0.0045",
    couponClaim: "claimed-alt-coupon",
    referralAmount: "0.0045",
    referralClaim: "claimed-alt-referral",
    cashbackAmount: "0.0045",
    cashbackClaim: "claimed-alt-cashback",
    auctionMinBid: "0.0045",
    auctionRaiseBid: "0.0055",
    auctionSettlement: "settled-alt-auction",
  },
  {
    rewardAmount: "0.005",
    rewardClaim: "claimed-release-reward",
    couponAmount: "0.005",
    couponClaim: "claimed-release-coupon",
    referralAmount: "0.005",
    referralClaim: "claimed-release-referral",
    cashbackAmount: "0.005",
    cashbackClaim: "claimed-release-cashback",
    auctionMinBid: "0.005",
    auctionRaiseBid: "0.006",
    auctionSettlement: "settled-release-auction",
  },
  {
    rewardAmount: "0.0055",
    rewardClaim: "claimed-abstain-reward",
    couponAmount: "0.0055",
    couponClaim: "claimed-abstain-coupon",
    referralAmount: "0.0055",
    referralClaim: "claimed-abstain-referral",
    cashbackAmount: "0.0055",
    cashbackClaim: "claimed-abstain-cashback",
    auctionMinBid: "0.0055",
    auctionRaiseBid: "0.0065",
    auctionSettlement: "settled-abstain-auction",
  },
  {
    rewardAmount: "0.0032",
    rewardClaim: "claimed-final-reward",
    couponAmount: "0.0032",
    couponClaim: "claimed-final-coupon",
    referralAmount: "0.0032",
    referralClaim: "claimed-final-referral",
    cashbackAmount: "0.0032",
    cashbackClaim: "claimed-final-cashback",
    auctionMinBid: "0.0032",
    auctionRaiseBid: "0.0042",
    auctionSettlement: "settled-final-auction",
  },
];

function todayKey(): string {
  const override = process.env.CYCLE_DATE?.trim();
  if (override) return override;

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

function argValue(name: string): string | undefined {
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex >= 0) return process.argv[exactIndex + 1];

  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function buildSpecs(cycleDate: string, variant: number, plan: ComboPlan): Record<ComboKey, ComboSpec> {
  return {
    reward: {
      amount: plan.rewardAmount,
      claim: plan.rewardClaim,
      contract: process.env.ARCREWARD_CONTRACT?.trim() || DEFAULT_ARCREWARD_CONTRACT,
      label: `arc-reward-${cycleDate}-v${variant}`,
      page: "arc-reward.html",
      title: "ArcReward Create + Claim + Close",
    },
    coupon: {
      amount: plan.couponAmount,
      claim: plan.couponClaim,
      contract: process.env.ARCCOUPON_CONTRACT?.trim() || DEFAULT_ARCCOUPON_CONTRACT,
      label: `arc-coupon-${cycleDate}-v${variant}`,
      page: "arc-coupon.html",
      title: "ArcCoupon Create + Claim + Close",
    },
    referral: {
      amount: plan.referralAmount,
      claim: plan.referralClaim,
      contract: process.env.ARCREFERRAL_CONTRACT?.trim() || DEFAULT_ARCREFERRAL_CONTRACT,
      label: `arc-referral-${cycleDate}-v${variant}`,
      page: "arc-referral.html",
      title: "ArcReferral Create + Claim + Close",
    },
    cashback: {
      amount: plan.cashbackAmount,
      claim: plan.cashbackClaim,
      contract: process.env.ARCCASHBACK_CONTRACT?.trim() || DEFAULT_ARCCASHBACK_CONTRACT,
      label: `arc-cashback-${cycleDate}-v${variant}`,
      page: "arc-cashback.html",
      title: "ArcCashback Create + Claim + Close",
    },
    auction: {
      amount: plan.auctionMinBid,
      claim: plan.auctionSettlement,
      contract: process.env.ARCAUCTION_CONTRACT?.trim() || DEFAULT_ARCAUCTION_CONTRACT,
      label: `arc-auction-${cycleDate}-v${variant}`,
      page: "arc-auction.html",
      title: "ArcAuction Create + Bid + Raise + Settle",
    },
  };
}

function buildUrl(spec: ComboSpec): string {
  const owner = process.env.METAMASK_ADDRESS?.trim() || DEFAULT_METAMASK;
  if (spec.page === "arc-auction.html") {
    const plan = productPlans[variantIndex];
    const params = new URLSearchParams({
      autorun: "1",
      contract: spec.contract,
      durationMinutes: "0",
      metadataURI: `local:${spec.label}`,
      minBid: plan.auctionMinBid,
      raiseBid: plan.auctionRaiseBid,
      settlementTo: owner,
      settlementURI: `local:${spec.label}:${plan.auctionSettlement}`,
      title: spec.label,
    });

    return `${BASE_URL}/public/${spec.page}?${params}`;
  }

  const params = new URLSearchParams({
    amount: spec.amount,
    autorun: "1",
    claimTo: owner,
    claimURI: `local:${spec.label}:${spec.claim}`,
    contract: spec.contract,
    label: spec.label,
    metadataURI: `local:${spec.label}`,
    recipient: owner,
    refundTo: owner,
  });

  return `${BASE_URL}/public/${spec.page}?${params}`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function openChrome(url: string): void {
  const profile = argValue("--profile") ?? "Default";
  const command = [
    'Start-Process "chrome.exe" -ArgumentList @(',
    [psQuote(`--profile-directory=${profile}`), psQuote("--new-window"), psQuote(url)].join(", "),
    ")",
  ].join("");
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    console.log("Could not open Chrome automatically. Open the URL manually instead.");
  });
  child.unref();
}

const cycleDate = todayKey();
const variantIndex = (dayOfYear(cycleDate) - 1) % productPlans.length;
const variant = variantIndex + 1;
const specs = buildSpecs(cycleDate, variant, productPlans[variantIndex]);
const open = argValue("--open") as ComboKey | undefined;

console.log(`Date: ${cycleDate}`);
console.log(`Variant: ${variant}/${productPlans.length}`);
console.log("");

if (open) {
  const spec = specs[open];
  if (!spec) {
    throw new Error(`Unknown combo "${open}". Use one of: ${Object.keys(specs).join(", ")}`);
  }

  const url = buildUrl(spec);
  openChrome(url);
  console.log(`Opened ${open}: ${spec.title}`);
  console.log(url);
  console.log("");
  console.log("Approve each MetaMask request. This combines the safe same-page actions for that one flow.");
} else {
  console.log("Combo flows available:");
  for (const [key, spec] of Object.entries(specs) as Array<[ComboKey, ComboSpec]>) {
    console.log("");
    console.log(`${key}: ${spec.title}`);
    console.log(`  Amount: ${spec.amount} native USDC`);
    console.log(`  Contract: ${spec.contract}`);
    console.log(`  Label: ${spec.label}`);
    console.log(`  Open: npm.cmd run cycle:combo -- --open ${key}`);
    console.log(`  URL: ${buildUrl(spec)}`);
  }

  console.log("");
  console.log("Open one combo at a time so MetaMask requests do not overlap.");
}
