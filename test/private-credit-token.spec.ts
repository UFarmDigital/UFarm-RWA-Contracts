import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress } from "viem";

import { deployUpgradeable } from "./helpers/deploy-upgradeable";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DAY = 24n * 60n * 60n;
const TOKEN_SCALE = 10n ** 18n;
const STABLECOIN_SCALE = 10n ** 6n;
const INDEX_SCALE = 10n ** 27n;
const YEAR = 365n * DAY;
const conditions = {
  minTicket: 100n * 10n ** 18n,
  duration: 365n * DAY,
  minPeriod: 30n * DAY,
  lockup: 7n * DAY,
  apyBps: 1_200,
  distributionTerms: 0,
  yieldMode: 0,
};
const accretingConditions = { ...conditions, yieldMode: 1 };
const NO_ORACLE = {
  denominationFeed: ZERO_ADDRESS,
  denominationMaxAge: 0,
  stablecoinFeed: ZERO_ADDRESS,
  stablecoinMaxAge: 0,
  sequencerFeed: ZERO_ADDRESS,
  sequencerGracePeriod: 0,
};

const deployPrivateCreditSuite = async (
  viem: any,
  accounts: any,
  debtConditions = conditions,
  tokenDecimals = 18,
  stablecoinDecimals = 6,
  bindCompliance = true,
  complianceOverride?: any,
  oracleParameters = NO_ORACLE,
) => {
  const [owner, agent, , funding] = accounts;
  const claimIssuer = await viem.deployContract("MockClaimIssuer");

  const { contract: claimTopics } = await deployUpgradeable(viem, "ClaimTopicsRegistry");
  await claimTopics.write.initialize([owner.account.address, [1n]], { account: owner.account });
  const { contract: trustedIssuers } = await deployUpgradeable(viem, "TrustedIssuersRegistry");
  await trustedIssuers.write.initialize([owner.account.address, [claimIssuer.address], [[1n]]], {
    account: owner.account,
  });
  const { contract: storage } = await deployUpgradeable(viem, "IdentityRegistryStorage");
  await storage.write.initialize([owner.account.address, owner.account.address], { account: owner.account });
  const { contract: identityRegistry } = await deployUpgradeable(viem, "IdentityRegistry");
  await identityRegistry.write.initialize(
    [
      owner.account.address,
      storage.address,
      claimTopics.address,
      trustedIssuers.address,
      [agent.account.address],
      owner.account.address,
    ],
    { account: owner.account },
  );
  await storage.write.bindRegistry([identityRegistry.address], { account: owner.account });

  const { contract: compliance } = complianceOverride
    ? { contract: complianceOverride }
    : await deployUpgradeable(viem, "Compliance");
  if (!complianceOverride) {
    await compliance.write.initialize([owner.account.address, owner.account.address], { account: owner.account });
  }
  const stablecoin = await viem.deployContract("MockERC20", ["USD Coin", "USDC", stablecoinDecimals]);
  const tokenImpl = await viem.deployContract("PrivateCreditToken");
  const tokenProxy = await viem.deployContract("TestERC1967Proxy", [tokenImpl.address, "0x"]);
  const token = await viem.getContractAt("PrivateCreditToken", tokenProxy.address);

  await token.write.initialize(
    [
      "UFarm Private Credit",
      "UFPC",
      tokenDecimals,
      "1",
      owner.account.address,
      identityRegistry.address,
      compliance.address,
      [agent.account.address],
      stablecoin.address,
      funding.account.address,
      debtConditions,
      oracleParameters,
    ],
    { account: owner.account },
  );
  await identityRegistry.write.bindToken([token.address], { account: owner.account });
  if (bindCompliance) {
    await compliance.write.bindToken([token.address], { account: owner.account });
  }

  return { token, stablecoin, identityRegistry, compliance };
};

