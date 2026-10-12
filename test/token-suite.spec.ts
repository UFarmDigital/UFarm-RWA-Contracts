import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

import { deployUpgradeable } from "./helpers/deploy-upgradeable";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const deploySuite = async (viem: any, accounts: any, bindCompliance = true, complianceOverride?: any) => {
  const [owner, agent] = accounts;
  const claimIssuer = await viem.deployContract("MockClaimIssuer");

  const { contract: claimTopics } = await deployUpgradeable(viem, "ClaimTopicsRegistry");
  await claimTopics.write.initialize([owner.account.address, [1n]], {
    account: owner.account,
  });
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

  await storage.write.bindRegistry([identityRegistry.address], {
    account: owner.account,
  });

  const { contract: compliance } = complianceOverride
    ? { contract: complianceOverride }
    : await deployUpgradeable(viem, "Compliance");
  if (!complianceOverride) {
    await compliance.write.initialize([owner.account.address, owner.account.address], { account: owner.account });
  }
  const tokenImpl = await viem.deployContract("ERC3643Token");
  const tokenProxy = await viem.deployContract("TestERC1967Proxy", [tokenImpl.address, "0x"]);
  const token = await viem.getContractAt("ERC3643Token", tokenProxy.address);

  await token.write.initialize(
    [
      "UFarm Asset",
      "UFARM",
      18,
      "1",
      owner.account.address,
      identityRegistry.address,
      compliance.address,
      [agent.account.address],
    ],
    { account: owner.account },
  );
  await identityRegistry.write.bindToken([token.address], { account: owner.account });
  if (bindCompliance) {
    await compliance.write.bindToken([token.address], { account: owner.account });
  }

  return { token, compliance, identityRegistry, storage, claimTopics, trustedIssuers };
};

