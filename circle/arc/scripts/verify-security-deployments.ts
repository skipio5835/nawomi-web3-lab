import { readFileSync } from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const rpcUrl = "https://rpc.testnet.arc.network";
const explorerApi = "https://testnet.arcscan.app/api/v2";

const targets = [
  ["ArcExpenseSplitter", "0x746ec074273f916b6a74d1db117a77ff6bdbd860"],
  ["ArcEventTickets", "0xd2b0af66cb7f9b41e620defa4f40c64de8723d43"],
  ["ArcMarketplaceOrders", "0xaa0f773d76cc6f52c88f889d0defad5afbb6a753"],
  ["ArcServiceBookings", "0xa7a17b35c1a5e85a98513e63134983d2eed0e72b"],
  ["ArcDonationJar", "0x53998bd1060dbe9950019719087088eda9eaa3ae"],
  ["ArcPreorderStore", "0x3128486261a2222147fa1deb473e35aebe08d069"],
  ["ArcRefundableDeposit", "0xf307c49d66189849e9cf2ee5a370af030614c936"],
  ["ArcAuctionHouse", "0x239d4963e7df648204b912621f8d0f823b55399b"],
  ["ArcRentalEscrow", "0x62592aa9af5edd5a72f01ea23366cdb001e99217"],
] as const;

type VerificationState = {
  is_verified?: boolean;
  is_fully_verified?: boolean;
  name?: string;
  compiler_version?: string;
};

function standardInput(name: string) {
  const sourceName = `contracts/${name}.sol`;
  return {
    sourceName,
    input: {
      language: "Solidity",
      sources: {
        [sourceName]: {
          content: readFileSync(path.join(root, "circle", "arc", "contracts", `${name}.sol`), "utf8"),
        },
      },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
      },
    },
  };
}

async function rpc(method: string, params: unknown[]): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: string; error?: { message?: string } };
  if (!response.ok || body.error || typeof body.result !== "string") {
    throw new Error(body.error?.message ?? `RPC ${method} failed with HTTP ${response.status}`);
  }
  return body.result;
}

async function explorerState(address: string): Promise<VerificationState> {
  const response = await fetch(`${explorerApi}/smart-contracts/${address}`);
  if (!response.ok) throw new Error(`ArcScan lookup failed with HTTP ${response.status}`);
  return (await response.json()) as VerificationState;
}

async function waitForVerification(address: string): Promise<VerificationState> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await explorerState(address);
    if (state.is_fully_verified) return state;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("ArcScan did not report full verification within 60 seconds");
}

const compilerVersion = solc.version().replace(/\.Emscripten\.clang$/, "");
const arcscanCompilerVersion = `v${compilerVersion}`;
const results: Array<Record<string, unknown>> = [];

for (const [name, address] of targets) {
  const { sourceName, input } = standardInput(name);
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter((entry: { severity: string }) => entry.severity === "error");
  if (errors.length > 0) throw new Error(`${name} compilation failed: ${errors[0].formattedMessage}`);

  const compiled = `0x${output.contracts?.[sourceName]?.[name]?.evm?.deployedBytecode?.object ?? ""}`;
  const artifact = JSON.parse(
    readFileSync(path.join(root, "circle", "arc", "public", "artifacts", `${name}.json`), "utf8"),
  ) as { deployedBytecode: string };
  const onchain = await rpc("eth_getCode", [address, "latest"]);

  if (compiled !== artifact.deployedBytecode) throw new Error(`${name} does not match the deployment artifact`);
  if (compiled.toLowerCase() !== onchain.toLowerCase()) throw new Error(`${name} does not match on-chain runtime code`);

  const current = await explorerState(address);
  if (current.is_fully_verified) {
    results.push({
      name,
      address,
      status: "already_verified",
      compiler: current.compiler_version,
      arcscanName: current.name,
    });
    continue;
  }

  const form = new FormData();
  form.set("compiler_version", arcscanCompilerVersion);
  form.set("contract_name", `${sourceName}:${name}`);
  form.set("autodetect_constructor_args", "false");
  form.set("constructor_args", "");
  form.set("license_type", "mit");
  form.set("files[0]", new Blob([JSON.stringify(input)], { type: "application/json" }), `${name}.json`);

  const response = await fetch(
    `${explorerApi}/smart-contracts/${address}/verification/via/standard-input`,
    { method: "POST", body: form },
  );
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`${name} verification submission failed with HTTP ${response.status}: ${responseBody}`);
  }

  const verified = await waitForVerification(address);
  results.push({
    name,
    address,
    status: "verified",
    compiler: verified.compiler_version,
    arcscanName: verified.name,
  });
}

console.log(JSON.stringify({ ok: true, count: results.length, results }, null, 2));
