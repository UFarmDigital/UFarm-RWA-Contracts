import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ONE_TOKEN = 10n ** 18n;
const ONE_STABLE = 10n ** 6n;

describe("SaleFixPrice", async function () {
  const { viem } = await network.connect();
  const [owner, buyer, outsider] = await viem.getWalletClients();

  const deployToken = async (name: string, symbol: string, decimals: number) =>
    viem.deployContract("MockERC20", [name, symbol, decimals]);

  const deploySale = async () => {
    const asset = await deployToken("UFarm Asset", "UFARM", 18);
    const usdc = await deployToken("USD Coin", "USDC", 6);
    const usdt = await deployToken("Tether USD", "USDT", 6);
    const unsupported = await deployToken("Dai Stablecoin", "DAI", 18);

    const saleImpl = await viem.deployContract("SaleFixPrice");
    const saleProxy = await viem.deployContract("TestERC1967Proxy", [saleImpl.address, "0x"]);
    const sale = await viem.getContractAt("SaleFixPrice", saleProxy.address);

    await sale.write.initialize([owner.account.address, asset.address, [usdc.address, usdt.address]], {
      account: owner.account,
    });

    return { asset, usdc, usdt, unsupported, sale, saleImpl };
  };

  it("initializes with sale token and stablecoin allowlist", async function () {
    const { asset, usdc, usdt, sale } = await deploySale();

    assert.equal((await sale.read.token()).toLowerCase(), asset.address.toLowerCase());
    assert.deepEqual(
      (await sale.read.getStablecoins()).map((address: string) => address.toLowerCase()),
      [usdc.address.toLowerCase(), usdt.address.toLowerCase()],
    );
    assert.equal(await sale.read.isStablecoin([usdc.address]), true);
    assert.equal(await sale.read.isStablecoin([asset.address]), false);
  });

  it("rejects invalid initialization", async function () {
    const asset = await deployToken("UFarm Asset", "UFARM", 18);
    const usdc = await deployToken("USD Coin", "USDC", 6);

    const deployUninitializedSale = async () => {
      const saleImpl = await viem.deployContract("SaleFixPrice");
      const saleProxy = await viem.deployContract("TestERC1967Proxy", [saleImpl.address, "0x"]);
      return viem.getContractAt("SaleFixPrice", saleProxy.address);
    };

    await assert.rejects(async () => {
      const sale = await deployUninitializedSale();
      await sale.write.initialize([ZERO_ADDRESS, asset.address, [usdc.address]], { account: owner.account });
    });

    await assert.rejects(async () => {
      const sale = await deployUninitializedSale();
      await sale.write.initialize([owner.account.address, ZERO_ADDRESS, [usdc.address]], { account: owner.account });
    });

    await assert.rejects(async () => {
      const sale = await deployUninitializedSale();
      await sale.write.initialize([owner.account.address, asset.address, []], { account: owner.account });
    });

    await assert.rejects(async () => {
      const sale = await deployUninitializedSale();
      await sale.write.initialize([owner.account.address, asset.address, [ZERO_ADDRESS]], { account: owner.account });
    });

    await assert.rejects(async () => {
      const sale = await deployUninitializedSale();
      await sale.write.initialize([owner.account.address, asset.address, [usdc.address, usdc.address]], {
        account: owner.account,
      });
    });

    await assert.rejects(async () => {
      const sale = await deployUninitializedSale();
      await sale.write.initialize([owner.account.address, asset.address, [asset.address]], { account: owner.account });
    });

    const highDecimalToken = await deployToken("High Decimal", "HIGH", 25);
    await assert.rejects(async () => {
      const sale = await deployUninitializedSale();
      await sale.write.initialize([owner.account.address, highDecimalToken.address, [usdc.address]], {
        account: owner.account,
      });
    }, /DecimalDifferenceTooLarge/);
  });

  it("buys and sells with decimal-normalized stablecoins", async function () {
    const { asset, usdc, usdt, sale } = await deploySale();

    await asset.write.mint([owner.account.address, 1_000n * ONE_TOKEN]);
    await usdc.write.mint([buyer.account.address, 1_000n * ONE_STABLE]);
    await usdt.write.mint([buyer.account.address, 1_000n * ONE_STABLE]);

    await asset.write.approve([sale.address, 500n * ONE_TOKEN], { account: owner.account });
    await sale.write.deposit([500n * ONE_TOKEN, asset.address], { account: owner.account });

    await usdc.write.approve([sale.address, 10n * ONE_STABLE], { account: buyer.account });
    await sale.write.buyWith([10n * ONE_TOKEN, usdc.address], { account: buyer.account });

    assert.equal(await asset.read.balanceOf([buyer.account.address]), 10n * ONE_TOKEN);
    assert.equal(await usdc.read.balanceOf([sale.address]), 10n * ONE_STABLE);

    await usdt.write.approve([sale.address, 7n * ONE_STABLE], { account: buyer.account });
    await sale.write.buyWith([7n * ONE_TOKEN, usdt.address], { account: buyer.account });

    assert.equal(await asset.read.balanceOf([buyer.account.address]), 17n * ONE_TOKEN);
    assert.equal(await usdt.read.balanceOf([sale.address]), 7n * ONE_STABLE);

    await usdc.write.mint([owner.account.address, 100n * ONE_STABLE]);
    await usdc.write.approve([sale.address, 100n * ONE_STABLE], { account: owner.account });
    await sale.write.deposit([100n * ONE_STABLE, usdc.address], { account: owner.account });

    await asset.write.approve([sale.address, 3n * ONE_TOKEN], { account: buyer.account });
    await sale.write.sellFor([3n * ONE_TOKEN, usdc.address], { account: buyer.account });

    assert.equal(await asset.read.balanceOf([buyer.account.address]), 14n * ONE_TOKEN);
    assert.equal(await usdc.read.balanceOf([buyer.account.address]), 993n * ONE_STABLE);
  });

  it("rejects non-representable token amounts", async function () {
    const { usdc, sale } = await deploySale();

    await assert.rejects(() => sale.write.buyWith([1n, usdc.address], { account: buyer.account }));
    await assert.rejects(() => sale.write.sellFor([1n, usdc.address], { account: buyer.account }));
  });

  it("restricts liquidity management to the owner", async function () {
    const { asset, usdc, sale } = await deploySale();

    await asset.write.mint([owner.account.address, 10n * ONE_TOKEN]);
    await usdc.write.mint([owner.account.address, 10n * ONE_STABLE]);
    await asset.write.approve([sale.address, 10n * ONE_TOKEN], { account: owner.account });
    await usdc.write.approve([sale.address, 10n * ONE_STABLE], { account: owner.account });

    await assert.rejects(() => sale.write.deposit([1n * ONE_TOKEN, asset.address], { account: outsider.account }));
    await assert.rejects(() => sale.write.withdraw([1n * ONE_TOKEN, asset.address], { account: outsider.account }));

    await sale.write.deposit([10n * ONE_TOKEN, asset.address], { account: owner.account });
    await sale.write.deposit([10n * ONE_STABLE, usdc.address], { account: owner.account });

    await sale.write.withdraw([4n * ONE_TOKEN, asset.address], { account: owner.account });
    await sale.write.withdraw([4n * ONE_STABLE, usdc.address], { account: owner.account });

    assert.equal(await asset.read.balanceOf([sale.address]), 6n * ONE_TOKEN);
    assert.equal(await usdc.read.balanceOf([sale.address]), 6n * ONE_STABLE);
  });

  it("rejects unsupported liquidity tokens", async function () {
    const { unsupported, sale } = await deploySale();

    await unsupported.write.mint([owner.account.address, 10n * ONE_TOKEN]);
    await unsupported.write.approve([sale.address, 10n * ONE_TOKEN], { account: owner.account });

    await assert.rejects(() => sale.write.deposit([1n * ONE_TOKEN, unsupported.address], { account: owner.account }));
    await assert.rejects(() => sale.write.withdraw([1n * ONE_TOKEN, unsupported.address], { account: owner.account }));
    await assert.rejects(() => sale.write.buyWith([1n * ONE_TOKEN, unsupported.address], { account: buyer.account }));
    await assert.rejects(() => sale.write.sellFor([1n * ONE_TOKEN, unsupported.address], { account: buyer.account }));
  });

  it("lets the owner pause swaps and disable a stablecoin", async function () {
    const { asset, usdc, sale } = await deploySale();
    await asset.write.mint([owner.account.address, ONE_TOKEN]);
    await asset.write.approve([sale.address, ONE_TOKEN], { account: owner.account });
    await sale.write.deposit([ONE_TOKEN, asset.address], { account: owner.account });

    await assert.rejects(() => sale.write.pause({ account: outsider.account }));
    await sale.write.pause({ account: owner.account });
    await assert.rejects(() => sale.write.buyWith([ONE_TOKEN, usdc.address], { account: buyer.account }));
    await sale.write.unpause({ account: owner.account });
    await assert.rejects(() => sale.write.disableStablecoin([usdc.address], { account: outsider.account }));
    await sale.write.disableStablecoin([usdc.address], { account: owner.account });
    assert.equal(await sale.read.isStablecoin([usdc.address]), false);
    await assert.rejects(() => sale.write.buyWith([ONE_TOKEN, usdc.address], { account: buyer.account }));
    await assert.rejects(() => sale.write.sellFor([ONE_TOKEN, usdc.address], { account: buyer.account }));
  });

  it("supports owner-authorized UUPS upgrades", async function () {
    const { sale } = await deploySale();
    const v2Impl = await viem.deployContract("SaleFixPriceV2");

    await assert.rejects(() => sale.write.upgradeToAndCall([v2Impl.address, "0x"], { account: outsider.account }));
    await assert.rejects(() => sale.write.upgradeToAndCall([ZERO_ADDRESS, "0x"], { account: owner.account }));

    await sale.write.upgradeToAndCall([v2Impl.address, "0x"], { account: owner.account });

    const saleV2 = await viem.getContractAt("SaleFixPriceV2", sale.address);
    assert.equal(await saleV2.read.versionV2(), "v2");
  });
});