describe("Token Suite (ERC-3643)", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [owner, agent, investorA, investorB, issuer, outsider] = await viem.getWalletClients();

  const registerInvestor = async (identityRegistry: any, identity: any, wallet: string, agentAccount: any) => {
    await identityRegistry.write.registerIdentity([wallet, identity.address, 840], {
      account: agentAccount,
    });
  };

  const setupVerifiedInvestors = async (identityRegistry: any) => {
    const trustedIssuers = await viem.getContractAt(
      "TrustedIssuersRegistry",
      await identityRegistry.read.trustedIssuersRegistry(),
    );
    const [claimIssuer] = await trustedIssuers.read.getTrustedIssuers();
    const identityA = await viem.deployContract("MockOnchainID");
    const identityB = await viem.deployContract("MockOnchainID");

    await identityA.write.setClaim([1n, claimIssuer, true]);
    await identityB.write.setClaim([1n, claimIssuer, true]);

    await registerInvestor(identityRegistry, identityA, investorA.account.address, agent.account);
    await registerInvestor(identityRegistry, identityB, investorB.account.address, agent.account);

    return { identityA, identityB };
  };

  it("mints and transfers between verified investors", async function () {
    const { token, compliance, identityRegistry } = await deploySuite(viem, [owner, agent, issuer]);

    await setupVerifiedInvestors(identityRegistry);

    await token.write.mint([investorA.account.address, 1_000n], { account: agent.account });

    assert.equal(await token.read.balanceOf([investorA.account.address]), 1_000n);

    await token.write.transfer([investorB.account.address, 250n], {
      account: investorA.account,
    });

    assert.equal(await token.read.balanceOf([investorB.account.address]), 250n);
    assert.equal(await compliance.read.isTokenBound([token.address]), true);
  });

  it("requires production compliance binding for mint, transfer, and burn hooks", async function () {
    const { token, compliance, identityRegistry } = await deploySuite(viem, [owner, agent, issuer], false);
    await setupVerifiedInvestors(identityRegistry);

    await assert.rejects(() => token.write.mint([investorA.account.address, 2n], { account: agent.account }));

    await compliance.write.bindToken([token.address], { account: owner.account });
    await token.write.mint([investorA.account.address, 2n], { account: agent.account });
    await token.write.transfer([investorB.account.address, 1n], { account: investorA.account });
    await token.write.burn([investorB.account.address, 1n], { account: agent.account });
    assert.equal(await token.read.balanceOf([investorB.account.address]), 0n);
  });

  it("blocks transfers to unverified recipients", async function () {
    const { token, identityRegistry } = await deploySuite(viem, [owner, agent, issuer]);

    await setupVerifiedInvestors(identityRegistry);

    await token.write.mint([investorA.account.address, 100n], { account: agent.account });

    await assert.rejects(() =>
      token.write.transfer([outsider.account.address, 10n], {
        account: investorA.account,
      }),
    );
  });

  it("enforces compliance decisions", async function () {
    const compliance = await viem.deployContract("MockCompliance");
    const { token, identityRegistry } = await deploySuite(viem, [owner, agent, issuer], true, compliance);

    await setupVerifiedInvestors(identityRegistry);

    await token.write.mint([investorA.account.address, 100n], { account: agent.account });

    await compliance.write.setAllowTransfers([false]);

    await assert.rejects(() =>
      token.write.transfer([investorB.account.address, 10n], {
        account: investorA.account,
      }),
    );
  });

  it("pauses and freezes transfers", async function () {
    const { token, identityRegistry } = await deploySuite(viem, [owner, agent, issuer]);

    await setupVerifiedInvestors(identityRegistry);

    await token.write.mint([investorA.account.address, 100n], { account: agent.account });

    await token.write.pause({ account: agent.account });

    await assert.rejects(() =>
      token.write.transfer([investorB.account.address, 1n], {
        account: investorA.account,
      }),
    );

    await token.write.unpause({ account: agent.account });

    await token.write.setAddressFrozen([investorA.account.address, true], {
      account: agent.account,
    });

    await assert.rejects(() =>
      token.write.transfer([investorB.account.address, 1n], {
        account: investorA.account,
      }),
    );
  });

  it("handles partial freezes and forced transfers", async function () {
    const { token, identityRegistry } = await deploySuite(viem, [owner, agent, issuer]);

    await setupVerifiedInvestors(identityRegistry);

    await token.write.mint([investorA.account.address, 100n], { account: agent.account });

    await token.write.freezePartialTokens([investorA.account.address, 80n], {
      account: agent.account,
    });

    await assert.rejects(() =>
      token.write.transfer([investorB.account.address, 30n], {
        account: investorA.account,
      }),
    );

    await token.write.forcedTransfer([investorA.account.address, investorB.account.address, 30n], {
      account: agent.account,
    });

    assert.equal(await token.read.balanceOf([investorB.account.address]), 30n);
  });

  it("clamps frozen tokens after a forced transfer drains the wallet", async function () {
    const { token, identityRegistry } = await deploySuite(viem, [owner, agent, issuer]);
    await setupVerifiedInvestors(identityRegistry);
    await token.write.mint([investorA.account.address, 100n], { account: agent.account });
    await token.write.freezePartialTokens([investorA.account.address, 100n], { account: agent.account });
    await token.write.forcedTransfer([investorA.account.address, investorB.account.address, 100n], {
      account: agent.account,
    });
    await token.write.mint([investorA.account.address, 50n], { account: agent.account });
    await token.write.transfer([investorB.account.address, 50n], { account: investorA.account });
    assert.equal(await token.read.balanceOf([investorA.account.address]), 0n);
  });

  it("recovers addresses through identity registry", async function () {
    const { token, identityRegistry } = await deploySuite(viem, [owner, agent, issuer]);

    await setupVerifiedInvestors(identityRegistry);
    await identityRegistry.write.removeIdentity([investorB.account.address], { account: agent.account });

    await token.write.mint([investorA.account.address, 100n], { account: agent.account });

    await token.write.recoveryAddress([investorA.account.address, investorB.account.address], {
      account: agent.account,
    });

    assert.equal(await token.read.balanceOf([investorB.account.address]), 100n);
  });

  it("recovers only unfrozen tokens and leaves partial freeze state on the old wallet", async function () {
    const { token, identityRegistry } = await deploySuite(viem, [owner, agent, issuer]);

    await setupVerifiedInvestors(identityRegistry);
    await identityRegistry.write.removeIdentity([investorB.account.address], { account: agent.account });
    await token.write.mint([investorA.account.address, 100n], { account: agent.account });
    await token.write.freezePartialTokens([investorA.account.address, 80n], { account: agent.account });

    await token.write.recoveryAddress([investorA.account.address, investorB.account.address], {
      account: agent.account,
    });

    assert.equal(await token.read.balanceOf([investorA.account.address]), 80n);
    assert.equal(await token.read.balanceOf([investorB.account.address]), 20n);
    await assert.rejects(() => token.write.transfer([investorB.account.address, 1n], { account: investorA.account }));
    await token.write.unfreezePartialTokens([investorA.account.address, 80n], { account: agent.account });
    await token.write.transfer([investorB.account.address, 80n], { account: investorA.account });
  });

  it("supports batch ops and UUPS upgrade", async function () {
    const { token, identityRegistry } = await deploySuite(viem, [owner, agent, issuer]);

    await setupVerifiedInvestors(identityRegistry);

    await assert.rejects(() =>
      token.write.batchMint([[investorA.account.address, investorB.account.address], [1n]], { account: agent.account }),
    );

    await token.write.batchMint(
      [
        [investorA.account.address, investorB.account.address],
        [10n, 20n],
      ],
      { account: agent.account },
    );

    assert.equal(await token.read.totalSupply(), 30n);

    const v2Impl = await viem.deployContract("ERC3643TokenV2");
    await token.write.upgradeToAndCall([v2Impl.address, "0x"], {
      account: owner.account,
    });

    const tokenV2 = await viem.getContractAt("ERC3643TokenV2", token.address);
    assert.equal(await tokenV2.read.versionV2(), "v2");
    assert.equal(await tokenV2.read.balanceOf([investorA.account.address]), 10n);
  });

  it("rejects zero-address initialization", async function () {
    const tokenImpl = await viem.deployContract("ERC3643Token");
    const tokenProxy = await viem.deployContract("TestERC1967Proxy", [tokenImpl.address, "0x"]);
    const token = await viem.getContractAt("ERC3643Token", tokenProxy.address);

    await assert.rejects(() =>
      token.write.initialize(
        ["UFarm Asset", "UFARM", 18, "1", ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, [agent.account.address]],
        { account: owner.account },
      ),
    );
  });

  it("emits transfer events on batch operations", async function () {
    const { token, identityRegistry } = await deploySuite(viem, [owner, agent, issuer]);

    await setupVerifiedInvestors(identityRegistry);

    const deploymentBlock = await publicClient.getBlockNumber();

    await token.write.batchMint(
      [
        [investorA.account.address, investorB.account.address],
        [10n, 20n],
      ],
      { account: agent.account },
    );

    const events = await publicClient.getContractEvents({
      address: token.address,
      abi: token.abi,
      eventName: "Transfer",
      fromBlock: deploymentBlock,
      strict: true,
    });

    assert.equal(events.length, 2);
  });
});
