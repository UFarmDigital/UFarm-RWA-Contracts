// This setup uses Hardhat Ignition to manage smart contract deployments.
// Learn more at https://hardhat.org/ignition

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

const DeployTokenSuite = buildModule("DeployTokenSuite", (m) => {
  const tokenFactoryProxy = m.getParameter("tokenFactoryProxy", ZERO_ADDRESS);

  const tokenName = m.getParameter("tokenName", "UFarm Asset");
  const tokenSymbol = m.getParameter("tokenSymbol", "UFARM");
  const tokenDecimals = m.getParameter("tokenDecimals", 18);
  const tokenVersion = m.getParameter("tokenVersion", "1");
  const tokenOwner = m.getParameter("tokenOwner", ZERO_ADDRESS);
  const tokenSalt = m.getParameter("tokenSalt", ZERO_BYTES32);

  const reuseIdentityRegistryStorage = m.getParameter("reuseIdentityRegistryStorage", ZERO_ADDRESS);

  const requiredTopics = m.getParameter<number[]>("requiredTopics", []);
  const trustedIssuers = m.getParameter<string[]>("trustedIssuers", []);
  const issuerTopics = m.getParameter<number[][]>("issuerTopics", []);

  const tokenDetails = {
    name: tokenName,
    symbol: tokenSymbol,
    decimals: tokenDecimals,
    version: tokenVersion,
    owner: tokenOwner,
    salt: tokenSalt,
  };

  const claimDetails = {
    requiredTopics,
    trustedIssuers,
    issuerTopics,
  };

  const factory = m.contractAt("TokenFactory", tokenFactoryProxy);
  const deployCall = m.call(factory, "deployTokenSuite", [tokenDetails, claimDetails, reuseIdentityRegistryStorage]);

  return { factory, deployCall };
});

export default DeployTokenSuite;
