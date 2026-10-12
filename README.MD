# UFarm RWA Contracts

Smart contracts powering UFarm’s Real-World Asset (RWA) tokenization on EVM chains, built on the ERC-3643 (permissioned token) model.

## What this repository contains

- **ERC-3643 permissioned asset tokens** (ERC-20 compatible) for issuing regulated RWAs
- **Identity & eligibility enforcement** via on-chain registries (KYC/AML performed off-chain)
- **Pluggable compliance module** for transfer rules (minimal by default, extensible over time)
- **Multi-asset issuance** using a **Factory** that deploys a complete token suite per asset
- **Upgradeability** for all core modules using **UUPS proxies** (OpenZeppelin)

## Core concepts

### Permissioned transfers

Transfers are allowed only if:

- the recipient address is **verified** through the Identity Registry
- the Compliance module allows the transfer under the configured rules

### Off-chain identity, on-chain enforcement

User verification (KYC/KYB/AML) is performed off-chain by trusted issuers/providers. On-chain contracts only store minimal linkages (wallet → identity contract) and enforce eligibility through required claim topics and trusted issuers.

### Token suite per asset

Each asset issuance deploys a dedicated suite:

- Token
- Identity Registry
- Identity Registry Storage (optionally reusable per issuer)
- Claim Topics Registry
- Trusted Issuers Registry
- Compliance module

## Tech stack

- Solidity: **0.8.35**
- OpenZeppelin: **5.6.1**
- Hardhat: **3.8.0**
- Deployment: **Hardhat Ignition**
- Upgradeability: **UUPS (ERC1967)**

## Development

### Install

```bash
npm ci
```

### Format

```bash
npm run format
```

### Lint

```bash
npm run lint
```

### Compile

```bash
npm run compile
```

### Deploy

Copy the sample env + Ignition parameter files and fill in real values:

```bash
mkdir -p ignition/parameters
cp .env.sample .env
cp ignition/parameters/DeployPlatform.sample.json ignition/parameters/DeployPlatform.json
cp ignition/parameters/DeployTokenSuite.sample.json ignition/parameters/DeployTokenSuite.json
cp ignition/parameters/DeployPrivateCreditTokenSuite.sample.json ignition/parameters/DeployPrivateCreditTokenSuite.json
```

Run deployments:

```bash
npm run deploy -- --parameters ignition/parameters/DeployPlatform.json --network mainnet
npm run deploy:token-suite -- --parameters ignition/parameters/DeployTokenSuite.json --network mainnet
npm run deploy:private-credit-suite -- --parameters ignition/parameters/DeployPrivateCreditTokenSuite.json --network mainnet
```

Private-credit suites deploy in an unstarted state. After completing operational setup, call `start()` from the token owner account.

### Tests

```bash
npm test
```

## Security

- Production deployments must use multisig for privileged roles (owner/upgrader/agents).
- Upgrades must follow strict review/audit procedures.
- Monitor agent and configuration changes via emitted events.

Run Slither through the repository's Foundry configuration:

```bash
npm run security:slither
```

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
