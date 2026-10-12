import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

import { deployUpgradeable } from "./helpers/deploy-upgradeable";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const deployIdentityStack = async (
  viem: any,
  params: {
    owner: any;
    agent: any;
    issuers: `0x${string}`[];
    issuerTopics: bigint[][];
    requiredTopics: bigint[];
  },
) => {
  const { contract: storage } = await deployUpgradeable(viem, "IdentityRegistryStorage");
  await storage.write.initialize([params.owner.account.address, params.owner.account.address], {
    account: params.owner.account,
  });
  const { contract: claimTopics } = await deployUpgradeable(viem, "ClaimTopicsRegistry");
  await claimTopics.write.initialize([params.owner.account.address, params.requiredTopics], {
    account: params.owner.account,
  });
  const { contract: trustedIssuers } = await deployUpgradeable(viem, "TrustedIssuersRegistry");
  await trustedIssuers.write.initialize([params.owner.account.address, params.issuers, params.issuerTopics], {
    account: params.owner.account,
  });
  const { contract: identityRegistry } = await deployUpgradeable(viem, "IdentityRegistry");
  await identityRegistry.write.initialize(
    [
      params.owner.account.address,
      storage.address,
      claimTopics.address,
      trustedIssuers.address,
      [params.agent.account.address],
      params.owner.account.address,
    ],
    { account: params.owner.account },
  );

  await storage.write.bindRegistry([identityRegistry.address], {
    account: params.owner.account,
  });

  return { storage, claimTopics, trustedIssuers, identityRegistry };
};

