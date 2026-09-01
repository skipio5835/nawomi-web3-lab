# nawomi-web3-lab

Local-first prototypes and hardened Solidity contracts for Circle's Arc Testnet.

## Repository Layout

- `circle/arc/contracts/`: Arc Solidity contracts.
- `circle/arc/src/`: browser application source.
- `circle/arc/public/`: locally served browser interfaces and generated bundles.
- `circle/arc/test/`: Solidity and TypeScript regression tests.
- `base/`, `src/`, `script/`: separate Base experiments and Foundry tooling.

## Local Validation

```bash
npm ci --ignore-scripts
npm run typecheck
npm run test-arc-radar
npm run security:contracts
```

Start the Arc Radar locally with:

```bash
npm run start-arc-radar
```

## Security

This repository targets testnets and has not received a production security audit.
Wallet approvals and transactions must be reviewed in MetaMask before signing.

Never commit seed phrases, private keys, Circle credentials, Kit Keys, `.env`
files, or private operator notes. Public testnet deployment addresses and receipts
may be recorded only when needed to reproduce or verify a release.

See [SECURITY.md](SECURITY.md) for reporting and release guidance.
