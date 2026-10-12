import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatVerifyPlugin from "@nomicfoundation/hardhat-verify";
import { HardhatUserConfig, configVariable } from "hardhat/config";

/**
 * NOTE: Placeholder only.
 * - Do not add deployments here beyond minimal solidity settings.
 * - Ignition modules go under ignition/modules/.
 */
const accounts = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : undefined;
const deployerKey = configVariable("DEPLOYER_KEY");

const config: HardhatUserConfig = {
  ignition: {
    requiredConfirmations: 1,
  },
  plugins: [hardhatToolboxViemPlugin, hardhatVerifyPlugin],
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.35",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
        },
      },
      production: {
        version: "0.8.35",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
    },
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
      ...(accounts ? { accounts } : {}),
    },
    private: {
      type: "http",
      chainType: "l1",
      url: configVariable("PRIVATE_RPC_URL"),
      accounts: accounts ?? [deployerKey],
    },
    mainnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("MAINNET_RPC_URL"),
      accounts: accounts ?? [deployerKey],
    },
    arbitrum: {
      type: "http",
      chainType: "op",
      url: configVariable("ARBITRUM_RPC_URL"),
      accounts: accounts ?? [deployerKey],
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: accounts ?? [deployerKey],
    },
  },
};

export default config;