describe("Identity Registry", async function () {
  const { viem } = await network.connect();
  const [owner, agent, investor, newInvestor, issuer] = await viem.getWalletClients();

  it("verifies a claim from a trusted canonical issuer", async function () {
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    const { identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [claimIssuer.address],
      issuerTopics: [[1n]],
      requiredTopics: [1n],
    });

    const identity = await viem.deployContract("MockOnchainID");
    await identity.write.setClaim([1n, claimIssuer.address, true]);

    await identityRegistry.write.registerIdentity([investor.account.address, identity.address, 840], {
      account: agent.account,
    });

    assert.equal(await identityRegistry.read.isVerified([investor.account.address]), true);
  });

  it("rejects a claim from an untrusted issuer", async function () {
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    const { identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [claimIssuer.address],
      issuerTopics: [[1n]],
      requiredTopics: [1n],
    });

    const identity = await viem.deployContract("MockOnchainID");
    await identity.write.setClaim([1n, issuer.account.address, true]);

    await identityRegistry.write.registerIdentity([investor.account.address, identity.address, 840], {
      account: agent.account,
    });

    assert.equal(await identityRegistry.read.isVerified([investor.account.address]), false);
  });

  it("rejects a claim that a trusted issuer marks invalid", async function () {
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    const { identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [claimIssuer.address],
      issuerTopics: [[1n]],
      requiredTopics: [1n],
    });
    const identity = await viem.deployContract("MockOnchainID");
    await identity.write.setClaim([1n, claimIssuer.address, false]);

    await identityRegistry.write.registerIdentity([investor.account.address, identity.address, 840], {
      account: agent.account,
    });

    assert.equal(await identityRegistry.read.isVerified([investor.account.address]), false);
  });

  it("requires one valid claim for each required topic", async function () {
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    const { identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [claimIssuer.address],
      issuerTopics: [[1n, 2n]],
      requiredTopics: [1n, 2n],
    });
    const identity = await viem.deployContract("MockOnchainID");
    await identity.write.setClaim([1n, claimIssuer.address, true]);

    await identityRegistry.write.registerIdentity([investor.account.address, identity.address, 840], {
      account: agent.account,
    });

    assert.equal(await identityRegistry.read.isVerified([investor.account.address]), false);
  });

  it("verifies registered identities when no claim topics are required", async function () {
    const { identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [],
      issuerTopics: [],
      requiredTopics: [],
    });
    const identity = await viem.deployContract("MockOnchainID");

    await identityRegistry.write.registerIdentity([investor.account.address, identity.address, 840], {
      account: agent.account,
    });

    assert.equal(await identityRegistry.read.isVerified([investor.account.address]), true);
  });

  it("returns false when claim ids cannot be read", async function () {
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    const { identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [claimIssuer.address],
      issuerTopics: [[1n]],
      requiredTopics: [1n],
    });
    const identity = await viem.deployContract("MockOnchainID");
    await identity.write.setClaim([1n, claimIssuer.address, true]);
    await identity.write.setFailureModes([true, false]);
    await identityRegistry.write.registerIdentity([investor.account.address, identity.address, 840], {
      account: agent.account,
    });

    assert.equal(await identityRegistry.read.isVerified([investor.account.address]), false);
  });

  it("returns false when a claim cannot be read", async function () {
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    const { identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [claimIssuer.address],
      issuerTopics: [[1n]],
      requiredTopics: [1n],
    });
    const identity = await viem.deployContract("MockOnchainID");
    await identity.write.setClaim([1n, claimIssuer.address, true]);
    await identity.write.setFailureModes([false, true]);
    await identityRegistry.write.registerIdentity([investor.account.address, identity.address, 840], {
      account: agent.account,
    });

    assert.equal(await identityRegistry.read.isVerified([investor.account.address]), false);
  });

  it("returns false when a trusted issuer cannot validate claims", async function () {
    const incompatibleIssuer = await viem.deployContract("MockOnchainID");
    const { identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [incompatibleIssuer.address],
      issuerTopics: [[1n]],
      requiredTopics: [1n],
    });
    const identity = await viem.deployContract("MockOnchainID");
    await identity.write.setClaim([1n, incompatibleIssuer.address, true]);
    await identityRegistry.write.registerIdentity([investor.account.address, identity.address, 840], {
      account: agent.account,
    });

    assert.equal(await identityRegistry.read.isVerified([investor.account.address]), false);
  });

  it("continues to a valid claim after an incompatible issuer", async function () {
    const incompatibleIssuer = await viem.deployContract("MockOnchainID");
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    const { identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [incompatibleIssuer.address, claimIssuer.address],
      issuerTopics: [[1n], [1n]],
      requiredTopics: [1n],
    });
    const identity = await viem.deployContract("MockOnchainID");
    await identity.write.setClaim([1n, incompatibleIssuer.address, true]);
    await identity.write.setClaim([1n, claimIssuer.address, true]);
    await identityRegistry.write.registerIdentity([investor.account.address, identity.address, 840], {
      account: agent.account,
    });

    assert.equal(await identityRegistry.read.isVerified([investor.account.address]), true);
  });

  it("recovers identity to a new wallet", async function () {
    const { storage, identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [],
      issuerTopics: [],
      requiredTopics: [],
    });

    const identity = await viem.deployContract("MockOnchainID");

    await identityRegistry.write.registerIdentity([investor.account.address, identity.address, 840], {
      account: agent.account,
    });

    await identityRegistry.write.recoverIdentity([investor.account.address, newInvestor.account.address], {
      account: agent.account,
    });

    assert.equal(await storage.read.contains([investor.account.address]), false);
    assert.equal(await storage.read.contains([newInvestor.account.address]), true);
    assert.equal(
      (await identityRegistry.read.investorIdentity([newInvestor.account.address])).toLowerCase(),
      identity.address.toLowerCase(),
    );
  });

  it("rejects recovery over an existing identity", async function () {
    const { storage, identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [],
      issuerTopics: [],
      requiredTopics: [],
    });
    const lostIdentity = await viem.deployContract("MockOnchainID");
    const existingIdentity = await viem.deployContract("MockOnchainID");
    await identityRegistry.write.registerIdentity([investor.account.address, lostIdentity.address, 840], {
      account: agent.account,
    });
    await identityRegistry.write.registerIdentity([newInvestor.account.address, existingIdentity.address, 826], {
      account: agent.account,
    });
    await assert.rejects(
      () =>
        identityRegistry.write.recoverIdentity([investor.account.address, newInvestor.account.address], {
          account: agent.account,
        }),
      /AlreadyExists/,
    );
    assert.equal(await storage.read.contains([investor.account.address]), true);
    assert.equal(
      (await identityRegistry.read.investorIdentity([newInvestor.account.address])).toLowerCase(),
      existingIdentity.address.toLowerCase(),
    );
  });

  it("allows only the factory to bind one token and rejects unbound recovery callers", async function () {
    const { identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [],
      issuerTopics: [],
      requiredTopics: [],
    });
    const identity = await viem.deployContract("MockOnchainID");
    const relay = await viem.deployContract("MockBoundToken");
    const replacementToken = await viem.deployContract("MockOnchainID");

    await identityRegistry.write.registerIdentity([investor.account.address, identity.address, 840], {
      account: agent.account,
    });
    await assert.rejects(() =>
      identityRegistry.write.recoverIdentity([investor.account.address, newInvestor.account.address], {
        account: issuer.account,
      }),
    );
    await assert.rejects(() =>
      relay.write.recoverIdentity([identityRegistry.address, investor.account.address, newInvestor.account.address]),
    );
    assert.equal(
      (await identityRegistry.read.investorIdentity([investor.account.address])).toLowerCase(),
      identity.address.toLowerCase(),
    );
    assert.equal(await identityRegistry.read.investorIdentity([newInvestor.account.address]), ZERO_ADDRESS);
    await assert.rejects(() => identityRegistry.write.bindToken([relay.address], { account: issuer.account }));

    await identityRegistry.write.bindToken([relay.address], { account: owner.account });
    assert.equal((await identityRegistry.read.boundToken()).toLowerCase(), relay.address.toLowerCase());
    await assert.rejects(() =>
      identityRegistry.write.bindToken([replacementToken.address], { account: owner.account }),
    );
  });

  it("rejects no-code identities and issuers at shared configuration boundaries", async function () {
    const { storage, identityRegistry, trustedIssuers } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [],
      issuerTopics: [],
      requiredTopics: [],
    });

    await assert.rejects(
      () =>
        storage.write.storeInvestor([investor.account.address, investor.account.address, 840], {
          account: owner.account,
        }),
      /InvalidIdentity|0x841b5049/,
    );
    await assert.rejects(
      () =>
        identityRegistry.write.registerIdentity([investor.account.address, investor.account.address, 840], {
          account: agent.account,
        }),
      /InvalidIdentity/,
    );
    await assert.rejects(
      () => trustedIssuers.write.addTrustedIssuer([issuer.account.address, [1n]], { account: owner.account }),
      /InvalidTrustedIssuer|0x7e74b2ca/,
    );

    const { contract: freshTrustedIssuers } = await deployUpgradeable(viem, "TrustedIssuersRegistry");
    await assert.rejects(
      () =>
        freshTrustedIssuers.write.initialize([owner.account.address, [issuer.account.address], [[1n]]], {
          account: owner.account,
        }),
      /InvalidTrustedIssuer/,
    );

    const identity = await viem.deployContract("MockOnchainID");
    const claimIssuer = await viem.deployContract("MockClaimIssuer");
    await storage.write.storeInvestor([investor.account.address, identity.address, 840], { account: owner.account });
    await trustedIssuers.write.addTrustedIssuer([claimIssuer.address, [1n]], { account: owner.account });
  });

  it("rejects invalid inputs", async function () {
    const { identityRegistry } = await deployIdentityStack(viem, {
      owner,
      agent,
      issuers: [],
      issuerTopics: [],
      requiredTopics: [],
    });

    const identity = await viem.deployContract("MockOnchainID");

    await assert.rejects(() =>
      identityRegistry.write.registerIdentity([ZERO_ADDRESS, identity.address, 840], { account: agent.account }),
    );
  });
});
