// This setup uses Hardhat Ignition to manage smart contract deployments.
// Learn more at https://hardhat.org/ignition

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const DeployPrivateCreditValueAggregator = buildModule("DeployPrivateCreditValueAggregator", (m) => {
  const owner = m.getParameter("owner", ZERO_ADDRESS);
  const valueContracts = m.getParameter<string[]>("valueContracts", []);
  const stablecoins = m.getParameter<string[]>("stablecoins", []);
  const usdFeeds = m.getParameter<string[]>("usdFeeds", []);
  const maxAges = m.getParameter<number[]>("maxAges", []);
  const sequencerFeed = m.getParameter("sequencerFeed", ZERO_ADDRESS);
  const sequencerGracePeriod = m.getParameter("sequencerGracePeriod", 0);

  const implementation = m.contract("PrivateCreditValueAggregator");
  const initData = m.encodeFunctionCall(implementation, "initialize", [
    owner,
    valueContracts,
    stablecoins,
    usdFeeds,
    maxAges,
    sequencerFeed,
    sequencerGracePeriod,
  ]);
  const proxy = m.contract("ERC1967Proxy", [implementation, initData]);
  const aggregator = m.contractAt("PrivateCreditValueAggregator", proxy, {
    id: "PrivateCreditValueAggregatorUpgradeable",
  });

  return { aggregator, proxy, implementation };
});

export default DeployPrivateCreditValueAggregator;
