import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const contractsToCompile = [
  { file: "contracts/Skipio.sol", name: "Skipio" },
  { file: "contracts/ProofToken.sol", name: "ProofToken" },
] as const;

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

const input = {
  language: "Solidity",
  sources: Object.fromEntries(
    contractsToCompile.map(({ file }) => [
      file,
      {
        content: readFileSync(path.join(root, file), "utf8"),
      },
    ]),
  ),
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = output.errors ?? [];
const fatalErrors = errors.filter((error: { severity: string }) => error.severity === "error");

for (const error of errors) {
  const message = error.formattedMessage ?? error.message;
  if (error.severity === "error") {
    console.error(message);
  } else {
    console.warn(message);
  }
}

if (fatalErrors.length > 0) {
  process.exit(1);
}

const publicArtifactsDir = path.join(root, "public", "artifacts");
mkdirSync(publicArtifactsDir, { recursive: true });

for (const { file, name } of contractsToCompile) {
  const artifact = output.contracts?.[file]?.[name];
  if (!artifact?.abi || !artifact?.evm?.bytecode?.object) {
    throw new Error(`Missing compiled ${name} artifact.`);
  }

  const browserArtifact = {
    contractName: name,
    sourceName: file,
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
    deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
    compiler: solc.version(),
  };

  writeFileSync(path.join(publicArtifactsDir, `${name}.json`), `${JSON.stringify(browserArtifact, null, 2)}\n`);

  console.log(`Compiled ${name} with ${solc.version()}`);
  console.log(`Wrote public/artifacts/${name}.json`);
}
