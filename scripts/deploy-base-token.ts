import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, formatEther, formatUnits, getAddress, parseUnits } from "ethers";
import type { InterfaceAbi } from "ethers";
import solc from "solc";
import { optionalEnv, printJson, requiredEnv } from "./config.js";

const root = process.cwd();
const contractFile = "contracts/BaseActivityToken.sol";
const contractName = "BaseActivityToken";
const decimals = 18;

const baseNetworks = {
  "base-sepolia": {
    name: "Base Sepolia",
    chainId: 84532,
    rpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia-explorer.base.org",
  },
  "base-mainnet": {
    name: "Base Mainnet",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://base.blockscout.com",
  },
} as const;

type BaseNetworkKey = keyof typeof baseNetworks;

type SolcMessage = {
  severity: "error" | "warning" | string;
  formattedMessage?: string;
  message?: string;
};

type SolcContract = {
  abi?: InterfaceAbi;
  evm?: {
    bytecode?: {
      object?: string;
    };
  };
};

type SolcOutput = {
  errors?: SolcMessage[];
  contracts?: Record<string, Record<string, SolcContract>>;
};

function getBaseNetwork(): [BaseNetworkKey, (typeof baseNetworks)[BaseNetworkKey]] {
  const rawNetwork = (optionalEnv("BASE_NETWORK") ?? "base-sepolia").toLowerCase();
  if (rawNetwork !== "base-sepolia" && rawNetwork !== "base-mainnet") {
    throw new Error("BASE_NETWORK must be base-sepolia or base-mainnet.");
  }

  return [rawNetwork, baseNetworks[rawNetwork]];
}

function findImports(importPath: string): { contents?: string; error?: string } {
  const candidates = [
    path.join(root, importPath),
    path.join(root, "node_modules", importPath),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { contents: readFileSync(candidate, "utf8") };
    }
  }

  return { error: `File not found: ${importPath}` };
}

function compileBaseActivityToken(): { abi: InterfaceAbi; bytecode: string; compiler: string } {
  const input = {
    language: "Solidity",
    sources: {
      [contractFile]: {
        content: readFileSync(path.join(root, contractFile), "utf8"),
      },
    },
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports })) as SolcOutput;
  const errors = output.errors ?? [];

  for (const error of errors) {
    const message = error.formattedMessage ?? error.message;
    if (error.severity === "error") {
      console.error(message);
    } else {
      console.warn(message);
    }
  }

  if (errors.some((error) => error.severity === "error")) {
    throw new Error("Solidity compilation failed.");
  }

  const artifact = output.contracts?.[contractFile]?.[contractName];
  const bytecodeObject = artifact?.evm?.bytecode?.object;
  if (!artifact?.abi || !bytecodeObject) {
    throw new Error(`Missing compiled ${contractName} artifact.`);
  }

  return {
    abi: artifact.abi,
    bytecode: `0x${bytecodeObject}`,
    compiler: solc.version(),
  };
}

function parseTokenAmount(envName: string, fallback: string): bigint {
  const raw = (optionalEnv(envName) ?? fallback).replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`${envName} must be a positive decimal token amount.`);
  }

  try {
    return parseUnits(raw, decimals);
  } catch {
    throw new Error(`${envName} must be a positive decimal token amount.`);
  }
}

const [networkKey, networkConfig] = getBaseNetwork();
const rpcUrl = optionalEnv("BASE_RPC_URL") ?? networkConfig.rpcUrl;
const provider = new JsonRpcProvider(rpcUrl);
const wallet = new Wallet(requiredEnv("BASE_DEPLOYER_PRIVATE_KEY"), provider);
const deployer = await wallet.getAddress();
const initialOwner = getAddress(optionalEnv("BASE_TOKEN_OWNER") ?? deployer);
const tokenName = optionalEnv("BASE_TOKEN_NAME") ?? "Base Activity Log";
const tokenSymbol = optionalEnv("BASE_TOKEN_SYMBOL") ?? "BALOG";
const initialSupplyText = optionalEnv("BASE_TOKEN_INITIAL_SUPPLY") ?? "1000000";
const initialSupply = parseTokenAmount("BASE_TOKEN_INITIAL_SUPPLY", initialSupplyText);
const maxSupply = parseTokenAmount("BASE_TOKEN_MAX_SUPPLY", initialSupplyText);
const connectedNetwork = await provider.getNetwork();
const connectedChainId = Number(connectedNetwork.chainId);

if (maxSupply < initialSupply) {
  throw new Error("BASE_TOKEN_MAX_SUPPLY must be greater than or equal to BASE_TOKEN_INITIAL_SUPPLY.");
}

if (connectedChainId !== networkConfig.chainId) {
  throw new Error(
    `Connected RPC chain id ${connectedChainId} does not match ${networkConfig.name} (${networkConfig.chainId}).`,
  );
}

const deployerBalance = await provider.getBalance(deployer);
const artifact = compileBaseActivityToken();

console.log(
  JSON.stringify(
    {
      action: "deploy-base-token",
      network: networkKey,
      chainId: connectedChainId,
      rpc: rpcUrl === networkConfig.rpcUrl ? networkConfig.rpcUrl : "custom BASE_RPC_URL",
      compiler: artifact.compiler,
      deployer,
      deployerBalanceEth: formatEther(deployerBalance),
      owner: initialOwner,
      name: tokenName,
      symbol: tokenSymbol,
      initialSupply: formatUnits(initialSupply, decimals),
      maxSupply: formatUnits(maxSupply, decimals),
      note: "BASE_DEPLOYER_PRIVATE_KEY is loaded from .env and is never printed.",
    },
    null,
    2,
  ),
);

const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
const contract = await factory.deploy(tokenName, tokenSymbol, initialSupply, maxSupply, initialOwner);
const deploymentTx = contract.deploymentTransaction();
if (!deploymentTx) {
  throw new Error("Missing deployment transaction.");
}

console.log(`Deployment submitted: ${deploymentTx.hash}`);
await contract.waitForDeployment();

const contractAddress = await contract.getAddress();
const token = contract as typeof contract & {
  name(): Promise<string>;
  symbol(): Promise<string>;
  decimals(): Promise<bigint>;
  totalSupply(): Promise<bigint>;
  maxSupply(): Promise<bigint>;
  owner(): Promise<string>;
};
const deployedDecimals = Number(await token.decimals());
const [deployedName, deployedSymbol, deployedTotalSupply, deployedMaxSupply, deployedOwner] = await Promise.all([
  token.name(),
  token.symbol(),
  token.totalSupply(),
  token.maxSupply(),
  token.owner(),
]);

printJson({
  contractAddress,
  explorer: `${networkConfig.explorerUrl}/address/${contractAddress}`,
  deployTx: deploymentTx.hash,
  deployTxExplorer: `${networkConfig.explorerUrl}/tx/${deploymentTx.hash}`,
  network: networkConfig.name,
  chainId: connectedChainId,
  owner: deployedOwner,
  name: deployedName,
  symbol: deployedSymbol,
  decimals: deployedDecimals,
  totalSupply: formatUnits(deployedTotalSupply, deployedDecimals),
  maxSupply: formatUnits(deployedMaxSupply, deployedDecimals),
});
