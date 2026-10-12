import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

import { deployUpgradeable } from "./helpers/deploy-upgradeable";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("Compliance", async function () {
  const { viem } = await network.connect();
  const [owner, other] = await viem.getWalletClients();

  it("binds a token and allows bound calls", async function () {
    const { contract: compliance } = await deployUpgradeable(viem, "Compliance");
    await compliance.write.initialize([owner.account.address, owner.account.address], { account: owner.account });
    const token = await viem.deployContract("MockBoundToken");

    await compliance.write.bindToken([token.address], { account: owner.account });

    assert.equal(await compliance.read.isTokenBound([token.address]), true);

    assert.equal(
      await token.read.canTransfer([compliance.address, owner.account.address, other.account.address, 1n]),
      true,
    );

    await token.write.transferred([compliance.address, owner.account.address, other.account.address, 1n]);
    await token.write.created([compliance.address, other.account.address, 1n]);
    await token.write.destroyed([compliance.address, owner.account.address, 1n]);

    await compliance.write.unbindToken([token.address], { account: owner.account });
  });

  it("rejects unbound token callers and non-owner binds", async function () {
    const { contract: compliance } = await deployUpgradeable(viem, "Compliance");
    await compliance.write.initialize([owner.account.address, owner.account.address], { account: owner.account });
    const token = await viem.deployContract("MockBoundToken");

    await assert.rejects(() => compliance.write.bindToken([token.address], { account: other.account }));

    await assert.rejects(() =>
      token.read.canTransfer([compliance.address, owner.account.address, other.account.address, 1n]),
    );

    await assert.rejects(() => compliance.write.bindToken([ZERO_ADDRESS], { account: owner.account }));
  });
});
