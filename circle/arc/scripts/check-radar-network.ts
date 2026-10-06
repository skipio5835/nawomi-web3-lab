import { checkRadarNetwork } from "../src/arc-radar-network-check.js";

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error("Usage: npm run check-arc-radar-network -- [arc-mainnet|arc-testnet]");
  process.exitCode = 1;
} else {
  const result = await checkRadarNetwork(args[0] ?? "arc-mainnet");
  console.log(JSON.stringify({ ...result,
    scope: "Read-only connectivity checks. No wallet, signing, .env loading, or automatic activation.",
    remaining: "Connectivity is not complete market coverage. Mainnet RPC samples exclude holder indexing and per-pool TVL; test browser access and externally hosted CSP separately.",
  }, null, 2));
  process.exitCode = result.status === "passed" ? 0 : result.status === "unconfigured" ? 2 : 1;
}
