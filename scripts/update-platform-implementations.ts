import { isAddress } from "viem";
import { network } from "hardhat";

const tokenFactoryProxyValue = process.env.TOKEN_FACTORY_PROXY;

if (!tokenFactoryProxyValue || !isAddress(tokenFactoryProxyValue)) {
  throw new Error("TOKEN_FACTORY_PROXY must be an address");
}
const tokenFactoryProxy = tokenFactoryProxyValue;

async function main() {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [owner] = await viem.getWalletClients();
  const factory = await viem.getContractAt("TokenFactory", tokenFactoryProxy);

  if ((await factory.read.owner()).toLowerCase() !== owner.account.address.toLowerCase()) {
    throw new Error("DEPLOYER_KEY is not the TokenFactory owner");
  }

  const tokenFactoryImplementation = await viem.deployContract("TokenFactory");
  const upgradeHash = await factory.write.upgradeToAndCall([tokenFactoryImplementation.address, "0x"], {
    account: owner.account,
  });
  await publicClient.waitForTransactionReceipt({ hash: upgradeHash });

  const addresses = [
    (await viem.deployContract("ERC3643Token")).address,
    (await viem.deployContract("PrivateCreditToken")).address,
    (await viem.deployContract("IdentityRegistry")).address,
    (await viem.deployContract("IdentityRegistryStorage")).address,
    (await viem.deployContract("ClaimTopicsRegistry")).address,
    (await viem.deployContract("TrustedIssuersRegistry")).address,
    (await viem.deployContract("Compliance")).address,
  ] as const;
  const hash = await factory.write.setImplementations(addresses, { account: owner.account });
  await publicClient.waitForTransactionReceipt({ hash });

  const configured = await factory.read.getImplementations();
  if (!addresses.every((address, index) => address.toLowerCase() === configured[index].toLowerCase())) {
    throw new Error("TokenFactory implementation update did not persist");
  }

  console.log(
    JSON.stringify(
      {
        tokenFactoryProxy,
        tokenFactoryImplementation: tokenFactoryImplementation.address,
        implementations: addresses,
        upgradeHash,
        hash,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
