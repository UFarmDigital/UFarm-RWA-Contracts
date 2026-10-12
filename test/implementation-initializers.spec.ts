import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const INVALID_INITIALIZATION_SELECTOR = "0xf92ee8a9";
const privateCreditConditions = {
  minTicket: 0n,
  duration: 0n,
  minPeriod: 0n,
  lockup: 0n,
  apyBps: 0,
  distributionTerms: 0,
  yieldMode: 0,
};
const NO_ORACLE = {
  denominationFeed: ZERO_ADDRESS,
  denominationMaxAge: 0,
  stablecoinFeed: ZERO_ADDRESS,
  stablecoinMaxAge: 0,
  sequencerFeed: ZERO_ADDRESS,
  sequencerGracePeriod: 0,
};

describe("Implementation initializers", async function () {
  const { viem } = await network.connect();
  const [owner] = await viem.getWalletClients();

  const implementations = [
    {
      name: "ERC3643Token",
      args: ["", "", 0, "", ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, []],
    },
    {
      name: "PrivateCreditToken",
      args: [
        "",
        "",
        0,
        "",
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        [],
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        privateCreditConditions,
        NO_ORACLE,
      ],
    },
    {
      name: "TokenFactory",
      args: [
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
      ],
    },
    {
      name: "IdentityRegistry",
      args: [ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, [], owner.account.address],
    },
    { name: "IdentityRegistryStorage", args: [ZERO_ADDRESS, ZERO_ADDRESS] },
    { name: "ClaimTopicsRegistry", args: [ZERO_ADDRESS, []] },
    { name: "TrustedIssuersRegistry", args: [ZERO_ADDRESS, [], []] },
    { name: "Compliance", args: [ZERO_ADDRESS, ZERO_ADDRESS] },
  ];

  for (const { name, args } of implementations) {
    it(`rejects direct initialization of ${name}`, async function () {
      const implementation = await viem.deployContract(name);

      await assert.rejects(
        () => implementation.write.initialize(args, { account: owner.account }),
        (error: Error) => String(error).includes(INVALID_INITIALIZATION_SELECTOR),
      );
    });
  }
});