describe("PrivateCreditToken", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [owner, agent, investor, issuer, funding, outsider, bob] = await viem.getWalletClients();

  it("provides configurable Chainlink round data for private-credit tests", async function () {
    const feed = await viem.deployContract("MockChainlinkAggregatorV3", [8]);
    await feed.write.setRoundData([110_000_000n, 100n, 200n]);
    assert.equal(await feed.read.decimals(), 8);
    assert.deepEqual(await feed.read.latestRoundData(), [1n, 110_000_000n, 100n, 200n, 1n]);
    await feed.write.setShouldRevert([true]);
    await assert.rejects(() => feed.read.latestRoundData());
  });

  it("returns an all-zero oracle configuration when no feeds are configured", async function () {
    const { token } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);

    assert.deepEqual(await token.read.oracleConfig(), {
      ...NO_ORACLE,
      denominationFeedDecimals: 0,
      stablecoinFeedDecimals: 0,
    });
  });

  it("caches configured feed decimals and permits only owner timing updates", async function () {
    const denominationFeed = await viem.deployContract("MockChainlinkAggregatorV3", [8]);
    const stablecoinFeed = await viem.deployContract("MockChainlinkAggregatorV3", [6]);
    const sequencerFeed = await viem.deployContract("MockChainlinkAggregatorV3", [0]);
    const oracle = {
      denominationFeed: getAddress(denominationFeed.address),
      denominationMaxAge: 3_600,
      stablecoinFeed: getAddress(stablecoinFeed.address),
      stablecoinMaxAge: 300,
      sequencerFeed: getAddress(sequencerFeed.address),
      sequencerGracePeriod: 3_600,
    };
    const { token } = await deployPrivateCreditSuite(
      viem,
      [owner, agent, investor, issuer, funding],
      conditions,
      18,
      6,
      true,
      undefined,
      oracle,
    );

    assert.deepEqual(await token.read.oracleConfig(), {
      ...oracle,
      denominationFeedDecimals: 8,
      stablecoinFeedDecimals: 6,
    });
    await assert.rejects(() => token.write.setOracleMaxAges([60, 60], { account: outsider.account }));

    const fromBlock = await publicClient.getBlockNumber();
    const maxAgesHash = await token.write.setOracleMaxAges([7_200, 600], { account: owner.account });
    await publicClient.waitForTransactionReceipt({ hash: maxAgesHash });
    const gracePeriodHash = await token.write.setSequencerGracePeriod([1_800], { account: owner.account });
    await publicClient.waitForTransactionReceipt({ hash: gracePeriodHash });
    const maxAgeEvents = await publicClient.getContractEvents({
      address: token.address,
      abi: token.abi,
      eventName: "OracleMaxAgesUpdated",
      fromBlock,
      strict: true,
    });
    const gracePeriodEvents = await publicClient.getContractEvents({
      address: token.address,
      abi: token.abi,
      eventName: "SequencerGracePeriodUpdated",
      fromBlock,
      strict: true,
    });
    assert.deepEqual(maxAgeEvents[0]?.args, { denominationMaxAge: 7_200, stablecoinMaxAge: 600 });
    assert.deepEqual(gracePeriodEvents[0]?.args, { sequencerGracePeriod: 1_800 });

    const updated = await token.read.oracleConfig();
    assert.equal(updated.denominationMaxAge, 7_200);
    assert.equal(updated.stablecoinMaxAge, 600);
    assert.equal(updated.sequencerGracePeriod, 1_800);
  });

  it("rejects invalid oracle configuration and unsupported feed decimals", async function () {
    const invalidOracleInputs = [
      { ...NO_ORACLE, denominationMaxAge: 1 },
      { ...NO_ORACLE, stablecoinMaxAge: 1 },
      { ...NO_ORACLE, sequencerGracePeriod: 1 },
      { ...NO_ORACLE, denominationFeed: outsider.account.address, denominationMaxAge: 1 },
      { ...NO_ORACLE, stablecoinFeed: outsider.account.address, stablecoinMaxAge: 1 },
      { ...NO_ORACLE, sequencerFeed: outsider.account.address, sequencerGracePeriod: 1 },
    ];
    for (const oracle of invalidOracleInputs) {
      await assert.rejects(() =>
        deployPrivateCreditSuite(viem, [owner, agent, issuer, funding], conditions, 18, 6, true, undefined, oracle),
      );
    }

    const denominationFeed = await viem.deployContract("MockChainlinkAggregatorV3", [8]);
    const stablecoinFeed = await viem.deployContract("MockChainlinkAggregatorV3", [6]);
    const sequencerFeed = await viem.deployContract("MockChainlinkAggregatorV3", [0]);
    await assert.rejects(() =>
      deployPrivateCreditSuite(viem, [owner, agent, issuer, funding], conditions, 18, 6, true, undefined, {
        ...NO_ORACLE,
        denominationFeed: denominationFeed.address,
      }),
    );
    await assert.rejects(() =>
      deployPrivateCreditSuite(viem, [owner, agent, issuer, funding], conditions, 18, 6, true, undefined, {
        ...NO_ORACLE,
        sequencerFeed: sequencerFeed.address,
      }),
    );
    const highDecimalsFeed = await viem.deployContract("MockChainlinkAggregatorV3", [19]);
    await assert.rejects(
      () =>
        deployPrivateCreditSuite(viem, [owner, agent, issuer, funding], conditions, 18, 6, true, undefined, {
          ...NO_ORACLE,
          denominationFeed: highDecimalsFeed.address,
          denominationMaxAge: 1,
        }),
      /UnsupportedOracleDecimals/,
    );
    await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding], conditions, 18, 6, true, undefined, {
      ...NO_ORACLE,
      denominationFeed: denominationFeed.address,
      denominationMaxAge: 2 ** 32 - 1,
      stablecoinFeed: stablecoinFeed.address,
      stablecoinMaxAge: 2 ** 32 - 1,
      sequencerFeed: sequencerFeed.address,
      sequencerGracePeriod: 2 ** 32 - 1,
    });
  });

  const registerVerifiedInvestor = async (identityRegistry: any, account = investor) => {
    const trustedIssuers = await viem.getContractAt(
      "TrustedIssuersRegistry",
      await identityRegistry.read.trustedIssuersRegistry(),
    );
    const [claimIssuer] = await trustedIssuers.read.getTrustedIssuers();
    const identity = await viem.deployContract("MockOnchainID");
    await identity.write.setClaim([1n, claimIssuer, true]);
    await identityRegistry.write.registerIdentity([account.account.address, identity.address, 840], {
      account: agent.account,
    });
  };

  const increaseTo = async (timestamp: bigint) => {
    await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [Number(timestamp)] });
    await publicClient.request({ method: "evm_mine", params: [] });
  };

  const setNextBlockTime = async (timestamp: bigint) => {
    await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [Number(timestamp)] });
  };

  const deployOraclePriceSuite = async (
    sequencer = false,
    startDebt = true,
    denominationFeedDecimals = 8,
    stablecoinFeedDecimals = 8,
    debtConditions = conditions,
  ) => {
    const denominationFeed = await viem.deployContract("MockChainlinkAggregatorV3", [denominationFeedDecimals]);
    const stablecoinFeed = await viem.deployContract("MockChainlinkAggregatorV3", [stablecoinFeedDecimals]);
    const sequencerFeed = sequencer ? await viem.deployContract("MockChainlinkAggregatorV3", [0]) : undefined;
    const { token } = await deployPrivateCreditSuite(
      viem,
      [owner, agent, issuer, funding],
      debtConditions,
      18,
      6,
      true,
      undefined,
      {
        denominationFeed: denominationFeed.address,
        denominationMaxAge: 3_600,
        stablecoinFeed: stablecoinFeed.address,
        stablecoinMaxAge: 3_600,
        sequencerFeed: sequencerFeed?.address ?? ZERO_ADDRESS,
        sequencerGracePeriod: sequencer ? 3_600 : 0,
      },
    );
    if (startDebt) await token.write.start({ account: owner.account });
    return { token, denominationFeed, stablecoinFeed, sequencerFeed };
  };

  const setValidPriceRounds = async (denominationFeed: any, stablecoinFeed: any, timestamp: bigint) => {
    await denominationFeed.write.setRoundData([110_000_000n, timestamp, timestamp]);
    await stablecoinFeed.write.setRoundData([100_000_000n, timestamp, timestamp]);
  };

  it("reads configured prices at the maximum permitted age and rejects stale answers", async function () {
    const { token, denominationFeed, stablecoinFeed } = await deployOraclePriceSuite();
    const now = (await publicClient.getBlock()).timestamp;
    await setValidPriceRounds(denominationFeed, stablecoinFeed, now);

    await increaseTo(now + 3_600n);
    const expectedPrice = await token.read.mintPrice([100n * TOKEN_SCALE]);
    assert.equal(await token.read.mintPrice([100n * TOKEN_SCALE]), expectedPrice);

    await increaseTo(now + 3_601n);
    await assert.rejects(() => token.read.mintPrice([100n * TOKEN_SCALE]));
  });

  it("fails closed for invalid or unavailable configured price feeds", async function () {
    const invalidAnswers = [0n, -1n];
    for (const feedName of ["denominationFeed", "stablecoinFeed"] as const) {
      for (const answer of invalidAnswers) {
        const { token, denominationFeed, stablecoinFeed } = await deployOraclePriceSuite();
        const now = (await publicClient.getBlock()).timestamp;
        await setValidPriceRounds(denominationFeed, stablecoinFeed, now);
        await (feedName === "denominationFeed" ? denominationFeed : stablecoinFeed).write.setRoundData([
          answer,
          now,
          now,
        ]);
        await assert.rejects(() => token.read.mintPrice([100n * TOKEN_SCALE]));
      }

      for (const futureTimestamp of [false, true]) {
        const { token, denominationFeed, stablecoinFeed } = await deployOraclePriceSuite();
        const now = (await publicClient.getBlock()).timestamp;
        await setValidPriceRounds(denominationFeed, stablecoinFeed, now);
        const feed = feedName === "denominationFeed" ? denominationFeed : stablecoinFeed;
        const [startedAt, updatedAt] = futureTimestamp ? [now + DAY, now + DAY] : [0n, 0n];
        await feed.write.setRoundData([110_000_000n, startedAt, updatedAt]);
        await assert.rejects(() => token.read.mintPrice([100n * TOKEN_SCALE]));
      }

      const { token, denominationFeed, stablecoinFeed } = await deployOraclePriceSuite();
      const now = (await publicClient.getBlock()).timestamp;
      await setValidPriceRounds(denominationFeed, stablecoinFeed, now);
      const feed = feedName === "denominationFeed" ? denominationFeed : stablecoinFeed;
      await feed.write.setShouldRevert([true]);
      await assert.rejects(() => token.read.mintPrice([100n * TOKEN_SCALE]));
    }
  });

  it("handles large valid oracle answers without intermediate overflow", async function () {
    const { token, denominationFeed, stablecoinFeed } = await deployOraclePriceSuite();
    const now = (await publicClient.getBlock()).timestamp;
    await denominationFeed.write.setRoundData([(2n ** 255n - 1n) / 10n ** 10n, now, now]);
    await stablecoinFeed.write.setRoundData([100_000_000n, now, now]);

    assert.equal(await token.read.mintPrice([100n * TOKEN_SCALE]), await token.read.mintPrice([100n * TOKEN_SCALE]));
  });

  it("prices principal through one or two feeds with mint ceiling and valuation floor rounding", async function () {
    const { token, denominationFeed, stablecoinFeed } = await deployOraclePriceSuite(false, false);
    const now = (await publicClient.getBlock()).timestamp;
    const amount = 100n * TOKEN_SCALE;

    await denominationFeed.write.setRoundData([100_000_000n, now, now]);
    await stablecoinFeed.write.setRoundData([99_990_000n, now, now]);
    await token.write.start({ account: owner.account });
    assert.equal(await token.read.mintPrice([amount]), 100_010_002n);
    assert.equal(await token.read.totalValueOf([investor.account.address]), 0n);

    const second = await deployOraclePriceSuite(false, false);
    const secondNow = (await publicClient.getBlock()).timestamp;
    await second.denominationFeed.write.setRoundData([110_000_000n, secondNow, secondNow]);
    await second.stablecoinFeed.write.setRoundData([99_990_000n, secondNow, secondNow]);
    await second.token.write.start({ account: owner.account });
    assert.equal(await second.token.read.mintPrice([amount]), 110_011_002n);
  });

  it("keeps custody and funded claims live when configured feeds fail", async function () {
    const { token, denominationFeed, stablecoinFeed } = await deployOraclePriceSuite();
    const stablecoin = await viem.getContractAt("MockERC20", await token.read.stablecoin());
    const identityRegistry = await viem.getContractAt("IdentityRegistry", await token.read.identityRegistry());
    const now = (await publicClient.getBlock()).timestamp;
    await setValidPriceRounds(denominationFeed, stablecoinFeed, now);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await registerVerifiedInvestor(identityRegistry, outsider);
    await mintInvestment(token, 2n * conditions.minTicket);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    const distributionTime = (await publicClient.getBlock()).timestamp;
    await setValidPriceRounds(denominationFeed, stablecoinFeed, distributionTime);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.distributeIncome({ account: owner.account });
    const claim = await token.read.claimableIncome([investor.account.address]);

    await denominationFeed.write.setShouldRevert([true]);
    await stablecoinFeed.write.setShouldRevert([true]);
    await token.write.transfer([bob.account.address, conditions.minTicket], { account: investor.account });
    await token.write.forcedTransfer([investor.account.address, bob.account.address, conditions.minTicket], {
      account: agent.account,
    });
    await token.write.requestWithdrawal([conditions.minTicket], { account: bob.account });
    await identityRegistry.write.removeIdentity([outsider.account.address], { account: agent.account });
    await token.write.recoveryAddress([bob.account.address, outsider.account.address], { account: agent.account });
    assert.equal(await token.read.totalValueOf([bob.account.address]), 0n);
    assert.equal(await token.read.claimableIncome([investor.account.address]), claim);
    await token.write.claimIncome({ account: investor.account });
    assert.equal(await token.read.claimableIncome([investor.account.address]), 0n);
    await assert.rejects(() => token.read.mintPrice([conditions.minTicket]));
    await assert.rejects(() => token.read.totalValueOf([outsider.account.address]));
    await assert.rejects(() => token.write.distributeIncome({ account: owner.account }));
    await assert.rejects(() => token.read.settlementFundingRequired([[outsider.account.address]]));
    await assert.rejects(() => token.write.settleWithdrawals([[outsider.account.address]], { account: owner.account }));
  });

  it("normalizes equivalent feed decimals, floors valuation, and handles a large cross-rate", async function () {
    const amount = 100n * TOKEN_SCALE;
    const lowRateConditions = { ...conditions, apyBps: 1 };
    const eight = await deployOraclePriceSuite(false, false, 8, 8, lowRateConditions);
    const eightNow = (await publicClient.getBlock()).timestamp;
    await eight.denominationFeed.write.setRoundData([110_000_000n, eightNow, eightNow]);
    await eight.stablecoinFeed.write.setRoundData([99_990_000n, eightNow, eightNow]);
    await eight.token.write.start({ account: owner.account });
    const eightPrice = await eight.token.read.mintPrice([amount]);

    const normalized = await deployOraclePriceSuite(false, false, 18, 6, lowRateConditions);
    const normalizedNow = (await publicClient.getBlock()).timestamp;
    await normalized.denominationFeed.write.setRoundData([1_100_000_000_000_000_000n, normalizedNow, normalizedNow]);
    await normalized.stablecoinFeed.write.setRoundData([999_900n, normalizedNow, normalizedNow]);
    await normalized.token.write.start({ account: owner.account });
    assert.equal(await normalized.token.read.mintPrice([amount]), eightPrice);

    const identityRegistry = await viem.getContractAt(
      "IdentityRegistry",
      await normalized.token.read.identityRegistry(),
    );
    await registerVerifiedInvestor(identityRegistry);
    await mintInvestment(normalized.token, amount);
    assert.equal(await normalized.token.read.totalValueOf([investor.account.address]), 110_011_001n);

    const large = await deployOraclePriceSuite();
    const largeNow = (await publicClient.getBlock()).timestamp;
    await large.denominationFeed.write.setRoundData([(2n ** 255n - 1n) / 10n ** 10n, largeNow, largeNow]);
    await large.stablecoinFeed.write.setRoundData([100_000_000n, largeNow, largeNow]);
    assert.ok((await large.token.read.mintPrice([amount])) > 2n ** 200n);
  });

  it("uses live distributing FX before funding and fixes the distributed claim", async function () {
    const { token, denominationFeed, stablecoinFeed } = await deployOraclePriceSuite();
    const stablecoin = await viem.getContractAt("MockERC20", await token.read.stablecoin());
    const identityRegistry = await viem.getContractAt("IdentityRegistry", await token.read.identityRegistry());
    await registerVerifiedInvestor(identityRegistry);
    const now = (await publicClient.getBlock()).timestamp;
    await denominationFeed.write.setRoundData([100_000_000n, now, now]);
    await stablecoinFeed.write.setRoundData([100_000_000n, now, now]);
    await mintInvestment(token, conditions.minTicket);
    await increaseTo((await token.read.startTime()) + 30n * DAY);
    const firstNow = (await publicClient.getBlock()).timestamp;
    await denominationFeed.write.setRoundData([100_000_000n, firstNow, firstNow]);
    await stablecoinFeed.write.setRoundData([100_000_000n, firstNow, firstNow]);
    const before = await token.read.accumulatedIncomeOf([investor.account.address]);
    const changedNow = (await publicClient.getBlock()).timestamp;
    await denominationFeed.write.setRoundData([200_000_000n, changedNow, changedNow]);
    const live = await token.read.accumulatedIncomeOf([investor.account.address]);
    assert.ok(live > before);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.distributeIncome({ account: owner.account });
    const fixed = await token.read.claimableIncome([investor.account.address]);
    const laterNow = (await publicClient.getBlock()).timestamp;
    await denominationFeed.write.setRoundData([300_000_000n, laterNow, laterNow]);
    await stablecoinFeed.write.setRoundData([100_000_000n, laterNow, laterNow]);
    assert.equal(await token.read.claimableIncome([investor.account.address]), fixed);
    await increaseTo(laterNow + DAY);
    const twoXNow = (await publicClient.getBlock()).timestamp;
    await denominationFeed.write.setRoundData([200_000_000n, twoXNow, twoXNow]);
    await stablecoinFeed.write.setRoundData([100_000_000n, twoXNow, twoXNow]);
    const atTwoX = await token.read.accumulatedIncomeOf([investor.account.address]);
    const repricedNow = (await publicClient.getBlock()).timestamp;
    await denominationFeed.write.setRoundData([300_000_000n, repricedNow, repricedNow]);
    await stablecoinFeed.write.setRoundData([100_000_000n, repricedNow, repricedNow]);
    const atThreeX = await token.read.accumulatedIncomeOf([investor.account.address]);
    assert.ok(atThreeX > atTwoX);
    assert.equal(await token.read.claimableIncome([investor.account.address]), fixed);
    await denominationFeed.write.setShouldRevert([true]);
    await stablecoinFeed.write.setShouldRevert([true]);
    await token.write.claimIncome({ account: investor.account });
  });

  it("reprices accreting mint and valuation with live FX before settlement", async function () {
    const { token, denominationFeed, stablecoinFeed } = await deployOraclePriceSuite(
      false,
      true,
      8,
      8,
      accretingConditions,
    );
    const identityRegistry = await viem.getContractAt("IdentityRegistry", await token.read.identityRegistry());
    await registerVerifiedInvestor(identityRegistry);
    const now = (await publicClient.getBlock()).timestamp;
    await denominationFeed.write.setRoundData([100_000_000n, now, now]);
    await stablecoinFeed.write.setRoundData([100_000_000n, now, now]);
    await mintInvestment(token, conditions.minTicket);
    await increaseTo((await token.read.startTime()) + 30n * DAY);
    const changedNow = (await publicClient.getBlock()).timestamp;
    await stablecoinFeed.write.setRoundData([100_000_000n, changedNow, changedNow]);
    await denominationFeed.write.setRoundData([100_000_000n, changedNow, changedNow]);
    const mintBefore = await token.read.mintPrice([conditions.minTicket]);
    const valueBefore = await token.read.totalValueOf([investor.account.address]);
    await denominationFeed.write.setRoundData([150_000_000n, changedNow, changedNow]);
    assert.ok((await token.read.mintPrice([conditions.minTicket])) > mintBefore);
    assert.ok((await token.read.totalValueOf([investor.account.address])) > valueBefore);
  });

  it("floors FX settlement, fixes partial and maturity claims, and pays them during feed failure", async function () {
    const { token, denominationFeed, stablecoinFeed } = await deployOraclePriceSuite();
    const stablecoin = await viem.getContractAt("MockERC20", await token.read.stablecoin());
    const identityRegistry = await viem.getContractAt("IdentityRegistry", await token.read.identityRegistry());
    await registerVerifiedInvestor(identityRegistry);
    const setPrices = async () => {
      const now = (await publicClient.getBlock()).timestamp;
      await denominationFeed.write.setRoundData([110_000_000n, now, now]);
      await stablecoinFeed.write.setRoundData([99_990_000n, now, now]);
    };
    await setPrices();
    await mintInvestment(token, 2n * conditions.minTicket);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([conditions.minTicket], { account: investor.account });
    await increaseTo((await publicClient.getBlock()).timestamp + conditions.lockup);
    await setPrices();
    const startTime = await token.read.startTime();
    const expectedSettlement = (amount: bigint, timestamp: bigint) => {
      const elapsed = timestamp - startTime;
      const denominationIncomePerToken =
        (BigInt(conditions.apyBps) * elapsed * INDEX_SCALE) / (10_000n * YEAR * 10n ** 12n);
      const stablecoinIncomePerToken = (denominationIncomePerToken * 110_000_000n) / 99_990_000n;
      const principal = ((amount / (TOKEN_SCALE / STABLECOIN_SCALE)) * 110_000_000n) / 99_990_000n;
      return principal + (amount * stablecoinIncomePerToken) / INDEX_SCALE;
    };
    const quoteTime = (await publicClient.getBlock()).timestamp;
    const partialQuote = await token.read.settlementFundingRequired([[investor.account.address]]);
    assert.equal(partialQuote, expectedSettlement(conditions.minTicket, quoteTime));
    await fund(stablecoin, token, 1_000_000_000n);
    const partialSettlementTime = (await publicClient.getBlock()).timestamp + 1n;
    const expectedPartial = expectedSettlement(conditions.minTicket, partialSettlementTime);
    const fundingBefore = await stablecoin.read.balanceOf([funding.account.address]);
    await setNextBlockTime(partialSettlementTime);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    const partialClaim = await token.read.claimableIncome([investor.account.address]);
    assert.equal(partialClaim, expectedPartial);
    const partialFunding = fundingBefore - (await stablecoin.read.balanceOf([funding.account.address]));
    assert.equal(partialFunding, expectedPartial);

    await denominationFeed.write.setShouldRevert([true]);
    await stablecoinFeed.write.setShouldRevert([true]);
    assert.equal(await token.read.claimableIncome([investor.account.address]), partialClaim);
    await token.write.claimIncome({ account: investor.account });

    await denominationFeed.write.setShouldRevert([false]);
    await stablecoinFeed.write.setShouldRevert([false]);
    await increaseTo(await token.read.maturity());
    await setPrices();
    const maturityQuote = await token.read.settlementFundingRequired([[investor.account.address]]);
    const expectedMaturity = expectedSettlement(conditions.minTicket, await token.read.maturity());
    assert.equal(maturityQuote, expectedMaturity);
    await fund(stablecoin, token, expectedMaturity);
    const maturityFundingBefore = await stablecoin.read.balanceOf([funding.account.address]);
    const maturitySettlementTime = (await publicClient.getBlock()).timestamp + 1n;
    await setNextBlockTime(maturitySettlementTime);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    assert.equal(
      maturityFundingBefore - (await stablecoin.read.balanceOf([funding.account.address])),
      expectedMaturity,
    );
    const maturityClaim = await token.read.claimableIncome([investor.account.address]);
    assert.equal(maturityClaim, expectedMaturity);
    await denominationFeed.write.setShouldRevert([true]);
    await stablecoinFeed.write.setShouldRevert([true]);
    assert.equal(await token.read.totalValueOf([investor.account.address]), maturityClaim);
    await token.write.claimIncome({ account: investor.account });
  });

  it("uses one gas-sensitive snapshot for an equal-holder settlement batch", async function () {
    const { token, denominationFeed, stablecoinFeed } = await deployOraclePriceSuite();
    const stablecoin = await viem.getContractAt("MockERC20", await token.read.stablecoin());
    const identityRegistry = await viem.getContractAt("IdentityRegistry", await token.read.identityRegistry());
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    const now = (await publicClient.getBlock()).timestamp;
    await denominationFeed.write.setRoundData([110_000_000n, now, now]);
    await stablecoinFeed.write.setRoundData([100_000_000n, now, now]);
    const amount = conditions.minTicket;
    const price = (await token.read.mintPrice([amount])) + 1_000_000n;
    for (const account of [investor, bob]) {
      await stablecoin.write.mint([account.account.address, price], { account: account.account });
      await stablecoin.write.approve([token.address, price], { account: account.account });
    }
    await publicClient.request({ method: "evm_setAutomine", params: [false] });
    await token.write.mintInvestment([amount, price], { account: investor.account });
    await token.write.mintInvestment([amount, price], { account: bob.account });
    await publicClient.request({ method: "evm_mine", params: [] });
    await publicClient.request({ method: "evm_setAutomine", params: [true] });
    await increaseTo(await token.read.maturity());
    const maturityNow = (await publicClient.getBlock()).timestamp;
    await denominationFeed.write.setRoundData([110_000_000n, maturityNow, maturityNow]);
    await stablecoinFeed.write.setRoundData([100_000_000n, maturityNow, maturityNow]);
    await denominationFeed.write.setGasSensitive([true]);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.settleWithdrawals([[investor.account.address, bob.account.address]], { account: owner.account });
    assert.equal(
      await token.read.claimableIncome([investor.account.address]),
      await token.read.claimableIncome([bob.account.address]),
    );
  });

  it("rejects unavailable sequencer states until the full grace period elapses", async function () {
    const { token, denominationFeed, stablecoinFeed, sequencerFeed } = await deployOraclePriceSuite(true);
    const now = (await publicClient.getBlock()).timestamp;
    await setValidPriceRounds(denominationFeed, stablecoinFeed, now);

    await sequencerFeed!.write.setRoundData([1n, now - 7_200n, now]);
    await assert.rejects(() => token.read.mintPrice([100n * TOKEN_SCALE]));

    await sequencerFeed!.write.setRoundData([0n, 0n, now]);
    await assert.rejects(() => token.read.mintPrice([100n * TOKEN_SCALE]));

    const withinGraceNow = (await publicClient.getBlock()).timestamp;
    await sequencerFeed!.write.setRoundData([0n, withinGraceNow - 3_598n, withinGraceNow]);
    await assert.rejects(() => token.read.mintPrice([100n * TOKEN_SCALE]));

    await sequencerFeed!.write.setRoundData([0n, now + DAY, now]);
    await assert.rejects(() => token.read.mintPrice([100n * TOKEN_SCALE]));

    const recoveredNow = (await publicClient.getBlock()).timestamp;
    await sequencerFeed!.write.setRoundData([0n, recoveredNow - 3_602n, recoveredNow]);
    assert.equal(await token.read.mintPrice([100n * TOKEN_SCALE]), await token.read.mintPrice([100n * TOKEN_SCALE]));
  });

  const expectedIncome = (amount: bigint, elapsed: bigint) =>
    (amount * BigInt(conditions.apyBps) * elapsed * STABLECOIN_SCALE) / (YEAR * 10_000n * TOKEN_SCALE);

  const expectedMintPremium = (amount: bigint, elapsed: bigint, tokenDecimals = 18, stablecoinDecimals = 6) => {
    const decimalDifference = BigInt(Math.abs(stablecoinDecimals - tokenDecimals));
    const multiplier = stablecoinDecimals >= tokenDecimals ? INDEX_SCALE * 10n ** decimalDifference : INDEX_SCALE;
    const denominator =
      stablecoinDecimals >= tokenDecimals ? YEAR * 10_000n : YEAR * 10_000n * 10n ** decimalDifference;
    const incomePerToken = (BigInt(conditions.apyBps) * elapsed * multiplier) / denominator;
    return (amount * incomePerToken + INDEX_SCALE - 1n) / INDEX_SCALE;
  };

  const fund = async (stablecoin: any, token: any, amount: bigint) => {
    await stablecoin.write.mint([funding.account.address, amount], { account: funding.account });
    await stablecoin.write.approve([token.address, amount], { account: funding.account });
  };

  const mintInvestment = async (token: any, tokenAmountOut: bigint, account = investor) => {
    const stablecoin = await viem.getContractAt("MockERC20", await token.read.stablecoin());
    const quotedStablecoinIn = await token.read.mintPrice([tokenAmountOut]);
    const maxStablecoinIn = quotedStablecoinIn + 1_000_000n;
    const fundingBalanceBefore = await stablecoin.read.balanceOf([funding.account.address]);
    await stablecoin.write.mint([account.account.address, maxStablecoinIn], { account: account.account });
    await stablecoin.write.approve([token.address, maxStablecoinIn], { account: account.account });
    await token.write.mintInvestment([tokenAmountOut, maxStablecoinIn], { account: account.account });
    const stablecoinIn = (await stablecoin.read.balanceOf([funding.account.address])) - fundingBalanceBefore;
    const residual = await stablecoin.read.balanceOf([account.account.address]);
    if (residual != 0n) {
      await stablecoin.write.transfer([outsider.account.address, residual], { account: account.account });
    }
    return stablecoinIn;
  };

  it("initializes packed immutable debt conditions and funding configuration", async function () {
    const { token, stablecoin } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);

    assert.equal(await token.read.decimals(), 18);
    assert.equal((await token.read.stablecoin()).toLowerCase(), stablecoin.address.toLowerCase());
    assert.equal((await token.read.fundingAddress()).toLowerCase(), funding.account.address.toLowerCase());
    const storedConditions = await token.read.debtConditions();
    assert.equal(storedConditions.minTicket, conditions.minTicket);
    assert.equal(storedConditions.duration, conditions.duration);
    assert.equal(storedConditions.minPeriod, conditions.minPeriod);
    assert.equal(storedConditions.lockup, conditions.lockup);
    assert.equal(storedConditions.apyBps, conditions.apyBps);
    assert.equal(storedConditions.distributionTerms, conditions.distributionTerms);
    assert.equal(storedConditions.yieldMode, conditions.yieldMode);

    const { token: accretingToken } = await deployPrivateCreditSuite(
      viem,
      [owner, agent, issuer, funding],
      accretingConditions,
    );
    assert.equal((await accretingToken.read.debtConditions()).yieldMode, accretingConditions.yieldMode);
  });

  it("collects the quoted investment price from a verified investor and mints the exact token amount", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });

    const amount = 100n * TOKEN_SCALE;
    const fundingBefore = await stablecoin.read.balanceOf([funding.account.address]);
    const stablecoinIn = await mintInvestment(token, amount);

    assert.equal(await token.read.balanceOf([investor.account.address]), amount);
    assert.equal(await stablecoin.read.balanceOf([funding.account.address]), fundingBefore + stablecoinIn);
  });

  it("requires production compliance binding for investment mint and transfer hooks", async function () {
    const { token, stablecoin, identityRegistry, compliance } = await deployPrivateCreditSuite(
      viem,
      [owner, agent, issuer, funding],
      conditions,
      18,
      6,
      false,
    );
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const amount = conditions.minTicket;
    const maxStablecoinIn = (await token.read.mintPrice([amount])) + 1_000_000n;
    await stablecoin.write.mint([investor.account.address, maxStablecoinIn], { account: investor.account });
    await stablecoin.write.approve([token.address, maxStablecoinIn], { account: investor.account });

    await assert.rejects(() => token.write.mintInvestment([amount, maxStablecoinIn], { account: investor.account }));

    await compliance.write.bindToken([token.address], { account: owner.account });
    await token.write.mintInvestment([amount, maxStablecoinIn], { account: investor.account });
    await token.write.transfer([bob.account.address, amount], { account: investor.account });
    assert.equal(await token.read.balanceOf([bob.account.address]), amount);
  });

  it("rejects investment mints without allowance or sufficient investor balance atomically", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const amount = 100n * TOKEN_SCALE;
    const price = await token.read.mintPrice([amount]);

    await stablecoin.write.mint([investor.account.address, price], { account: investor.account });
    await assert.rejects(() => token.write.mintInvestment([amount, price], { account: investor.account }));
    assert.equal(await token.read.balanceOf([investor.account.address]), 0n);
    assert.equal(await stablecoin.read.balanceOf([funding.account.address]), 0n);

    await stablecoin.write.approve([token.address, price], { account: investor.account });
    await stablecoin.write.transfer([outsider.account.address, 1n], { account: investor.account });
    await assert.rejects(() => token.write.mintInvestment([amount, price], { account: investor.account }));
    assert.equal(await token.read.balanceOf([investor.account.address]), 0n);
    assert.equal(await stablecoin.read.balanceOf([funding.account.address]), 0n);
  });

  it("rejects a verified funding address self-mint without moving stablecoin or issuing tokens", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry, funding);
    await token.write.start({ account: owner.account });
    const amount = conditions.minTicket;
    const price = await token.read.mintPrice([amount]);
    const maxStablecoinIn = price + 1_000_000n;
    await stablecoin.write.mint([funding.account.address, maxStablecoinIn], { account: funding.account });
    await stablecoin.write.approve([token.address, maxStablecoinIn], { account: funding.account });
    const fundingBalanceBefore = await stablecoin.read.balanceOf([funding.account.address]);

    await assert.rejects(() => token.write.mintInvestment([amount, maxStablecoinIn], { account: funding.account }));

    assert.equal(await token.read.balanceOf([funding.account.address]), 0n);
    assert.equal(await stablecoin.read.balanceOf([funding.account.address]), fundingBalanceBefore);
  });

  it("ceil-rounds split distributing mint premiums without underfunding aggregate accrued income", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    const amount = conditions.minTicket;
    const elapsed = DAY;
    const expectedAggregatePremium = expectedIncome(2n * amount, elapsed);

    await stablecoin.write.mint([investor.account.address, 1_000_000_000n], { account: investor.account });
    await stablecoin.write.approve([token.address, 1_000_000_000n], { account: investor.account });
    await stablecoin.write.mint([bob.account.address, 1_000_000_000n], { account: bob.account });
    await stablecoin.write.approve([token.address, 1_000_000_000n], { account: bob.account });
    await setNextBlockTime(startedAt + elapsed);
    const fundingBefore = await stablecoin.read.balanceOf([funding.account.address]);
    await publicClient.request({ method: "evm_setAutomine", params: [false] });
    await token.write.mintInvestment([amount, 1_000_000_000n], { account: investor.account });
    await token.write.mintInvestment([amount, 1_000_000_000n], { account: bob.account });
    await publicClient.request({ method: "evm_mine", params: [] });
    await publicClient.request({ method: "evm_setAutomine", params: [true] });
    const collectedPremium =
      (await stablecoin.read.balanceOf([funding.account.address])) - fundingBefore - 200n * STABLECOIN_SCALE;

    assert.ok(collectedPremium >= expectedAggregatePremium);
  });

  it("supports equal high-decimal token and stablecoin accrual without overflow", async function () {
    const highScale = 10n ** 51n;
    const highDecimalConditions = { ...conditions, minTicket: 100n * highScale };
    const { token } = await deployPrivateCreditSuite(
      viem,
      [owner, agent, issuer, funding],
      highDecimalConditions,
      51,
      51,
    );
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    const elapsed = 30n * DAY;
    const amount = highDecimalConditions.minTicket;
    const expectedIndex = (BigInt(conditions.apyBps) * elapsed * INDEX_SCALE) / (YEAR * 10_000n);
    const expectedPremium = expectedMintPremium(amount, elapsed, 51, 51);

    await increaseTo(startedAt + elapsed);
    assert.equal(await token.read.accumulatedIncomePerToken(), expectedIndex);
    assert.equal(await token.read.mintPrice([amount]), amount + expectedPremium);
  });

  it("rejects inherited agent minting while preserving the funded investment path", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });

    await assert.rejects(() =>
      token.write.mint([investor.account.address, conditions.minTicket], { account: agent.account }),
    );
    await assert.rejects(() =>
      token.write.batchMint([[investor.account.address], [conditions.minTicket]], { account: agent.account }),
    );
    await assert.rejects(() => token.write.batchMint([[], []], { account: agent.account }));
    await mintInvestment(token, conditions.minTicket);
    assert.equal(await token.read.balanceOf([investor.account.address]), conditions.minTicket);
  });

  it("rejects self-mints that are unverified, denied by compliance, paused, zero, or above the slippage cap", async function () {
    const compliance = await viem.deployContract("MockCompliance");
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(
      viem,
      [owner, agent, issuer, funding],
      conditions,
      18,
      6,
      true,
      compliance,
    );
    await token.write.start({ account: owner.account });
    const amount = conditions.minTicket;
    const price = await token.read.mintPrice([amount]);
    await stablecoin.write.mint([investor.account.address, price + 1_000_000n], { account: investor.account });
    await stablecoin.write.approve([token.address, price + 1_000_000n], { account: investor.account });
    await assert.rejects(() => token.write.mintInvestment([amount, price + 1_000_000n], { account: investor.account }));

    await registerVerifiedInvestor(identityRegistry);
    await compliance.write.setAllowTransfers([false], { account: owner.account });
    await assert.rejects(() => token.write.mintInvestment([amount, price + 1_000_000n], { account: investor.account }));
    await compliance.write.setAllowTransfers([true], { account: owner.account });
    await token.write.pause({ account: agent.account });
    await assert.rejects(() => token.write.mintInvestment([amount, price + 1_000_000n], { account: investor.account }));
    await token.write.unpause({ account: agent.account });
    await assert.rejects(() => token.write.mintInvestment([0n, 0n], { account: investor.account }));
    await assert.rejects(() => token.write.mintInvestment([amount, 0n], { account: investor.account }));
    assert.equal(await token.read.balanceOf([investor.account.address]), 0n);
  });

  it("keeps investment mint authorization unavailable after successful and failed self-mints", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const amount = conditions.minTicket;
    const price = await token.read.mintPrice([amount]);
    await stablecoin.write.mint([investor.account.address, price], { account: investor.account });
    await assert.rejects(() => token.write.mintInvestment([amount, price], { account: investor.account }));
    await assert.rejects(() => token.write.mint([investor.account.address, amount], { account: agent.account }));
    await mintInvestment(token, amount);
    await assert.rejects(() => token.write.mint([investor.account.address, amount], { account: agent.account }));
  });

  it("self-mints exactly representable principal when token decimals exceed stablecoin decimals", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const amount = conditions.minTicket;
    const fundingBefore = await stablecoin.read.balanceOf([funding.account.address]);
    const stablecoinIn = await mintInvestment(token, amount);
    assert.ok(stablecoinIn >= 100n * STABLECOIN_SCALE + 1n);
    assert.equal(await stablecoin.read.balanceOf([funding.account.address]), fundingBefore + stablecoinIn);
    await assert.rejects(() => mintInvestment(token, amount + 1n));
  });

  it("quotes distributing mints at principal plus undistributed income and resets after distribution", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    const amount = 100n * TOKEN_SCALE;
    assert.equal(await token.read.mintPrice([amount]), 100n * STABLECOIN_SCALE);

    const elapsed = 30n * DAY;
    const dirtyPrice = 100n * STABLECOIN_SCALE + expectedMintPremium(amount, elapsed);
    await stablecoin.write.mint([investor.account.address, dirtyPrice], { account: investor.account });
    await stablecoin.write.approve([token.address, dirtyPrice], { account: investor.account });
    await setNextBlockTime(startedAt + elapsed);
    const fundingBefore = await stablecoin.read.balanceOf([funding.account.address]);
    await token.write.mintInvestment([amount, dirtyPrice], { account: investor.account });
    assert.equal(await token.read.balanceOf([investor.account.address]), amount);
    assert.equal(await stablecoin.read.balanceOf([funding.account.address]), fundingBefore + dirtyPrice);
    assert.equal(await token.read.mintPrice([amount]), dirtyPrice);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.distributeIncome({ account: owner.account });
    assert.equal(await token.read.mintPrice([amount]), 100n * STABLECOIN_SCALE);
  });

  it("accretes mint price through maturity and disables distribution", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(
      viem,
      [owner, agent, issuer, funding],
      accretingConditions,
    );
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    const amount = 100n * TOKEN_SCALE;
    await increaseTo(startedAt + 30n * DAY);
    assert.equal(
      await token.read.mintPrice([amount]),
      100n * STABLECOIN_SCALE + expectedMintPremium(amount, 30n * DAY),
    );
    await assert.rejects(() => token.write.distributeIncome({ account: owner.account }));
    await increaseTo(startedAt + accretingConditions.duration + DAY);
    assert.equal(
      await token.read.accumulatedIncomePerToken(),
      (expectedIncome(amount, accretingConditions.duration) * INDEX_SCALE) / amount,
    );
    await assert.rejects(() => token.read.mintPrice([amount]));
  });

  it("self-mints, transfers, and settles accreting units at independently calculated embedded values", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(
      viem,
      [owner, agent, issuer, funding],
      accretingConditions,
    );
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    const amount = 200n * TOKEN_SCALE;
    const transferAmount = 100n * TOKEN_SCALE;
    const mintElapsed = 10n * DAY;
    const mintPrice = 200n * STABLECOIN_SCALE + expectedMintPremium(amount, mintElapsed);
    await stablecoin.write.mint([investor.account.address, mintPrice], { account: investor.account });
    await stablecoin.write.approve([token.address, mintPrice], { account: investor.account });
    await setNextBlockTime(startedAt + mintElapsed);
    await token.write.mintInvestment([amount, mintPrice], { account: investor.account });
    assert.equal(await token.read.balanceOf([investor.account.address]), amount);

    const acquisitionTime = await token.read.acquisitionTimestamp([investor.account.address]);
    await increaseTo(acquisitionTime + conditions.minPeriod);
    await token.write.transfer([bob.account.address, transferAmount], { account: investor.account });
    await token.write.requestWithdrawal([100n * TOKEN_SCALE], { account: investor.account });
    const partialSettlementTime = (await publicClient.getBlock()).timestamp + conditions.lockup;
    await fund(stablecoin, token, 1_000_000_000n);
    await setNextBlockTime(partialSettlementTime);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    const partialClaim = await token.read.claimableIncome([investor.account.address]);
    const expectedPartialClaim =
      100n * STABLECOIN_SCALE + expectedIncome(transferAmount, partialSettlementTime - startedAt);
    assert.equal(partialClaim, expectedPartialClaim);
    assert.equal(
      await token.read.totalAccumulatedIncome(),
      expectedIncome(transferAmount, partialSettlementTime - startedAt),
    );
    const investorBeforeClaim = await stablecoin.read.balanceOf([investor.account.address]);
    await token.write.claimIncome({ account: investor.account });
    assert.equal(
      await stablecoin.read.balanceOf([investor.account.address]),
      investorBeforeClaim + expectedPartialClaim,
    );

    const maturity = await token.read.maturity();
    await fund(stablecoin, token, 1_000_000_000n);
    await setNextBlockTime(maturity);
    await token.write.settleWithdrawals([[investor.account.address, bob.account.address]], { account: owner.account });
    const expectedMaturityClaim = 100n * STABLECOIN_SCALE + expectedIncome(transferAmount, conditions.duration);
    assert.equal(await token.read.claimableIncome([investor.account.address]), 0n);
    assert.equal(await token.read.claimableIncome([bob.account.address]), expectedMaturityClaim);
    const bobBeforeClaim = await stablecoin.read.balanceOf([bob.account.address]);
    await token.write.claimIncome({ account: bob.account });
    assert.equal(await stablecoin.read.balanceOf([bob.account.address]), bobBeforeClaim + expectedMaturityClaim);
    assert.equal(await token.read.totalAccumulatedIncome(), 0n);
  });

  it("rejects invalid private-credit initialization", async function () {
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    const { contract: claimTopics } = await deployUpgradeable(viem, "ClaimTopicsRegistry");
    await claimTopics.write.initialize([owner.account.address, [1n]], { account: owner.account });
    const { contract: trustedIssuers } = await deployUpgradeable(viem, "TrustedIssuersRegistry");
    await trustedIssuers.write.initialize([owner.account.address, [claimIssuer.address], [[1n]]], {
      account: owner.account,
    });
    const { contract: storage } = await deployUpgradeable(viem, "IdentityRegistryStorage");
    await storage.write.initialize([owner.account.address, owner.account.address], { account: owner.account });
    const { contract: identityRegistry } = await deployUpgradeable(viem, "IdentityRegistry");
    await identityRegistry.write.initialize(
      [
        owner.account.address,
        storage.address,
        claimTopics.address,
        trustedIssuers.address,
        [agent.account.address],
        owner.account.address,
      ],
      { account: owner.account },
    );
    const { contract: compliance } = await deployUpgradeable(viem, "Compliance");
    await compliance.write.initialize([owner.account.address, owner.account.address], { account: owner.account });
    const tokenImpl = await viem.deployContract("PrivateCreditToken");
    const tokenProxy = await viem.deployContract("TestERC1967Proxy", [tokenImpl.address, "0x"]);
    const token = await viem.getContractAt("PrivateCreditToken", tokenProxy.address);

    await assert.rejects(() =>
      token.write.initialize(
        [
          "UFarm Private Credit",
          "UFPC",
          18,
          "1",
          owner.account.address,
          identityRegistry.address,
          compliance.address,
          [agent.account.address],
          ZERO_ADDRESS,
          funding.account.address,
          conditions,
          NO_ORACLE,
        ],
        { account: owner.account },
      ),
    );
  });

  it("rejects initialization when token and stablecoin decimals differ by more than eighteen", async function () {
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    const { contract: claimTopics } = await deployUpgradeable(viem, "ClaimTopicsRegistry");
    await claimTopics.write.initialize([owner.account.address, [1n]], { account: owner.account });
    const { contract: trustedIssuers } = await deployUpgradeable(viem, "TrustedIssuersRegistry");
    await trustedIssuers.write.initialize([owner.account.address, [claimIssuer.address], [[1n]]], {
      account: owner.account,
    });
    const { contract: storage } = await deployUpgradeable(viem, "IdentityRegistryStorage");
    await storage.write.initialize([owner.account.address, owner.account.address], { account: owner.account });
    const { contract: identityRegistry } = await deployUpgradeable(viem, "IdentityRegistry");
    await identityRegistry.write.initialize(
      [
        owner.account.address,
        storage.address,
        claimTopics.address,
        trustedIssuers.address,
        [agent.account.address],
        owner.account.address,
      ],
      { account: owner.account },
    );
    const { contract: compliance } = await deployUpgradeable(viem, "Compliance");
    await compliance.write.initialize([owner.account.address, owner.account.address], { account: owner.account });
    const stablecoin = await viem.deployContract("MockERC20", ["High Decimal USD", "HDUSD", 37]);
    const tokenImpl = await viem.deployContract("PrivateCreditToken");
    const tokenProxy = await viem.deployContract("TestERC1967Proxy", [tokenImpl.address, "0x"]);
    const token = await viem.getContractAt("PrivateCreditToken", tokenProxy.address);

    await assert.rejects(() =>
      token.write.initialize(
        [
          "UFarm Private Credit",
          "UFPC",
          18,
          "1",
          owner.account.address,
          identityRegistry.address,
          compliance.address,
          [agent.account.address],
          stablecoin.address,
          funding.account.address,
          conditions,
          NO_ORACLE,
        ],
        { account: owner.account },
      ),
    );
  });

  it("rejects the inherited initializer without blocking private-credit initialization", async function () {
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    const { contract: claimTopics } = await deployUpgradeable(viem, "ClaimTopicsRegistry");
    await claimTopics.write.initialize([owner.account.address, [1n]], { account: owner.account });
    const { contract: trustedIssuers } = await deployUpgradeable(viem, "TrustedIssuersRegistry");
    await trustedIssuers.write.initialize([owner.account.address, [claimIssuer.address], [[1n]]], {
      account: owner.account,
    });
    const { contract: storage } = await deployUpgradeable(viem, "IdentityRegistryStorage");
    await storage.write.initialize([owner.account.address, owner.account.address], { account: owner.account });
    const { contract: identityRegistry } = await deployUpgradeable(viem, "IdentityRegistry");
    await identityRegistry.write.initialize(
      [
        owner.account.address,
        storage.address,
        claimTopics.address,
        trustedIssuers.address,
        [agent.account.address],
        owner.account.address,
      ],
      { account: owner.account },
    );
    const { contract: compliance } = await deployUpgradeable(viem, "Compliance");
    await compliance.write.initialize([owner.account.address, owner.account.address], { account: owner.account });
    const stablecoin = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const tokenImpl = await viem.deployContract("PrivateCreditToken");
    const tokenProxy = await viem.deployContract("TestERC1967Proxy", [tokenImpl.address, "0x"]);
    const baseToken = await viem.getContractAt("ERC3643Token", tokenProxy.address);
    const token = await viem.getContractAt("PrivateCreditToken", tokenProxy.address);

    await assert.rejects(() =>
      baseToken.write.initialize(
        [
          "UFarm Private Credit",
          "UFPC",
          18,
          "1",
          owner.account.address,
          identityRegistry.address,
          compliance.address,
          [agent.account.address],
        ],
        { account: owner.account },
      ),
    );

    await token.write.initialize(
      [
        "UFarm Private Credit",
        "UFPC",
        18,
        "1",
        owner.account.address,
        identityRegistry.address,
        compliance.address,
        [agent.account.address],
        stablecoin.address,
        funding.account.address,
        conditions,
        NO_ORACLE,
      ],
      { account: owner.account },
    );
    assert.equal((await token.read.stablecoin()).toLowerCase(), stablecoin.address.toLowerCase());
  });

  it("starts once and exposes maturity and minting cutoff", async function () {
    const { token } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    const beforeStart = (await publicClient.getBlock()).timestamp;

    await token.write.start({ account: owner.account });

    const startTime = await token.read.startTime();
    assert.ok(startTime >= beforeStart);
    assert.equal(await token.read.maturity(), startTime + conditions.duration);
    assert.equal(await token.read.mintingCutoff(), startTime + conditions.duration - conditions.minPeriod);
    assert.equal(await token.read.lastDistributionTime(), startTime);
    await assert.rejects(() => token.write.start({ account: owner.account }));
  });

  it("restricts funding-address updates to the owner", async function () {
    const { token } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);

    await assert.rejects(() =>
      token.write.setFundingAddress([outsider.account.address], { account: outsider.account }),
    );
    await token.write.setFundingAddress([outsider.account.address], { account: owner.account });
    assert.equal((await token.read.fundingAddress()).toLowerCase(), outsider.account.address.toLowerCase());
  });

  it("reports continuously accumulated income and caps it at maturity", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 100n * TOKEN_SCALE);

    await increaseTo(startedAt + 30n * DAY);
    assert.equal(await token.read.totalAccumulatedIncome(), expectedIncome(100n * TOKEN_SCALE, 30n * DAY));
    assert.equal(
      await token.read.accumulatedIncomeOf([investor.account.address]),
      expectedIncome(100n * TOKEN_SCALE, 30n * DAY),
    );

    await increaseTo(startedAt + conditions.duration + DAY);
    assert.equal(await token.read.totalAccumulatedIncome(), expectedIncome(100n * TOKEN_SCALE, conditions.duration));
  });

  it("rejects a mint that cannot be represented in stablecoin principal units", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });

    await assert.rejects(() => mintInvestment(token, conditions.minTicket + 1n));
  });

  it("rejects nonrepresentable transfers while allowing representable forced transfers and recovery", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 200n * TOKEN_SCALE);

    await assert.rejects(() => token.write.transfer([bob.account.address, 1n], { account: investor.account }));
    await assert.rejects(() =>
      token.write.forcedTransfer([investor.account.address, bob.account.address, 1n], { account: agent.account }),
    );

    await token.write.forcedTransfer([investor.account.address, bob.account.address, 100n * TOKEN_SCALE], {
      account: agent.account,
    });
    await token.write.recoveryAddress([bob.account.address, outsider.account.address], { account: agent.account });
    assert.equal(await token.read.balanceOf([investor.account.address]), 100n * TOKEN_SCALE);
    assert.equal(await token.read.balanceOf([outsider.account.address]), 100n * TOKEN_SCALE);
  });

  it("enforces monthly cadence and pulls the calculated stablecoin amount", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 100n * TOKEN_SCALE);
    const amount = expectedIncome(100n * TOKEN_SCALE, 30n * DAY);
    await fund(stablecoin, token, amount);

    await setNextBlockTime(startedAt + 30n * DAY);
    await assert.rejects(() => token.write.distributeIncome({ account: outsider.account }));
    await token.write.distributeIncome({ account: owner.account });
    assert.equal(await stablecoin.read.balanceOf([token.address]), amount);
    assert.equal(await token.read.claimableIncome([investor.account.address]), amount);
    assert.equal(await token.read.lastDistributionTime(), startedAt + 30n * DAY);
  });

  it("allows on-demand income distributions without a fixed cadence", async function () {
    const onDemandConditions = { ...conditions, distributionTerms: 5 };
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(
      viem,
      [owner, agent, issuer, funding],
      onDemandConditions,
    );
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 100n * TOKEN_SCALE);

    await fund(stablecoin, token, expectedIncome(100n * TOKEN_SCALE, DAY));
    await setNextBlockTime(startedAt + DAY);
    await token.write.distributeIncome({ account: owner.account });

    const hour = 60n * 60n;
    await fund(stablecoin, token, expectedIncome(100n * TOKEN_SCALE, hour) + 1n);
    await setNextBlockTime(startedAt + DAY + hour);
    await token.write.distributeIncome({ account: owner.account });

    assert.equal(await token.read.lastDistributionTime(), startedAt + DAY + hour);
  });

  it("keeps undistributed income with tokens across partial transfers", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 100n * TOKEN_SCALE);
    await setNextBlockTime(startedAt + 30n * DAY);
    await token.write.transfer([bob.account.address, 60n * TOKEN_SCALE], { account: investor.account });

    const income = expectedIncome(100n * TOKEN_SCALE, 30n * DAY);
    assert.equal(await token.read.accumulatedIncomeOf([investor.account.address]), (income * 40n) / 100n);
    assert.equal(await token.read.accumulatedIncomeOf([bob.account.address]), (income * 60n) / 100n);
  });

  it("allows zero-value transfers to an empty verified wallet", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, conditions.minTicket);

    await token.write.transfer([bob.account.address, 0n], { account: investor.account });

    assert.equal(await token.read.balanceOf([bob.account.address]), 0n);
    assert.equal(await token.read.acquisitionTimestamp([bob.account.address]), 0n);
  });

  it("checkpoints distributed income before partial transfers", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 100n * TOKEN_SCALE);
    const period = expectedIncome(100n * TOKEN_SCALE, 30n * DAY);
    await fund(stablecoin, token, period * 2n);
    await setNextBlockTime(startedAt + 30n * DAY);
    await token.write.distributeIncome({ account: owner.account });
    await token.write.transfer([bob.account.address, 60n * TOKEN_SCALE], { account: investor.account });
    assert.equal(await token.read.claimableIncome([investor.account.address]), period);

    await setNextBlockTime(startedAt + 60n * DAY);
    await token.write.distributeIncome({ account: owner.account });
    assert.equal(await token.read.claimableIncome([investor.account.address]), period + (period * 40n) / 100n);
    assert.equal(await token.read.claimableIncome([bob.account.address]), (period * 60n) / 100n);
  });

  it("allows a former holder to claim after transferring every token", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 100n * TOKEN_SCALE);
    const income = expectedIncome(100n * TOKEN_SCALE, 30n * DAY);
    await fund(stablecoin, token, income);
    await setNextBlockTime(startedAt + 30n * DAY);
    await token.write.distributeIncome({ account: owner.account });
    await token.write.transfer([bob.account.address, 100n * TOKEN_SCALE], { account: investor.account });
    await token.write.claimIncome({ account: investor.account });
    assert.equal(await stablecoin.read.balanceOf([investor.account.address]), income);
  });

  it("pays bounded holder batches without enumerating holders", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 100n * TOKEN_SCALE);
    await mintInvestment(token, 100n * TOKEN_SCALE, bob);
    const income = expectedIncome(200n * TOKEN_SCALE, 30n * DAY);
    await fund(stablecoin, token, income);
    await setNextBlockTime(startedAt + 30n * DAY);
    await token.write.distributeIncome({ account: owner.account });
    await assert.rejects(() => token.write.distributeIncomeTo([[]], { account: outsider.account }));
    await assert.rejects(() =>
      token.write.distributeIncomeTo([[investor.account.address]], { account: outsider.account }),
    );
    await token.write.distributeIncomeTo([[investor.account.address]], { account: owner.account });
    assert.equal(await stablecoin.read.balanceOf([investor.account.address]), income / 2n);
    assert.equal(await stablecoin.read.balanceOf([bob.account.address]), 0n);
  });

  it("tracks weighted acquisition time across mints and partial transfers", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 100n * TOKEN_SCALE);
    const firstAcquisitionTime = await token.read.acquisitionTimestamp([investor.account.address]);
    await setNextBlockTime(startedAt + 10n * DAY);
    await mintInvestment(token, 100n * TOKEN_SCALE);
    const secondAcquisitionTime = await token.read.acquisitionTimestamp([investor.account.address]);
    assert.ok(secondAcquisitionTime > firstAcquisitionTime);
    assert.ok(secondAcquisitionTime < startedAt + 10n * DAY);
    await token.write.transfer([bob.account.address, 50n * TOKEN_SCALE], { account: investor.account });
    assert.equal(await token.read.acquisitionTimestamp([investor.account.address]), secondAcquisitionTime);
    assert.equal(await token.read.acquisitionTimestamp([bob.account.address]), secondAcquisitionTime);
  });

  it("reverts distribution when funding allowance or balance is insufficient", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 100n * TOKEN_SCALE);
    const investmentProceeds = await stablecoin.read.balanceOf([funding.account.address]);
    await stablecoin.write.transfer([outsider.account.address, investmentProceeds], { account: funding.account });
    const amount = expectedIncome(100n * TOKEN_SCALE, 30n * DAY);
    await setNextBlockTime(startedAt + 30n * DAY);
    await assert.rejects(() => token.write.distributeIncome({ account: owner.account }));
    await stablecoin.write.approve([token.address, amount], { account: funding.account });
    await assert.rejects(() => token.write.distributeIncome({ account: owner.account }));
    await stablecoin.write.mint([funding.account.address, amount], { account: funding.account });
    await stablecoin.write.approve([token.address, amount - 1n], { account: funding.account });
    await assert.rejects(() => token.write.distributeIncome({ account: owner.account }));
  });

  it("funds cumulative scaled income rounding across fractional periods", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 100n * TOKEN_SCALE);
    const totalIncome = expectedIncome(100n * TOKEN_SCALE, 90n * DAY);
    await fund(stablecoin, token, totalIncome);

    for (const days of [30n, 60n, 90n]) {
      await setNextBlockTime(startedAt + days * DAY);
      await token.write.distributeIncome({ account: owner.account });
    }

    assert.equal(await stablecoin.read.balanceOf([token.address]), totalIncome);
    await token.write.claimIncome({ account: investor.account });
    assert.equal(await stablecoin.read.balanceOf([investor.account.address]), totalIncome);
    assert.equal(await stablecoin.read.balanceOf([token.address]), 0n);
  });

  it("reports aggregate accumulated income equal to holder entitlements after a post-distribution mint", async function () {
    const exactIncomeConditions = { ...conditions, apyBps: 365 };
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(
      viem,
      [owner, agent, issuer, funding],
      exactIncomeConditions,
    );
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, conditions.minTicket);
    await fund(stablecoin, token, 300_000n);
    await setNextBlockTime(startedAt + conditions.minPeriod);
    await token.write.distributeIncome({ account: owner.account });
    await mintInvestment(token, conditions.minTicket, bob);

    const entitlementBeforeClaims =
      (await token.read.accumulatedIncomeOf([investor.account.address])) +
      (await token.read.accumulatedIncomeOf([bob.account.address]));
    const aggregateBeforeClaims = await token.read.totalAccumulatedIncome();
    assert.ok(aggregateBeforeClaims >= entitlementBeforeClaims);
    assert.ok(aggregateBeforeClaims - entitlementBeforeClaims <= 1n);

    await token.write.claimIncome({ account: investor.account });
    const entitlementAfterClaim =
      (await token.read.accumulatedIncomeOf([investor.account.address])) +
      (await token.read.accumulatedIncomeOf([bob.account.address]));
    const aggregateAfterClaim = await token.read.totalAccumulatedIncome();
    assert.ok(aggregateAfterClaim >= entitlementAfterClaim);
    assert.ok(aggregateAfterClaim - entitlementAfterClaim <= 1n);
  });

  it("only distributes AtMaturity income at maturity for long debt", async function () {
    const longDebtConditions = {
      ...conditions,
      duration: 2n * YEAR,
      distributionTerms: 4,
    };
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(
      viem,
      [owner, agent, issuer, funding],
      longDebtConditions,
    );
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 100n * TOKEN_SCALE);
    const totalIncome = expectedIncome(100n * TOKEN_SCALE, longDebtConditions.duration);
    await fund(stablecoin, token, totalIncome);

    await setNextBlockTime(startedAt + YEAR);
    await assert.rejects(() => token.write.distributeIncome({ account: owner.account }));
    await setNextBlockTime(startedAt + longDebtConditions.duration);
    await token.write.distributeIncome({ account: owner.account });
    assert.equal(await stablecoin.read.balanceOf([token.address]), totalIncome);
  });

  it("enforces activation, minimum ticket, and minting cutoff", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);

    await assert.rejects(() => mintInvestment(token, conditions.minTicket));

    await token.write.start({ account: owner.account });

    await assert.rejects(() => mintInvestment(token, conditions.minTicket - 1n));
    await mintInvestment(token, conditions.minTicket);
    assert.equal(await token.read.balanceOf([investor.account.address]), conditions.minTicket);

    const cutoff = await token.read.mintingCutoff();
    await stablecoin.write.mint([investor.account.address, 1_000_000_000n], { account: investor.account });
    await stablecoin.write.approve([token.address, 1_000_000_000n], { account: investor.account });
    await setNextBlockTime(cutoff);
    await token.write.mintInvestment([conditions.minTicket, 1_000_000_000n], { account: investor.account });
    assert.equal(await token.read.balanceOf([investor.account.address]), 2n * conditions.minTicket);

    await increaseTo(cutoff + 1n);

    await assert.rejects(() => mintInvestment(token, conditions.minTicket));
  });

  it("requires the weighted minimum period before withdrawal requests", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, conditions.minTicket);
    await assert.rejects(() => token.write.requestWithdrawal([conditions.minTicket], { account: investor.account }));
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([conditions.minTicket], { account: investor.account });
  });

  it("rejects withdrawal reservations from a fully frozen holder", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, conditions.minTicket);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.setAddressFrozen([investor.account.address, true], { account: agent.account });

    await assert.rejects(
      () => token.write.requestWithdrawal([conditions.minTicket], { account: investor.account }),
      /AddressFrozenError/,
    );
  });

  it("rejects cumulative reservations above the unfrozen balance", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 300n * TOKEN_SCALE);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.freezePartialTokens([investor.account.address, 100n * TOKEN_SCALE], {
      account: agent.account,
    });
    await token.write.requestWithdrawal([50n * TOKEN_SCALE], { account: investor.account });

    await assert.rejects(
      () => token.write.requestWithdrawal([151n * TOKEN_SCALE], { account: investor.account }),
      /PartialFreezeExceeded/,
    );
    await token.write.requestWithdrawal([150n * TOKEN_SCALE], { account: investor.account });
    assert.equal(await token.read.reservedWithdrawal([investor.account.address]), 200n * TOKEN_SCALE);
  });

  it("rejects a freeze that overlaps a withdrawal reservation", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 200n * TOKEN_SCALE);
    const acquiredAt = await token.read.acquisitionTimestamp([investor.account.address]);
    await increaseTo(acquiredAt + conditions.minPeriod);
    await token.write.requestWithdrawal([100n * TOKEN_SCALE], { account: investor.account });
    await assert.rejects(
      () =>
        token.write.freezePartialTokens([investor.account.address, 150n * TOKEN_SCALE], {
          account: agent.account,
        }),
      /PartialFreezeExceeded/,
    );
    await token.write.freezePartialTokens([investor.account.address, 100n * TOKEN_SCALE], { account: agent.account });
    await increaseTo(acquiredAt + conditions.minPeriod + conditions.lockup + DAY);
    await fund(stablecoin, token, 1_000_000_000n);

    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
  });

  it("keeps reserved and frozen balances disjoint during transfers", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 300n * TOKEN_SCALE);
    const acquiredAt = await token.read.acquisitionTimestamp([investor.account.address]);
    await increaseTo(acquiredAt + conditions.minPeriod);
    await token.write.freezePartialTokens([investor.account.address, 50n * TOKEN_SCALE], { account: agent.account });
    await token.write.requestWithdrawal([100n * TOKEN_SCALE], { account: investor.account });
    await assert.rejects(
      () => token.write.transfer([bob.account.address, 151n * TOKEN_SCALE], { account: investor.account }),
      /ReservedBalanceExceeded/,
    );
    await token.write.transfer([bob.account.address, 150n * TOKEN_SCALE], { account: investor.account });
    await increaseTo(acquiredAt + conditions.minPeriod + conditions.lockup + DAY);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    assert.equal(await token.read.balanceOf([investor.account.address]), 50n * TOKEN_SCALE);
  });

  it("settles the unfrozen portion at maturity", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 200n * TOKEN_SCALE);
    await token.write.freezePartialTokens([investor.account.address, 50n * TOKEN_SCALE + 1n], {
      account: agent.account,
    });
    await increaseTo(await token.read.maturity());
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    assert.equal(await token.read.balanceOf([investor.account.address]), 50n * TOKEN_SCALE + 10n ** 12n);
  });

  it("atomically reserves the current full unreserved balance after an inbound dust transfer", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, conditions.minTicket);
    await mintInvestment(token, conditions.minTicket, bob);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);

    const representableDust = TOKEN_SCALE / STABLECOIN_SCALE;
    const beforeDust = await token.read.balanceOf([investor.account.address]);
    await token.write.transfer([investor.account.address, representableDust], { account: bob.account });

    await token.write.requestFullWithdrawal({ account: investor.account });

    assert.equal(await token.read.reservedWithdrawal([investor.account.address]), beforeDust + representableDust);
  });

  it("extends an existing reservation by exactly the current unreserved balance", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 200n * TOKEN_SCALE);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);

    await token.write.requestWithdrawal([100n * TOKEN_SCALE], { account: investor.account });
    const unreserved =
      (await token.read.balanceOf([investor.account.address])) -
      (await token.read.reservedWithdrawal([investor.account.address]));

    await token.write.requestFullWithdrawal({ account: investor.account });

    assert.equal(await token.read.reservedWithdrawal([investor.account.address]), 100n * TOKEN_SCALE + unreserved);
  });

  it("rejects a full withdrawal request when no unreserved balance remains", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, conditions.minTicket);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);

    await token.write.requestFullWithdrawal({ account: investor.account });
    await assert.rejects(() => token.write.requestFullWithdrawal({ account: investor.account }), /ZeroAmount/);
  });

  it("enforces the minimum remaining ticket while allowing any withdrawal size", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 150n * TOKEN_SCALE);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([25n * TOKEN_SCALE], { account: investor.account });
    await assert.rejects(() => token.write.requestWithdrawal([50n * TOKEN_SCALE], { account: investor.account }));
    await token.write.requestWithdrawal([125n * TOKEN_SCALE], { account: investor.account });
    assert.equal(await token.read.reservedWithdrawal([investor.account.address]), 150n * TOKEN_SCALE);
  });

  it("reserves the full unreserved balance, emits its delta, and resets lockup", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 200n * TOKEN_SCALE);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([100n * TOKEN_SCALE], { account: investor.account });
    await increaseTo(
      (await token.read.acquisitionTimestamp([investor.account.address])) +
        conditions.minPeriod +
        conditions.lockup +
        DAY,
    );
    const unreserved =
      (await token.read.balanceOf([investor.account.address])) -
      (await token.read.reservedWithdrawal([investor.account.address]));
    const hash = await token.write.requestFullWithdrawal({ account: investor.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const events = await publicClient.getContractEvents({
      address: token.address,
      abi: token.abi,
      eventName: "WithdrawalRequested",
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
      strict: true,
    });

    assert.equal(events[0]?.args.amount, unreserved);
    await assert.rejects(() => token.write.settleWithdrawals([[investor.account.address]], { account: owner.account }));
    assert.equal(await token.read.reservedWithdrawal([investor.account.address]), 200n * TOKEN_SCALE);
  });

  it("prevents transfers and direct burns of reserved tokens", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 200n * TOKEN_SCALE);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([100n * TOKEN_SCALE], { account: investor.account });
    await assert.rejects(() =>
      token.write.transfer([bob.account.address, 101n * TOKEN_SCALE], { account: investor.account }),
    );
    await assert.rejects(() => token.write.burn([investor.account.address, 1n], { account: agent.account }));
  });

  it("continues accruing requested tokens through lockup", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, conditions.minTicket);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([conditions.minTicket], { account: investor.account });
    await increaseTo(
      (await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod + conditions.lockup,
    );
    const accruedIncome = await token.read.accumulatedIncomeOf([investor.account.address]);
    const expectedAccruedIncome = expectedIncome(conditions.minTicket, conditions.minPeriod + conditions.lockup);
    assert.ok(accruedIncome >= expectedAccruedIncome);
    assert.ok(accruedIncome - expectedAccruedIncome <= 1n);
  });

  it("reports total holder value across active and settled positions", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 2n * conditions.minTicket);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.distributeIncome({ account: owner.account });

    const principalUnit = TOKEN_SCALE / STABLECOIN_SCALE;
    assert.equal(
      await token.read.totalValueOf([investor.account.address]),
      (await token.read.balanceOf([investor.account.address])) / principalUnit +
        (await token.read.accumulatedIncomeOf([investor.account.address])),
    );

    await token.write.requestWithdrawal([conditions.minTicket], { account: investor.account });
    await increaseTo((await publicClient.getBlock()).timestamp + conditions.lockup);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    assert.equal(
      await token.read.totalValueOf([investor.account.address]),
      (await token.read.balanceOf([investor.account.address])) / principalUnit +
        (await token.read.accumulatedIncomeOf([investor.account.address])) +
        (await token.read.claimableIncome([investor.account.address])),
    );

    await increaseTo(startedAt + conditions.duration);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    assert.equal(await token.read.balanceOf([investor.account.address]), 0n);
    assert.equal(
      await token.read.totalValueOf([investor.account.address]),
      await token.read.claimableIncome([investor.account.address]),
    );
  });

  it("settles only requested lenders principal plus all earned income", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, conditions.minTicket);
    await mintInvestment(token, conditions.minTicket, bob);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await fund(stablecoin, token, expectedIncome(2n * conditions.minTicket, conditions.minPeriod) + 10n);
    await token.write.distributeIncome({ account: owner.account });
    const crystallized = await token.read.claimableIncome([investor.account.address]);
    await token.write.requestWithdrawal([conditions.minTicket], { account: investor.account });
    await increaseTo(
      (await token.read.acquisitionTimestamp([investor.account.address])) +
        conditions.minPeriod +
        conditions.lockup +
        DAY,
    );
    const currentIncome = (await token.read.accumulatedIncomeOf([investor.account.address])) - crystallized;
    const newlyDue = 100n * STABLECOIN_SCALE + currentIncome;
    await fund(stablecoin, token, newlyDue + 1n);
    const fundingBalanceBefore = await stablecoin.read.balanceOf([funding.account.address]);
    const holderBalanceBefore = await stablecoin.read.balanceOf([investor.account.address]);
    const contractBalanceBefore = await stablecoin.read.balanceOf([token.address]);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    const fundingDelta = fundingBalanceBefore - (await stablecoin.read.balanceOf([funding.account.address]));
    assert.equal(await stablecoin.read.balanceOf([investor.account.address]), holderBalanceBefore);
    assert.ok(fundingDelta >= newlyDue && fundingDelta <= newlyDue + 1n);
    assert.equal(await stablecoin.read.balanceOf([token.address]), contractBalanceBefore + fundingDelta);
    assert.equal(await token.read.claimableIncome([investor.account.address]), crystallized + fundingDelta);
    await token.write.claimIncome({ account: investor.account });
    assert.equal(
      await stablecoin.read.balanceOf([investor.account.address]),
      holderBalanceBefore + crystallized + fundingDelta,
    );
    assert.equal(await token.read.claimableIncome([investor.account.address]), 0n);
    assert.equal(await stablecoin.read.balanceOf([bob.account.address]), 0n);
    assert.equal(await token.read.balanceOf([bob.account.address]), conditions.minTicket);
    assert.equal(await token.read.claimableIncome([bob.account.address]), crystallized);
  });

  it("quotes the stablecoin funding required for withdrawal settlement", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 2n * conditions.minTicket);
    await mintInvestment(token, conditions.minTicket, bob);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([conditions.minTicket], { account: investor.account });
    await increaseTo((await publicClient.getBlock()).timestamp + conditions.lockup);

    const holders = [investor.account.address];
    const requestedQuote = await token.read.settlementFundingRequired([holders]);
    const accrualBuffer = 1_000_000n;
    await fund(stablecoin, token, requestedQuote + accrualBuffer);
    const fundingBeforeRequest = await stablecoin.read.balanceOf([funding.account.address]);
    await token.write.settleWithdrawals([holders], { account: owner.account });
    const requestedFunding = fundingBeforeRequest - (await stablecoin.read.balanceOf([funding.account.address]));
    assert.ok(requestedFunding >= requestedQuote);
    assert.ok(requestedFunding <= requestedQuote + accrualBuffer);

    await increaseTo(await token.read.maturity());
    const maturedHolders = [investor.account.address, bob.account.address];
    const maturityQuote = await token.read.settlementFundingRequired([maturedHolders]);
    await fund(stablecoin, token, maturityQuote);
    const fundingBeforeMaturity = await stablecoin.read.balanceOf([funding.account.address]);
    await token.write.settleWithdrawals([maturedHolders], { account: owner.account });
    assert.equal(fundingBeforeMaturity - (await stablecoin.read.balanceOf([funding.account.address])), maturityQuote);
  });

  it("retains settlement proceeds while clearing fractional distributed income on a full exit", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const investorBalance = 142n * TOKEN_SCALE;
    await mintInvestment(token, investorBalance);
    await mintInvestment(token, conditions.minTicket, bob);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.distributeIncome({ account: owner.account });
    await token.write.requestWithdrawal([investorBalance], { account: investor.account });
    await increaseTo(
      (await token.read.acquisitionTimestamp([investor.account.address])) +
        conditions.minPeriod +
        conditions.lockup +
        2n * DAY,
    );

    const incomePerToken = await token.read.accumulatedIncomePerToken();
    assert.notEqual((investorBalance * incomePerToken) % INDEX_SCALE, 0n);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });

    assert.equal(await token.read.balanceOf([investor.account.address]), 0n);
    assert.ok(await token.read.claimableIncome([investor.account.address]));
    assert.equal(await token.read.accumulatedIncomeOf([investor.account.address]), 0n);
    assert.equal(
      await token.read.totalAccumulatedIncome(),
      await token.read.accumulatedIncomeOf([bob.account.address]),
    );
  });

  it("reverts a settlement batch atomically on insufficient funding", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, conditions.minTicket);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([conditions.minTicket], { account: investor.account });
    await increaseTo(
      (await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod + conditions.lockup,
    );
    await stablecoin.write.mint([funding.account.address, 100n * STABLECOIN_SCALE], { account: funding.account });
    await stablecoin.write.approve([token.address, 100n * STABLECOIN_SCALE], { account: funding.account });
    await assert.rejects(() => token.write.settleWithdrawals([[investor.account.address]], { account: owner.account }));
    assert.equal(await token.read.balanceOf([investor.account.address]), conditions.minTicket);
    assert.equal(await token.read.reservedWithdrawal([investor.account.address]), conditions.minTicket);
  });

  it("stops normal transfers and accrual at maturity", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, conditions.minTicket);
    await increaseTo(startedAt + conditions.duration);
    await assert.rejects(() => token.write.transfer([bob.account.address, 1n], { account: investor.account }));
    const accrued = await token.read.accumulatedIncomeOf([investor.account.address]);
    await increaseTo(startedAt + conditions.duration + DAY);
    assert.equal(await token.read.accumulatedIncomeOf([investor.account.address]), accrued);
  });

  it("settles full holder balances at maturity without requests", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, conditions.minTicket);
    await increaseTo(startedAt + conditions.duration);
    const payment = 100n * STABLECOIN_SCALE + expectedIncome(conditions.minTicket, conditions.duration);
    await fund(stablecoin, token, payment);
    const holderBalanceBefore = await stablecoin.read.balanceOf([investor.account.address]);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    assert.equal(await token.read.balanceOf([investor.account.address]), 0n);
    assert.equal(await stablecoin.read.balanceOf([investor.account.address]), holderBalanceBefore);
    assert.equal(await token.read.claimableIncome([investor.account.address]), payment);
  });

  it("accumulates multiple funded settlements before one claim", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const settlementAmount = 100n * TOKEN_SCALE;
    await mintInvestment(token, 2n * settlementAmount);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([settlementAmount], { account: investor.account });
    await increaseTo(
      (await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod + conditions.lockup,
    );
    await fund(stablecoin, token, 1_000_000_000n);
    const fundingBeforeFirst = await stablecoin.read.balanceOf([funding.account.address]);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    const firstSettlement = fundingBeforeFirst - (await stablecoin.read.balanceOf([funding.account.address]));

    await token.write.requestWithdrawal([settlementAmount], { account: investor.account });
    await increaseTo(
      (await token.read.acquisitionTimestamp([investor.account.address])) +
        conditions.minPeriod +
        2n * conditions.lockup +
        DAY,
    );
    await fund(stablecoin, token, 1_000_000_000n);
    const fundingBeforeSecond = await stablecoin.read.balanceOf([funding.account.address]);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    const secondSettlement = fundingBeforeSecond - (await stablecoin.read.balanceOf([funding.account.address]));

    assert.equal(await token.read.claimableIncome([investor.account.address]), firstSettlement + secondSettlement);
  });

  it("pays a settlement claim through distributeIncomeTo without counting principal as income", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, conditions.minTicket);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([conditions.minTicket], { account: investor.account });
    await increaseTo(
      (await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod + conditions.lockup,
    );
    await fund(stablecoin, token, 1_000_000_000n);
    const fundingBefore = await stablecoin.read.balanceOf([funding.account.address]);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    const settlement = fundingBefore - (await stablecoin.read.balanceOf([funding.account.address]));
    const holderBalanceBefore = await stablecoin.read.balanceOf([investor.account.address]);

    assert.equal(await token.read.totalAccumulatedIncome(), 0n);
    assert.equal(await token.read.claimableIncome([investor.account.address]), settlement);
    await token.write.distributeIncomeTo([[investor.account.address]], { account: owner.account });
    assert.equal(await stablecoin.read.balanceOf([investor.account.address]), holderBalanceBefore + settlement);
    assert.equal(await token.read.claimableIncome([investor.account.address]), 0n);
  });

  it("restores distributed income and settlement claims when a unified payout fails", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const settlementAmount = 100n * TOKEN_SCALE;
    await mintInvestment(token, 2n * settlementAmount);
    await fund(stablecoin, token, 1_000_000_000n);
    await setNextBlockTime((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.distributeIncome({ account: owner.account });
    await token.write.requestWithdrawal([settlementAmount], { account: investor.account });
    await increaseTo(
      (await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod + conditions.lockup,
    );
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    await fund(stablecoin, token, 1_000_000_000n);
    await setNextBlockTime((await token.read.lastDistributionTime()) + conditions.minPeriod);
    await token.write.distributeIncome({ account: owner.account });

    const claimableBefore = await token.read.claimableIncome([investor.account.address]);
    const accumulatedBefore = await token.read.totalAccumulatedIncome();
    const contractBalanceBefore = await stablecoin.read.balanceOf([token.address]);
    const holderBalanceBefore = await stablecoin.read.balanceOf([investor.account.address]);
    assert.ok(claimableBefore > accumulatedBefore);
    assert.ok(accumulatedBefore > 0n);
    await stablecoin.write.setTransfersReverting([true], { account: funding.account });

    await assert.rejects(() => token.write.claimIncome({ account: investor.account }));

    assert.equal(await token.read.claimableIncome([investor.account.address]), claimableBefore);
    assert.equal(await token.read.totalAccumulatedIncome(), accumulatedBefore);
    assert.equal(await stablecoin.read.balanceOf([token.address]), contractBalanceBefore);
    assert.equal(await stablecoin.read.balanceOf([investor.account.address]), holderBalanceBefore);

    await stablecoin.write.setTransfersReverting([false], { account: funding.account });
    await token.write.claimIncome({ account: investor.account });
    assert.equal(await stablecoin.read.balanceOf([investor.account.address]), holderBalanceBefore + claimableBefore);
    assert.equal(await token.read.claimableIncome([investor.account.address]), 0n);
  });

  it("keeps a zero combined claim as a no-op", async function () {
    const { token, stablecoin } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    const holderBalanceBefore = await stablecoin.read.balanceOf([investor.account.address]);
    const contractBalanceBefore = await stablecoin.read.balanceOf([token.address]);

    await token.write.claimIncome({ account: investor.account });

    assert.equal(await stablecoin.read.balanceOf([investor.account.address]), holderBalanceBefore);
    assert.equal(await stablecoin.read.balanceOf([token.address]), contractBalanceBefore);
  });

  it("settles a full maturity balance after a prior partial withdrawal request", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, 200n * TOKEN_SCALE);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([conditions.minTicket], { account: investor.account });
    await increaseTo(startedAt + conditions.duration);
    const payment = 200n * STABLECOIN_SCALE + expectedIncome(200n * TOKEN_SCALE, conditions.duration);
    await fund(stablecoin, token, payment);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    assert.equal(await token.read.balanceOf([investor.account.address]), 0n);
    assert.equal(await token.read.reservedWithdrawal([investor.account.address]), 0n);
  });

  it("consumes settlement burn authorization before later direct burns", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 200n * TOKEN_SCALE);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([conditions.minTicket], { account: investor.account });
    await increaseTo(
      (await token.read.acquisitionTimestamp([investor.account.address])) +
        conditions.minPeriod +
        conditions.lockup +
        DAY,
    );
    100n * STABLECOIN_SCALE + expectedIncome(conditions.minTicket, conditions.minPeriod + conditions.lockup + DAY);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    await assert.rejects(() => token.write.burn([investor.account.address, 1n], { account: agent.account }));
    assert.equal(await token.read.balanceOf([investor.account.address]), conditions.minTicket);
  });

  it("keeps reserved tokens immovable by forced transfer while recovery migrates them", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 200n * TOKEN_SCALE);
    await increaseTo((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.requestWithdrawal([100n * TOKEN_SCALE], { account: investor.account });
    await assert.rejects(() =>
      token.write.forcedTransfer([investor.account.address, bob.account.address, 101n * TOKEN_SCALE], {
        account: agent.account,
      }),
    );
    await identityRegistry.write.removeIdentity([bob.account.address], { account: agent.account });
    await token.write.recoveryAddress([investor.account.address, bob.account.address], { account: agent.account });
    assert.equal(await token.read.balanceOf([investor.account.address]), 0n);
    assert.equal(await token.read.reservedWithdrawal([investor.account.address]), 0n);
    assert.equal(await token.read.balanceOf([bob.account.address]), 200n * TOKEN_SCALE);
    assert.equal(await token.read.reservedWithdrawal([bob.account.address]), 100n * TOKEN_SCALE);
  });

  it("migrates distributed and undistributed income with a recovered private-credit balance", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    const balance = 101n * TOKEN_SCALE;
    await mintInvestment(token, balance);
    await fund(stablecoin, token, 1_000_000_000n);
    await setNextBlockTime(startedAt + 30n * DAY);
    await token.write.distributeIncome({ account: owner.account });
    await increaseTo(startedAt + 31n * DAY);
    const distributedClaim = await token.read.claimableIncome([investor.account.address]);
    const holderAccumulatedBefore = await token.read.accumulatedIncomeOf([investor.account.address]);
    const acquisitionTime = await token.read.acquisitionTimestamp([investor.account.address]);

    await token.write.recoveryAddress([investor.account.address, bob.account.address], { account: agent.account });

    assert.equal(await token.read.balanceOf([investor.account.address]), 0n);
    assert.equal(await token.read.claimableIncome([investor.account.address]), 0n);
    assert.equal(await token.read.balanceOf([bob.account.address]), balance);
    assert.equal(await token.read.claimableIncome([bob.account.address]), distributedClaim);
    assert.equal(await token.read.accumulatedIncomeOf([investor.account.address]), 0n);
    const migratedAccumulated = await token.read.accumulatedIncomeOf([bob.account.address]);
    assert.ok(migratedAccumulated >= holderAccumulatedBefore);
    assert.equal(await token.read.acquisitionTimestamp([bob.account.address]), acquisitionTime);
    assert.equal(await token.read.totalSupply(), balance);
    assert.equal(await token.read.totalAccumulatedIncome(), migratedAccumulated);

    await setNextBlockTime(startedAt + 60n * DAY);
    await token.write.distributeIncome({ account: owner.account });
    assert.equal(await token.read.claimableIncome([investor.account.address]), 0n);
    assert.ok((await token.read.claimableIncome([bob.account.address])) > distributedClaim);
  });

  it("migrates funded settlement claims after a full withdrawal", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, conditions.minTicket);
    const acquisitionTime = await token.read.acquisitionTimestamp([investor.account.address]);
    await increaseTo(acquisitionTime + conditions.minPeriod);
    await token.write.requestWithdrawal([conditions.minTicket], { account: investor.account });
    await increaseTo(acquisitionTime + conditions.minPeriod + conditions.lockup);
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    const settlementClaim = await token.read.claimableIncome([investor.account.address]);

    await token.write.recoveryAddress([investor.account.address, bob.account.address], { account: agent.account });

    assert.equal(await token.read.balanceOf([investor.account.address]), 0n);
    assert.equal(await token.read.claimableIncome([investor.account.address]), 0n);
    assert.equal(await token.read.claimableIncome([bob.account.address]), settlementClaim);
    const oldWalletBefore = await stablecoin.read.balanceOf([investor.account.address]);
    const replacementBefore = await stablecoin.read.balanceOf([bob.account.address]);
    await token.write.claimIncome({ account: investor.account });
    assert.equal(await stablecoin.read.balanceOf([investor.account.address]), oldWalletBefore);
    await token.write.claimIncome({ account: bob.account });
    assert.equal(await stablecoin.read.balanceOf([bob.account.address]), replacementBefore + settlementClaim);
    assert.equal(await token.read.claimableIncome([bob.account.address]), 0n);
  });

  it("preserves both claims when recovery targets an existing identity", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, conditions.minTicket);
    await mintInvestment(token, conditions.minTicket, bob);
    await fund(stablecoin, token, 1_000_000_000n);
    await setNextBlockTime(startedAt + 30n * DAY);
    await token.write.distributeIncome({ account: owner.account });
    const lostClaim = await token.read.claimableIncome([investor.account.address]);
    const replacementClaim = await token.read.claimableIncome([bob.account.address]);

    await assert.rejects(
      () => token.write.recoveryAddress([investor.account.address, bob.account.address], { account: agent.account }),
      /AlreadyExists/,
    );
    assert.equal(await token.read.claimableIncome([investor.account.address]), lostClaim);
    assert.equal(await token.read.claimableIncome([bob.account.address]), replacementClaim);
    const oldWalletBefore = await stablecoin.read.balanceOf([investor.account.address]);
    const replacementBefore = await stablecoin.read.balanceOf([bob.account.address]);
    await token.write.claimIncome({ account: bob.account });
    assert.equal(await stablecoin.read.balanceOf([investor.account.address]), oldWalletBefore);
    assert.equal(await stablecoin.read.balanceOf([bob.account.address]), replacementBefore + replacementClaim);
  });

  it("does not combine fractional claims by overwriting an identity", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await registerVerifiedInvestor(identityRegistry, outsider);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    await mintInvestment(token, conditions.minTicket, outsider);
    const fractionalBalance = 51n * 10n ** 12n;
    await token.write.transfer([investor.account.address, fractionalBalance], { account: outsider.account });
    await token.write.transfer([bob.account.address, fractionalBalance], { account: outsider.account });
    await fund(stablecoin, token, 1_000_000_000n);
    await setNextBlockTime(startedAt + 30n * DAY);
    await token.write.distributeIncome({ account: owner.account });
    const index = await token.read.accumulatedIncomePerToken();
    const combinedScaled = 2n * fractionalBalance * index;
    const combinedClaim = combinedScaled / INDEX_SCALE;
    assert.equal(await token.read.claimableIncome([investor.account.address]), 0n);
    assert.equal(await token.read.claimableIncome([bob.account.address]), 0n);
    assert.equal(combinedClaim, 1n);
    const totalIncome = await token.read.totalAccumulatedIncome();

    await assert.rejects(
      () => token.write.recoveryAddress([investor.account.address, bob.account.address], { account: agent.account }),
      /AlreadyExists/,
    );

    assert.equal(await token.read.claimableIncome([investor.account.address]), 0n);
    assert.equal(await token.read.claimableIncome([bob.account.address]), 0n);
    assert.equal(await token.read.totalAccumulatedIncome(), totalIncome);
  });

  it("preserves reservations and freezes when recovery targets a registered holder", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await registerVerifiedInvestor(identityRegistry, bob);
    await registerVerifiedInvestor(identityRegistry, outsider);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, 200n * TOKEN_SCALE);
    await mintInvestment(token, 200n * TOKEN_SCALE, bob);
    const investorAcquisitionTime = await token.read.acquisitionTimestamp([investor.account.address]);
    const bobAcquisitionTime = await token.read.acquisitionTimestamp([bob.account.address]);
    await increaseTo(investorAcquisitionTime + conditions.minPeriod);
    await token.write.requestWithdrawal([100n * TOKEN_SCALE], { account: investor.account });
    await increaseTo(bobAcquisitionTime + conditions.minPeriod + DAY);
    await token.write.requestWithdrawal([100n * TOKEN_SCALE], { account: bob.account });
    await token.write.freezePartialTokens([investor.account.address, 50n * TOKEN_SCALE], { account: agent.account });
    await token.write.setAddressFrozen([investor.account.address, true], { account: agent.account });
    await assert.rejects(
      () => token.write.recoveryAddress([investor.account.address, bob.account.address], { account: agent.account }),
      /AlreadyExists/,
    );
    assert.equal(await token.read.balanceOf([investor.account.address]), 200n * TOKEN_SCALE);
    assert.equal(await token.read.reservedWithdrawal([investor.account.address]), 100n * TOKEN_SCALE);
    assert.equal(await token.read.balanceOf([bob.account.address]), 200n * TOKEN_SCALE);
    assert.equal(await token.read.reservedWithdrawal([bob.account.address]), 100n * TOKEN_SCALE);
  });

  it("rejects recovery to the same wallet", async function () {
    const { token, identityRegistry } = await deployPrivateCreditSuite(viem, [owner, agent, issuer, funding]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    await mintInvestment(token, conditions.minTicket);

    await assert.rejects(() =>
      token.write.recoveryAddress([investor.account.address, investor.account.address], { account: agent.account }),
    );
  });

  it("preserves private-credit state across an owner-authorized UUPS upgrade", async function () {
    const { token, stablecoin, identityRegistry } = await deployPrivateCreditSuite(viem, [
      owner,
      agent,
      issuer,
      funding,
    ]);
    await registerVerifiedInvestor(identityRegistry);
    await token.write.start({ account: owner.account });
    const startedAt = await token.read.startTime();
    const balance = 200n * TOKEN_SCALE;
    const reserved = 100n * TOKEN_SCALE;
    const income = expectedIncome(balance, conditions.minPeriod);
    await mintInvestment(token, balance);
    await fund(stablecoin, token, income + 10n);
    await setNextBlockTime((await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod);
    await token.write.distributeIncome({ account: owner.account });
    const distributionTime = await token.read.lastDistributionTime();
    await token.write.requestWithdrawal([reserved], { account: investor.account });
    await increaseTo(
      (await token.read.acquisitionTimestamp([investor.account.address])) + conditions.minPeriod + conditions.lockup,
    );
    await fund(stablecoin, token, 1_000_000_000n);
    await token.write.settleWithdrawals([[investor.account.address]], { account: owner.account });
    const settlementClaimBeforeUpgrade = await token.read.claimableIncome([investor.account.address]);
    const acquisitionTime = await token.read.acquisitionTimestamp([investor.account.address]);
    const v2Impl = await viem.deployContract("PrivateCreditTokenV2");

    await assert.rejects(() => token.write.upgradeToAndCall([v2Impl.address, "0x"], { account: outsider.account }));
    await token.write.upgradeToAndCall([v2Impl.address, "0x"], { account: owner.account });

    const tokenV2 = await viem.getContractAt("PrivateCreditTokenV2", token.address);
    assert.equal(await tokenV2.read.versionV2(), "v2");
    const storedConditions = await tokenV2.read.debtConditions();
    assert.equal(storedConditions.minTicket, conditions.minTicket);
    assert.equal(storedConditions.duration, conditions.duration);
    assert.equal(storedConditions.minPeriod, conditions.minPeriod);
    assert.equal(storedConditions.lockup, conditions.lockup);
    assert.equal(storedConditions.apyBps, conditions.apyBps);
    assert.equal(storedConditions.distributionTerms, conditions.distributionTerms);
    assert.equal(storedConditions.yieldMode, conditions.yieldMode);
    assert.equal(await tokenV2.read.balanceOf([investor.account.address]), balance - reserved);
    assert.equal(await tokenV2.read.claimableIncome([investor.account.address]), settlementClaimBeforeUpgrade);
    assert.equal(await tokenV2.read.acquisitionTimestamp([investor.account.address]), acquisitionTime);
    assert.equal(await tokenV2.read.reservedWithdrawal([investor.account.address]), 0n);
    assert.equal(await tokenV2.read.startTime(), startedAt);
    assert.equal(await tokenV2.read.maturity(), startedAt + conditions.duration);
    assert.equal(await tokenV2.read.mintingCutoff(), startedAt + conditions.duration - conditions.minPeriod);
    assert.equal(await tokenV2.read.lastDistributionTime(), distributionTime);
  });
});
