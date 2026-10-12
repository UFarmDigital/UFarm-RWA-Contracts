// This setup uses Hardhat Ignition to manage smart contract deployments.
// Learn more at https://hardhat.org/ignition

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

const DeployPrivateCreditTokenSuite = buildModule("DeployPrivateCreditTokenSuite", (m) => {
  const tokenFactoryProxy = m.getParameter("tokenFactoryProxy", ZERO_ADDRESS);

  const tokenName = m.getParameter("tokenName", "UFarm Private Credit");
  const tokenSymbol = m.getParameter("tokenSymbol", "UFPC");
  const tokenDecimals = m.getParameter("tokenDecimals", 18);
  const tokenVersion = m.getParameter("tokenVersion", "1");
  const tokenOwner = m.getParameter("tokenOwner", ZERO_ADDRESS);
  const tokenSalt = m.getParameter("tokenSalt", ZERO_BYTES32);

  const stablecoin = m.getParameter("stablecoin", ZERO_ADDRESS);
  const fundingAddress = m.getParameter("fundingAddress", ZERO_ADDRESS);
  const denominationFeed = m.getParameter("denominationFeed", ZERO_ADDRESS);
  const denominationMaxAge = m.getParameter("denominationMaxAge", 0);
  const stablecoinFeed = m.getParameter("stablecoinFeed", ZERO_ADDRESS);
  const stablecoinMaxAge = m.getParameter("stablecoinMaxAge", 0);
  const sequencerFeed = m.getParameter("sequencerFeed", ZERO_ADDRESS);
  const sequencerGracePeriod = m.getParameter("sequencerGracePeriod", 0);
  const minTicket = m.getParameter("minTicket", 100n * 10n ** 18n);
  const duration = m.getParameter("duration", 365n * 24n * 60n * 60n);
  const minPeriod = m.getParameter("minPeriod", 30n * 24n * 60n * 60n);
  const lockup = m.getParameter("lockup", 7n * 24n * 60n * 60n);
  const apyBps = m.getParameter("apyBps", 1_200);
  const distributionTerms = m.getParameter("distributionTerms", 0);
  const yieldMode = m.getParameter("yieldMode", 0);

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

  const privateCreditDetails = {
    stablecoin,
    fundingAddress,
    oracleParameters: {
      denominationFeed,
      denominationMaxAge,
      stablecoinFeed,
      stablecoinMaxAge,
      sequencerFeed,
      sequencerGracePeriod,
    },
    conditions: {
      minTicket,
      duration,
      minPeriod,
      lockup,
      apyBps,
      distributionTerms,
      yieldMode,
    },
  };

  const factory = m.contractAt("TokenFactory", tokenFactoryProxy);
  m.call(factory, "deployPrivateCreditTokenSuite", [
    tokenDetails,
    claimDetails,
    privateCreditDetails,
    reuseIdentityRegistryStorage,
  ]);

  return { factory };
});

export default DeployPrivateCreditTokenSuite;
