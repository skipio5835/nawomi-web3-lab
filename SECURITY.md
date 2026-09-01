# Security Policy

## Scope

The `main` branch is maintained for Arc and Base testnet experimentation. The
contracts and interfaces are not approved for production custody or mainnet funds.

## Reporting

Report suspected vulnerabilities through this repository's private vulnerability
reporting form in the GitHub Security tab. Do not include private keys, seed phrases,
API credentials, Kit Keys, or live-wallet secrets in an issue or pull request.

## Local Safety

- Keep secrets in an ignored local `.env` file.
- Review the selected network, contract, function, recipient, value, and allowance
  in the wallet before every signature.
- Treat generated browser bundles as build output; review their TypeScript source.
- Run `npm audit --audit-level=moderate`, `npm run typecheck`,
  `npm run test-arc-radar`, and `npm run security:contracts` before release.
- Compare deployed runtime bytecode with the compiled release artifact before
  recording a deployment as verified.

Public testnet addresses and transaction receipts are not secrets, but they link
repository activity to an on-chain identity. Publish them only for reproducibility.
