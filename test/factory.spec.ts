import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseAbiItem } from "viem";

import { deployUpgradeable } from "./helpers/deploy-upgradeable";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const NO_ORACLE = {
  denominationFeed: ZERO_ADDRESS,
  denominationMaxAge: 0,
  stablecoinFeed: ZERO_ADDRESS,
  stablecoinMaxAge: 0,
  sequencerFeed: ZERO_ADDRESS,
  sequencerGracePeriod: 0,
};
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const IMPLEMENTATIONS_UPDATED_EVENT = parseAbiItem(
  "event ImplementationsUpdated(address tokenImpl, address privateCreditTokenImpl, address identityRegistryImpl, address identityRegistryStorageImpl, address claimTopicsRegistryImpl, address trustedIssuersRegistryImpl, address complianceImpl)",
);

describe("TokenFactory", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [owner, issuer, outsider] = await viem.getWalletClients();

  const deployFactory = async () => {
    const tokenImpl = await viem.deployContract("ERC3643Token");
    const privateCreditTokenImpl = await viem.deployContract("PrivateCreditToken");
    const identityRegistryImpl = await viem.deployContract("IdentityRegistry");
    const identityRegistryStorageImpl = await viem.deployContract("IdentityRegistryStorage");
    const claimTopicsRegistryImpl = await viem.deployContract("ClaimTopicsRegistry");
    const trustedIssuersRegistryImpl = await viem.deployContract("TrustedIssuersRegistry");
    const complianceImpl = await viem.deployContract("Compliance");

    const { contract: factory } = await deployUpgradeable(viem, "TokenFactory");

    await factory.write.initialize(
      [
        owner.account.address,
        tokenImpl.address,
        privateCreditTokenImpl.address,
        identityRegistryImpl.address,
        identityRegistryStorageImpl.address,
        claimTopicsRegistryImpl.address,
        trustedIssuersRegistryImpl.address,
        complianceImpl.address,
        ZERO_ADDRESS,
      ],
      { account: owner.account },
    );

    return {
      factory,
      tokenImpl,
      privateCreditTokenImpl,
      identityRegistryImpl,
      identityRegistryStorageImpl,
      claimTopicsRegistryImpl,
      trustedIssuersRegistryImpl,
      complianceImpl,
    };
  };

  it("deploys a token suite and wires registries", async function () {
    const { factory } = await deployFactory();
    const claimIssuer = await viem.deployContract("MockClaimIssuer");

    const tokenDetails = {
      name: "UFarm Asset",
      symbol: "UFARM",
      decimals: 18,
      version: "1",
      owner: issuer.account.address,
      salt: ZERO_BYTES32,
    };

    const claimDetails = {
      requiredTopics: [1n],
      trustedIssuers: [claimIssuer.address],
      issuerTopics: [[1n]],
    };

    const fromBlock = await publicClient.getBlockNumber();
    const hash = await factory.write.deployTokenSuite([tokenDetails, claimDetails, ZERO_ADDRESS], {
      account: owner.account,
    });

    await publicClient.waitForTransactionReceipt({ hash });

    const events = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "TokenSuiteDeployed",
      fromBlock,
      strict: true,
    });

    assert.equal(events.length > 0, true);

    const tokenProxy = events[events.length - 1]?.args.tokenProxy;
    assert.notEqual(tokenProxy, ZERO_ADDRESS);

    const token = await viem.getContractAt("ERC3643Token", tokenProxy);
    const identityRegistryAddress = await token.read.identityRegistry();
    const complianceAddress = await token.read.compliance();

    assert.notEqual(identityRegistryAddress, ZERO_ADDRESS);
    assert.notEqual(complianceAddress, ZERO_ADDRESS);
  });

  it("rejects no-code trusted issuers after claim coverage validation", async function () {
    const { factory } = await deployFactory();
    const tokenDetails = {
      name: "UFarm Asset",
      symbol: "UFARM",
      decimals: 18,
      version: "1",
      owner: issuer.account.address,
      salt: ZERO_BYTES32,
    };
    const eoaIssuerConfiguration = {
      requiredTopics: [1n],
      trustedIssuers: [issuer.account.address],
      issuerTopics: [[1n]],
    };

    await assert.rejects(
      () =>
        factory.write.deployTokenSuite([tokenDetails, eoaIssuerConfiguration, ZERO_ADDRESS], {
          account: owner.account,
        }),
      /InvalidTrustedIssuer|0x7e74b2ca/,
    );
  });

  it("recovers a factory-deployed token holder without granting the token an agent role", async function () {
    const { factory } = await deployFactory();
    const tokenDetails = {
      name: "UFarm Asset",
      symbol: "UFARM",
      decimals: 18,
      version: "1",
      owner: issuer.account.address,
      salt: ZERO_BYTES32,
    };
    const claimDetails = { requiredTopics: [], trustedIssuers: [], issuerTopics: [] };

    const fromBlock = await publicClient.getBlockNumber();
    const hash = await factory.write.deployTokenSuite([tokenDetails, claimDetails, ZERO_ADDRESS], {
      account: owner.account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    const events = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "TokenSuiteDeployed",
      fromBlock,
      strict: true,
    });
    const token = await viem.getContractAt("ERC3643Token", events[events.length - 1]!.args.tokenProxy);
    const identityRegistry = await viem.getContractAt("IdentityRegistry", await token.read.identityRegistry());
    const lostIdentity = await viem.deployContract("MockOnchainID");
    const recoveredIdentity = await viem.deployContract("MockOnchainID");

    await identityRegistry.write.registerIdentity([owner.account.address, lostIdentity.address, 840], {
      account: issuer.account,
    });
    await identityRegistry.write.registerIdentity([outsider.account.address, recoveredIdentity.address, 840], {
      account: issuer.account,
    });
    await token.write.mint([owner.account.address, 100n], { account: issuer.account });

    await assert.rejects(
      () => token.write.recoveryAddress([owner.account.address, outsider.account.address], { account: issuer.account }),
      /AlreadyExists/,
    );
    await identityRegistry.write.removeIdentity([outsider.account.address], { account: issuer.account });

    await token.write.recoveryAddress([owner.account.address, outsider.account.address], { account: issuer.account });

    assert.equal(await token.read.balanceOf([owner.account.address]), 0n);
    assert.equal(await token.read.balanceOf([outsider.account.address]), 100n);
    assert.equal(
      (await identityRegistry.read.investorIdentity([outsider.account.address])).toLowerCase(),
      lostIdentity.address.toLowerCase(),
    );
  });

  it("reuses identity registry storage when supplied", async function () {
    const { factory } = await deployFactory();
    const claimIssuer = await viem.deployContract("MockClaimIssuer");

    const tokenDetails = {
      name: "UFarm Asset",
      symbol: "UFARM",
      decimals: 18,
      version: "1",
      owner: issuer.account.address,
      salt: ZERO_BYTES32,
    };

    const claimDetails = {
      requiredTopics: [1n],
      trustedIssuers: [claimIssuer.address],
      issuerTopics: [[1n]],
    };

    const fromBlock = await publicClient.getBlockNumber();
    const firstHash = await factory.write.deployTokenSuite([tokenDetails, claimDetails, ZERO_ADDRESS], {
      account: owner.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: firstHash });

    const firstEvents = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "TokenSuiteDeployed",
      fromBlock,
      strict: true,
    });

    const firstTokenProxy = firstEvents[firstEvents.length - 1]?.args.tokenProxy;
    const firstToken = await viem.getContractAt("ERC3643Token", firstTokenProxy);
    const firstIdentityRegistryAddress = await firstToken.read.identityRegistry();
    const firstIdentityRegistry = await viem.getContractAt("IdentityRegistry", firstIdentityRegistryAddress);
    const sharedStorage = await firstIdentityRegistry.read.identityStorage();

    const secondHash = await factory.write.deployTokenSuite([tokenDetails, claimDetails, sharedStorage], {
      account: owner.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: secondHash });

    const secondEvents = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "TokenSuiteDeployed",
      fromBlock,
      strict: true,
    });

    const secondTokenProxy = secondEvents[secondEvents.length - 1]?.args.tokenProxy;
    const secondToken = await viem.getContractAt("ERC3643Token", secondTokenProxy);
    const secondIdentityRegistryAddress = await secondToken.read.identityRegistry();
    const secondIdentityRegistry = await viem.getContractAt("IdentityRegistry", secondIdentityRegistryAddress);

    assert.equal(await secondIdentityRegistry.read.identityStorage(), sharedStorage);
  });

  it("rejects cross-owner identity storage reuse without changing the existing suite", async function () {
    const { factory } = await deployFactory();
    const tokenDetails = {
      name: "Suite A",
      symbol: "SUITA",
      decimals: 18,
      version: "1",
      owner: owner.account.address,
      salt: ZERO_BYTES32,
    };
    const claimDetails = { requiredTopics: [], trustedIssuers: [], issuerTopics: [] };
    const identity = await viem.deployContract("MockOnchainID");

    const firstHash = await factory.write.deployTokenSuite([tokenDetails, claimDetails, ZERO_ADDRESS], {
      account: owner.account,
    });
    const firstReceipt = await publicClient.waitForTransactionReceipt({ hash: firstHash });
    const firstEvent = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "TokenSuiteDeployed",
      fromBlock: firstReceipt.blockNumber,
      strict: true,
    });
    const firstToken = await viem.getContractAt("ERC3643Token", firstEvent[0]?.args.tokenProxy);
    const firstRegistry = await viem.getContractAt("IdentityRegistry", await firstToken.read.identityRegistry());
    const sharedStorage = await firstRegistry.read.identityStorage();
    await firstRegistry.write.registerIdentity([issuer.account.address, identity.address, 840], {
      account: owner.account,
    });

    await assert.rejects(
      () =>
        factory.write.deployTokenSuite(
          [
            { ...tokenDetails, name: "Suite B", symbol: "SUITB", owner: outsider.account.address },
            claimDetails,
            sharedStorage,
          ],
          { account: outsider.account },
        ),
      /IdentityStorageOwnerMismatch/,
    );

    assert.equal(await firstRegistry.read.identityStorage(), sharedStorage);
    assert.equal(
      (await firstRegistry.read.investorIdentity([issuer.account.address])).toLowerCase(),
      identity.address.toLowerCase(),
    );
  });

  it("allows any caller to reuse identity storage for its owner", async function () {
    const { factory } = await deployFactory();
    const tokenDetails = {
      name: "Suite A",
      symbol: "SUITA",
      decimals: 18,
      version: "1",
      owner: owner.account.address,
      salt: ZERO_BYTES32,
    };
    const claimDetails = { requiredTopics: [], trustedIssuers: [], issuerTopics: [] };
    const firstHash = await factory.write.deployTokenSuite([tokenDetails, claimDetails, ZERO_ADDRESS], {
      account: owner.account,
    });
    const firstReceipt = await publicClient.waitForTransactionReceipt({ hash: firstHash });
    const firstEvent = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "TokenSuiteDeployed",
      fromBlock: firstReceipt.blockNumber,
      strict: true,
    });
    const firstToken = await viem.getContractAt("ERC3643Token", firstEvent[0]?.args.tokenProxy);
    const sharedStorage = await (
      await viem.getContractAt("IdentityRegistry", await firstToken.read.identityRegistry())
    ).read.identityStorage();

    const secondHash = await factory.write.deployTokenSuite(
      [{ ...tokenDetails, name: "Suite B", symbol: "SUITB" }, claimDetails, sharedStorage],
      { account: outsider.account },
    );
    const secondReceipt = await publicClient.waitForTransactionReceipt({ hash: secondHash });
    const secondEvent = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "TokenSuiteDeployed",
      fromBlock: secondReceipt.blockNumber,
      strict: true,
    });
    const secondToken = await viem.getContractAt("ERC3643Token", secondEvent[0]?.args.tokenProxy);
    const secondRegistry = await viem.getContractAt("IdentityRegistry", await secondToken.read.identityRegistry());

    assert.equal((await secondRegistry.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    assert.equal(await secondRegistry.read.isAgent([owner.account.address]), true);
  });

  it("rejects required claim topics without issuer coverage", async function () {
    const { factory } = await deployFactory();
    const tokenDetails = {
      name: "UFarm Asset",
      symbol: "UFARM",
      decimals: 18,
      version: "1",
      owner: owner.account.address,
      salt: ZERO_BYTES32,
    };

    for (const claimDetails of [
      { requiredTopics: [1n], trustedIssuers: [], issuerTopics: [] },
      { requiredTopics: [2n], trustedIssuers: [issuer.account.address], issuerTopics: [[1n]] },
    ]) {
      await assert.rejects(
        () => factory.write.deployTokenSuite([tokenDetails, claimDetails, ZERO_ADDRESS], { account: outsider.account }),
        /InvalidClaimConfiguration/,
      );
    }

    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    for (const claimDetails of [
      { requiredTopics: [], trustedIssuers: [], issuerTopics: [] },
      { requiredTopics: [1n], trustedIssuers: [claimIssuer.address], issuerTopics: [[1n]] },
    ]) {
      const hash = await factory.write.deployTokenSuite([tokenDetails, claimDetails, ZERO_ADDRESS], {
        account: outsider.account,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  });

  it("returns implementation addresses", async function () {
    const {
      factory,
      tokenImpl,
      privateCreditTokenImpl,
      identityRegistryImpl,
      identityRegistryStorageImpl,
      claimTopicsRegistryImpl,
      trustedIssuersRegistryImpl,
      complianceImpl,
    } = await deployFactory();

    const impls = await factory.read.getImplementations();

    assert.equal(impls[0].toLowerCase(), tokenImpl.address.toLowerCase());
    assert.equal(impls[1].toLowerCase(), privateCreditTokenImpl.address.toLowerCase());
    assert.equal(impls[2].toLowerCase(), identityRegistryImpl.address.toLowerCase());
    assert.equal(impls[3].toLowerCase(), identityRegistryStorageImpl.address.toLowerCase());
    assert.equal(impls[4].toLowerCase(), claimTopicsRegistryImpl.address.toLowerCase());
    assert.equal(impls[5].toLowerCase(), trustedIssuersRegistryImpl.address.toLowerCase());
    assert.equal(impls[6].toLowerCase(), complianceImpl.address.toLowerCase());
  });

  it("emits the complete implementation set after a sparse update", async function () {
    const { factory, tokenImpl, privateCreditTokenImpl } = await deployFactory();
    const nextTokenImpl = await viem.deployContract("ERC3643Token");

    const hash = await factory.write.setImplementations(
      [nextTokenImpl.address, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS],
      { account: owner.account },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const events = await publicClient.getLogs({
      address: factory.address,
      event: IMPLEMENTATIONS_UPDATED_EVENT,
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    const impls = await factory.read.getImplementations();

    assert.equal(events.length, 1);
    assert.equal(impls[0].toLowerCase(), nextTokenImpl.address.toLowerCase());
    assert.equal(impls[1].toLowerCase(), privateCreditTokenImpl.address.toLowerCase());
    assert.deepEqual(
      Object.values(events[0]!.args).map((value) => value.toLowerCase()),
      impls.map((value) => value.toLowerCase()),
    );
    assert.notEqual(tokenImpl.address, nextTokenImpl.address);
  });

  it("rejects non-owner implementation updates without emitting an event", async function () {
    const { factory, tokenImpl } = await deployFactory();
    const fromBlock = await publicClient.getBlockNumber();
    await assert.rejects(() =>
      factory.write.setImplementations(
        [ZERO_ADDRESS, tokenImpl.address, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS],
        { account: issuer.account },
      ),
    );
    assert.equal(
      (
        await publicClient.getLogs({
          address: factory.address,
          event: IMPLEMENTATIONS_UPDATED_EVENT,
          fromBlock,
        })
      ).length,
      0,
    );
  });

  it("rejects zero token implementation addresses during initialization", async function () {
    const {
      tokenImpl,
      privateCreditTokenImpl,
      identityRegistryImpl,
      identityRegistryStorageImpl,
      claimTopicsRegistryImpl,
      trustedIssuersRegistryImpl,
      complianceImpl,
    } = await deployFactory();

    const { contract: zeroStandardFactory } = await deployUpgradeable(viem, "TokenFactory");
    await assert.rejects(() =>
      zeroStandardFactory.write.initialize([
        owner.account.address,
        ZERO_ADDRESS,
        privateCreditTokenImpl.address,
        identityRegistryImpl.address,
        identityRegistryStorageImpl.address,
        claimTopicsRegistryImpl.address,
        trustedIssuersRegistryImpl.address,
        complianceImpl.address,
        ZERO_ADDRESS,
      ]),
    );

    const { contract: zeroPrivateCreditFactory } = await deployUpgradeable(viem, "TokenFactory");
    await assert.rejects(() =>
      zeroPrivateCreditFactory.write.initialize([
        owner.account.address,
        tokenImpl.address,
        ZERO_ADDRESS,
        identityRegistryImpl.address,
        identityRegistryStorageImpl.address,
        claimTopicsRegistryImpl.address,
        trustedIssuersRegistryImpl.address,
        complianceImpl.address,
        ZERO_ADDRESS,
      ]),
    );
  });

  it("deploys an unstarted private-credit token suite and wires it", async function () {
    const { factory } = await deployFactory();
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    const stablecoin = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
    const denominationFeed = await viem.deployContract("MockChainlinkAggregatorV3", [8]);
    const stablecoinFeed = await viem.deployContract("MockChainlinkAggregatorV3", [6]);
    const sequencerFeed = await viem.deployContract("MockChainlinkAggregatorV3", [0]);
    const [, funding] = await viem.getWalletClients();
    const tokenDetails = {
      name: "UFarm Credit",
      symbol: "UFC",
      decimals: 18,
      version: "1",
      owner: issuer.account.address,
      salt: ZERO_BYTES32,
    };
    const claimDetails = { requiredTopics: [1n], trustedIssuers: [claimIssuer.address], issuerTopics: [[1n]] };
    const creditDetails = {
      stablecoin: stablecoin.address,
      fundingAddress: funding.account.address,
      conditions: {
        minTicket: 100n * 10n ** 18n,
        duration: 365n * 24n * 60n * 60n,
        minPeriod: 30n * 24n * 60n * 60n,
        lockup: 7n * 24n * 60n * 60n,
        apyBps: 1_200,
        distributionTerms: 0,
        yieldMode: 0,
      },
      oracleParameters: {
        denominationFeed: getAddress(denominationFeed.address),
        denominationMaxAge: 3_600,
        stablecoinFeed: getAddress(stablecoinFeed.address),
        stablecoinMaxAge: 300,
        sequencerFeed: getAddress(sequencerFeed.address),
        sequencerGracePeriod: 3_600,
      },
    };

    const fromBlock = await publicClient.getBlockNumber();
    const hash = await factory.write.deployPrivateCreditTokenSuite(
      [tokenDetails, claimDetails, creditDetails, ZERO_ADDRESS],
      { account: owner.account },
    );
    await publicClient.waitForTransactionReceipt({ hash });
    const events = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "TokenSuiteDeployed",
      fromBlock,
      strict: true,
    });
    const tokenProxy = events[events.length - 1]?.args.tokenProxy;
    assert.notEqual(tokenProxy, ZERO_ADDRESS);

    const token = await viem.getContractAt("PrivateCreditToken", tokenProxy);
    assert.equal(await token.read.name(), tokenDetails.name);
    assert.equal(await token.read.symbol(), tokenDetails.symbol);
    assert.equal(await token.read.decimals(), tokenDetails.decimals);
    assert.equal((await token.read.stablecoin()).toLowerCase(), stablecoin.address.toLowerCase());
    assert.equal((await token.read.fundingAddress()).toLowerCase(), funding.account.address.toLowerCase());
    assert.deepEqual(await token.read.debtConditions(), creditDetails.conditions);
    assert.deepEqual(await token.read.oracleConfig(), {
      ...creditDetails.oracleParameters,
      denominationFeedDecimals: 8,
      stablecoinFeedDecimals: 6,
    });
    assert.equal(await token.read.startTime(), 0n);

    const identityRegistryAddress = await token.read.identityRegistry();
    const complianceAddress = await token.read.compliance();
    const identityRegistry = await viem.getContractAt("IdentityRegistry", identityRegistryAddress);
    const compliance = await viem.getContractAt("Compliance", complianceAddress);
    assert.notEqual(identityRegistryAddress, ZERO_ADDRESS);
    assert.notEqual(complianceAddress, ZERO_ADDRESS);
    assert.equal(await identityRegistry.read.isAgent([issuer.account.address]), true);
    assert.equal((await identityRegistry.read.boundToken()).toLowerCase(), token.address.toLowerCase());
    assert.equal(await compliance.read.isTokenBound([tokenProxy]), true);
  });

  it("reuses identity registry storage across standard and private-credit suites", async function () {
    const { factory } = await deployFactory();
    const stablecoin = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
    const tokenDetails = {
      name: "UFarm Asset",
      symbol: "UFARM",
      decimals: 18,
      version: "1",
      owner: issuer.account.address,
      salt: ZERO_BYTES32,
    };
    const claimDetails = { requiredTopics: [], trustedIssuers: [], issuerTopics: [] };
    const creditDetails = {
      stablecoin: stablecoin.address,
      fundingAddress: owner.account.address,
      conditions: {
        minTicket: 100n,
        duration: 365n * 24n * 60n * 60n,
        minPeriod: 30n * 24n * 60n * 60n,
        lockup: 0n,
        apyBps: 1_200,
        distributionTerms: 0,
        yieldMode: 0,
      },
      oracleParameters: NO_ORACLE,
    };

    let fromBlock = await publicClient.getBlockNumber();
    let hash = await factory.write.deployTokenSuite([tokenDetails, claimDetails, ZERO_ADDRESS], {
      account: owner.account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    let events = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "TokenSuiteDeployed",
      fromBlock,
      strict: true,
    });
    const standardToken = await viem.getContractAt("ERC3643Token", events[events.length - 1]?.args.tokenProxy);
    const standardRegistry = await viem.getContractAt("IdentityRegistry", await standardToken.read.identityRegistry());
    const standardStorage = await standardRegistry.read.identityStorage();

    fromBlock = await publicClient.getBlockNumber();
    hash = await factory.write.deployPrivateCreditTokenSuite(
      [tokenDetails, claimDetails, creditDetails, standardStorage],
      { account: owner.account },
    );
    await publicClient.waitForTransactionReceipt({ hash });
    events = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "TokenSuiteDeployed",
      fromBlock,
      strict: true,
    });
    const creditToken = await viem.getContractAt("PrivateCreditToken", events[events.length - 1]?.args.tokenProxy);
    const creditRegistry = await viem.getContractAt("IdentityRegistry", await creditToken.read.identityRegistry());
    assert.equal(await creditRegistry.read.identityStorage(), standardStorage);

    fromBlock = await publicClient.getBlockNumber();
    hash = await factory.write.deployTokenSuite(
      [tokenDetails, claimDetails, await creditRegistry.read.identityStorage()],
      { account: owner.account },
    );
    await publicClient.waitForTransactionReceipt({ hash });
    events = await publicClient.getContractEvents({
      address: factory.address,
      abi: factory.abi,
      eventName: "TokenSuiteDeployed",
      fromBlock,
      strict: true,
    });
    const reusedStandardToken = await viem.getContractAt("ERC3643Token", events[events.length - 1]?.args.tokenProxy);
    const reusedStandardRegistry = await viem.getContractAt(
      "IdentityRegistry",
      await reusedStandardToken.read.identityRegistry(),
    );
    assert.equal(await reusedStandardRegistry.read.identityStorage(), standardStorage);
  });

  it("rejects invalid private-credit deployment input without emitting an event", async function () {
    const { factory } = await deployFactory();
    const stablecoin = await viem.deployContract("MockERC20", ["USD Coin", "USDC", 18]);
    const tokenDetails = {
      name: "UFarm Credit",
      symbol: "UFC",
      decimals: 18,
      version: "1",
      owner: issuer.account.address,
      salt: ZERO_BYTES32,
    };
    const claimDetails = { requiredTopics: [], trustedIssuers: [], issuerTopics: [] };
    const creditDetails = {
      stablecoin: stablecoin.address,
      fundingAddress: owner.account.address,
      conditions: {
        minTicket: 100n,
        duration: 365n * 24n * 60n * 60n,
        minPeriod: 30n * 24n * 60n * 60n,
        lockup: 0n,
        apyBps: 1_200,
        distributionTerms: 0,
        yieldMode: 0,
      },
      oracleParameters: NO_ORACLE,
    };

    for (const invalidCredit of [
      { ...creditDetails, stablecoin: ZERO_ADDRESS },
      { ...creditDetails, fundingAddress: ZERO_ADDRESS },
      { ...creditDetails, conditions: { ...creditDetails.conditions, minPeriod: creditDetails.conditions.duration } },
      { ...creditDetails, oracleParameters: { ...NO_ORACLE, denominationFeed: stablecoin.address } },
      {
        ...creditDetails,
        oracleParameters: { ...NO_ORACLE, denominationFeed: outsider.account.address, denominationMaxAge: 1 },
      },
    ]) {
      const fromBlock = await publicClient.getBlockNumber();
      await assert.rejects(() =>
        factory.write.deployPrivateCreditTokenSuite([tokenDetails, claimDetails, invalidCredit, ZERO_ADDRESS], {
          account: owner.account,
        }),
      );
      const events = await publicClient.getContractEvents({
        address: factory.address,
        abi: factory.abi,
        eventName: "TokenSuiteDeployed",
        fromBlock,
        strict: true,
      });
      assert.equal(events.length, 0);
    }
  });
});
