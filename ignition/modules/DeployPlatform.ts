// This setup uses Hardhat Ignition to manage smart contract deployments.
// Learn more at https://hardhat.org/ignition

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const DeployPlatform = buildModule("DeployPlatform", (m) => {
  const owner = m.getParameter("owner", ZERO_ADDRESS);
  const idFactory = m.getParameter("idFactory", ZERO_ADDRESS);

  const tokenImpl = m.contract("ERC3643Token");
  const privateCreditTokenImpl = m.contract("PrivateCreditToken");
  const identityRegistryImpl = m.contract("IdentityRegistry");
  const identityRegistryStorageImpl = m.contract("IdentityRegistryStorage");
  const claimTopicsRegistryImpl = m.contract("ClaimTopicsRegistry");
  const trustedIssuersRegistryImpl = m.contract("TrustedIssuersRegistry");
  const complianceImpl = m.contract("Compliance");
  const tokenFactoryImpl = m.contract("TokenFactory");

  const tokenFactoryInitData = m.encodeFunctionCall(tokenFactoryImpl, "initialize", [
    owner,
    tokenImpl,
    privateCreditTokenImpl,
    identityRegistryImpl,
    identityRegistryStorageImpl,
    claimTopicsRegistryImpl,
    trustedIssuersRegistryImpl,
    complianceImpl,
    idFactory,
  ]);

  const tokenFactoryProxy = m.contract("ERC1967Proxy", [tokenFactoryImpl, tokenFactoryInitData]);
  const tokenFactory = m.contractAt("TokenFactory", tokenFactoryProxy, { id: "TokenFactoryUpgadable" });

  return {
    tokenFactory,
    tokenFactoryProxy,
    tokenFactoryImpl,
    tokenImpl,
    privateCreditTokenImpl,
    identityRegistryImpl,
    identityRegistryStorageImpl,
    claimTopicsRegistryImpl,
    trustedIssuersRegistryImpl,
    complianceImpl,
  };
});

export default DeployPlatform;
