# Arc Testnet Validation

This workspace includes a manual regression harness for Arc Testnet integrations.
It prepares deterministic test cases, but it never bypasses wallet confirmation or
signs transactions automatically.

## Setup

From the repository root:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run cycle:prepare
npm.cmd run start-deployer
```

Keep the local server open and review every network, contract, recipient, amount,
and approval in MetaMask before signing. Do not open overlapping transaction flows.

## Coverage

The checklist exercises these independent product areas:

- Circle App Kit send, swap, bridge, and unified balance flows.
- Raw CCTP burn, attestation, and mint validation.
- Issued-token transfer, allowance, delegated transfer, and revoke behavior.
- Payment operations such as invoices, quotes, escrow, settlement, and refunds.
- Contract workflows for subscriptions, access, rewards, airdrops, marketplaces,
  services, donations, payroll, vesting, auctions, rentals, and warranties.
- Read-only Arc Radar market, holder, liquidity, and contract-risk analysis.

For flows that intentionally combine actions on one page, print a local combo URL:

```powershell
npm.cmd run cycle:combo
npm.cmd run cycle:combo -- --open reward
```

Use only testnet funds. Store optional transaction receipts in private QA notes;
credentials, operator defaults, and personal filesystem paths do not belong in the
public repository.
