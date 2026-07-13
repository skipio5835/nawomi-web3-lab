# Base Activity Log

Base-related local tooling and Solidity experiments for this workspace.

## Scope

- `base/`: Base-specific local tooling.
- `src/`: Solidity sources used by local workflows.
- `script/`: Foundry scripts used by local workflows.

## Local Use

```bash
npm install
npm run start-base-console
npm run typecheck
```

The local console is intended for trusted workstation use only.

## Security

Do not commit secrets, `.env` files, logs, wallet addresses, deployed contract
addresses, private keys, API keys, or operator notes.
