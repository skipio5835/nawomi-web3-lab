# Circle / Arc / Base Workspace

This workspace contains Arc Testnet experiments, Circle App Kit pages, custom
Solidity contracts, Base local tooling, and the hackathon MVP named ArcInvoice.

## Base Tooling

Base-related deployment and local-operation helpers live in this repository, but
the public README intentionally avoids listing deployed addresses, wallet
addresses, callable method names, transaction routines, or runbooks.

Use the local console only from a trusted workstation:

```bash
npm run start-base-console
```

Secrets, private keys, wallet addresses, deployed contract addresses, and
operator notes must stay in local `.env` files or private notes that are not
committed.

## Arc Testnet

The Arc workspace is used to test Circle onchain flows on Arc Testnet. It
includes small Solidity contracts, browser pages for MetaMask-signed actions,
Circle App Kit experiments, and scripts for repeatable local test routines.

Arc-related work lives under `circle/arc/`. Runtime secrets such as Circle API
keys, Kit keys, private keys, wallet IDs, and local transaction notes must stay
outside Git in `.env` or private notes.

## ArcInvoice MVP

ArcInvoice is a small USDC invoice product for the Arc hackathon:

- Merchants create invoice records through a backend API.
- The invoice is registered on an Arc smart contract.
- Buyers pay native USDC on Arc.
- The app stores a receipt with tx hashes and ArcScan links.

See [circle/arc/ARCINVOICE.md](circle/arc/ARCINVOICE.md) for the architecture,
demo script, and submission notes.

## Structure

- `circle/arc/contracts/`: Arc Testnet Solidity contracts.
- `circle/arc/src/`: browser TypeScript entrypoints.
- `circle/arc/public/`: static app pages and browser bundles.
- `circle/arc/scripts/`: local server, compile scripts, and Circle helpers.
- `base/`: Base-related local tooling.
- `src/`: Solidity sources used by local workflows.
- `script/`: Foundry scripts used by local workflows.
- `shared/`: common config and helpers.

## Commands

```bash
npm install
npm run compile-custom
npm run build-arc-invoice
npm run typecheck
npm run start-deployer
```

Open `http://localhost:4173` after the server starts.

Secrets are stored only in local `.env` and are never committed.
