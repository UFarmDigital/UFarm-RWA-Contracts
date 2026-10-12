// This setup uses Hardhat Ignition to manage smart contract deployments.
// Learn more at https://hardhat.org/ignition

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const DeploySaleFixPrice = buildModule("DeploySaleFixPrice", (m) => {
  const owner = m.getParameter("owner", ZERO_ADDRESS);
  const token = m.getParameter("token", ZERO_ADDRESS);
  const stablecoins = m.getParameter<string[]>("stablecoins", []);

  const saleFixPriceImpl = m.contract("SaleFixPrice");
  const saleFixPriceInitData = m.encodeFunctionCall(saleFixPriceImpl, "initialize", [owner, token, stablecoins]);
  const saleFixPriceProxy = m.contract("ERC1967Proxy", [saleFixPriceImpl, saleFixPriceInitData]);
  const saleFixPrice = m.contractAt("SaleFixPrice", saleFixPriceProxy, { id: "SaleFixPriceUpgradeable" });

  return {
    saleFixPrice,
    saleFixPriceProxy,
    saleFixPriceImpl,
  };
});

export default DeploySaleFixPrice;
