import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USD = 10n ** 18n;

describe("PrivateCreditValueAggregator", async function () {
  const { viem } = await network.connect();
  const [owner, holder, outsider] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const deployAggregator = async (
    valueContracts: string[] = [],
    stablecoins: string[] = [],
    feeds: string[] = [],
    maxAges: number[] = [],
    sequencerFeed = ZERO_ADDRESS,
    sequencerGracePeriod = 0,
  ) => {
    const implementation = await viem.deployContract("PrivateCreditValueAggregator");
    const proxy = await viem.deployContract("TestERC1967Proxy", [implementation.address, "0x"]);
    const aggregator = await viem.getContractAt("PrivateCreditValueAggregator", proxy.address);

    await aggregator.write.initialize(
      [owner.account.address, valueContracts, stablecoins, feeds, maxAges, sequencerFeed, sequencerGracePeriod],
      { account: owner.account },
    );

    return { aggregator, implementation };
  };

  const setPrice = async (feed: any, answer: bigint, timestamp?: bigint) => {
    const now = timestamp ?? (await publicClient.getBlock()).timestamp;
    await feed.write.setRoundData([answer, now, now]);
    return now;
  };

  it("sums private-credit values as 1e18 USD using shared stablecoin oracle mappings", async function () {
    const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const dai = await viem.deployContract("MockERC20", ["Dai", "DAI", 18]);
    const usdcFeed = await viem.deployContract("MockChainlinkAggregatorV3", [8]);
    const daiFeed = await viem.deployContract("MockChainlinkAggregatorV3", [8]);
    const firstUsdcCredit = await viem.deployContract("MockPrivateCreditValueSource", [usdc.address]);
    const secondUsdcCredit = await viem.deployContract("MockPrivateCreditValueSource", [usdc.address]);
    const daiCredit = await viem.deployContract("MockPrivateCreditValueSource", [dai.address]);

    await setPrice(usdcFeed, 100_000_000n);
    await setPrice(daiFeed, 105_000_000n);
    await firstUsdcCredit.write.setValue([holder.account.address, 100n * 10n ** 6n]);
    await secondUsdcCredit.write.setValue([holder.account.address, 25n * 10n ** 6n]);
    await daiCredit.write.setValue([holder.account.address, 40n * 10n ** 18n]);

    const { aggregator } = await deployAggregator(
      [firstUsdcCredit.address, secondUsdcCredit.address, daiCredit.address],
      [usdc.address, dai.address],
      [usdcFeed.address, daiFeed.address],
      [3600, 3600],
    );

    assert.equal(await aggregator.read.totalValueOf([holder.account.address]), 167n * USD);
    assert.deepEqual(
      (await aggregator.read.getValueContracts()).map((address: string) => address.toLowerCase()),
      [firstUsdcCredit.address, secondUsdcCredit.address, daiCredit.address].map((address) => address.toLowerCase()),
    );
  });

  it("lets only the owner replace sources and shared oracle configurations", async function () {
    const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const usdcFeed = await viem.deployContract("MockChainlinkAggregatorV3", [8]);
    const credit = await viem.deployContract("MockPrivateCreditValueSource", [usdc.address]);
    const { aggregator } = await deployAggregator();

    await setPrice(usdcFeed, 100_000_000n);
    await credit.write.setValue([holder.account.address, 50n * 10n ** 6n]);

    await assert.rejects(() =>
      aggregator.write.setOracle([usdc.address, usdcFeed.address, 3600], { account: outsider.account }),
    );
    await assert.rejects(() => aggregator.write.setValueContracts([[credit.address]], { account: outsider.account }));

    await aggregator.write.setOracle([usdc.address, usdcFeed.address, 3600], { account: owner.account });
    await aggregator.write.setValueContracts([[credit.address]], { account: owner.account });
    assert.equal(await aggregator.read.totalValueOf([holder.account.address]), 50n * USD);

    await assert.rejects(() =>
      aggregator.write.setValueContracts([[credit.address, credit.address]], { account: owner.account }),
    );

    await aggregator.write.removeOracle([usdc.address], { account: owner.account });
    await assert.rejects(() => aggregator.read.totalValueOf([holder.account.address]));
  });

  it("rejects missing, stale, future, and non-positive price data", async function () {
    const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const feed = await viem.deployContract("MockChainlinkAggregatorV3", [8]);
    const credit = await viem.deployContract("MockPrivateCreditValueSource", [usdc.address]);
    const { aggregator } = await deployAggregator([credit.address], [usdc.address], [feed.address], [60]);
    const now = (await publicClient.getBlock()).timestamp;

    await feed.write.setRoundData([100_000_000n, now - 61n, now - 61n]);
    await assert.rejects(() => aggregator.read.totalValueOf([holder.account.address]));

    await feed.write.setRoundData([100_000_000n, now + 100n, now + 100n]);
    await assert.rejects(() => aggregator.read.totalValueOf([holder.account.address]));

    await feed.write.setRoundData([0n, now, now]);
    await assert.rejects(() => aggregator.read.totalValueOf([holder.account.address]));
  });

  it("uses an optional sequencer oracle on L2 and no sequencer oracle on L1", async function () {
    const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const feed = await viem.deployContract("MockChainlinkAggregatorV3", [8]);
    const sequencerFeed = await viem.deployContract("MockChainlinkAggregatorV3", [0]);
    const credit = await viem.deployContract("MockPrivateCreditValueSource", [usdc.address]);
    const { aggregator } = await deployAggregator([credit.address], [usdc.address], [feed.address], [3600]);
    const now = await setPrice(feed, 100_000_000n);

    await credit.write.setValue([holder.account.address, 1n * 10n ** 6n]);
    assert.equal(await aggregator.read.totalValueOf([holder.account.address]), USD);

    await aggregator.write.setSequencerOracle([sequencerFeed.address, 60], { account: owner.account });
    await sequencerFeed.write.setRoundData([1n, now - 120n, now]);
    await assert.rejects(() => aggregator.read.totalValueOf([holder.account.address]));

    await sequencerFeed.write.setRoundData([0n, now, now]);
    await assert.rejects(() => aggregator.read.totalValueOf([holder.account.address]));

    await sequencerFeed.write.setRoundData([0n, now - 120n, now]);
    assert.equal(await aggregator.read.totalValueOf([holder.account.address]), USD);

    await aggregator.write.setSequencerOracle([ZERO_ADDRESS, 0], { account: owner.account });
    assert.equal(await aggregator.read.totalValueOf([holder.account.address]), USD);
  });

  it("allows only the owner to authorize UUPS upgrades", async function () {
    const usdc = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const feed = await viem.deployContract("MockChainlinkAggregatorV3", [8]);
    const sequencerFeed = await viem.deployContract("MockChainlinkAggregatorV3", [0]);
    const credit = await viem.deployContract("MockPrivateCreditValueSource", [usdc.address]);
    const now = await setPrice(feed, 100_000_000n);
    await sequencerFeed.write.setRoundData([0n, now - 120n, now]);
    const { aggregator, implementation } = await deployAggregator(
      [credit.address],
      [usdc.address],
      [feed.address],
      [3600],
      sequencerFeed.address,
      60,
    );
    const v2 = await viem.deployContract("PrivateCreditValueAggregatorV2");

    await assert.rejects(() =>
      implementation.write.initialize([owner.account.address, [], [], [], [], ZERO_ADDRESS, 0], {
        account: owner.account,
      }),
    );
    await assert.rejects(() => aggregator.write.upgradeToAndCall([v2.address, "0x"], { account: outsider.account }));
    await aggregator.write.upgradeToAndCall([v2.address, "0x"], { account: owner.account });

    const upgraded = await viem.getContractAt("PrivateCreditValueAggregatorV2", aggregator.address);
    assert.equal(await upgraded.read.versionV2(), "v2");
    assert.equal((await upgraded.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    assert.deepEqual(
      (await upgraded.read.getValueContracts()).map((address: string) => address.toLowerCase()),
      [credit.address.toLowerCase()],
    );
    const oracle = await upgraded.read.oracleConfig([usdc.address]);
    assert.equal(oracle.feed.toLowerCase(), feed.address.toLowerCase());
    assert.equal(oracle.maxAge, 3600);
    assert.equal(oracle.stablecoinDecimals, 6);
    assert.equal(oracle.feedDecimals, 8);
    const sequencer = await upgraded.read.sequencerOracle();
    assert.equal(sequencer[0].toLowerCase(), sequencerFeed.address.toLowerCase());
    assert.equal(sequencer[1], 60);
  });
});
