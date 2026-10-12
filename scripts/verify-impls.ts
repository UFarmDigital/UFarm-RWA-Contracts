import fs from "node:fs/promises";
import path from "node:path";
import hre from "hardhat";

const IMPLEMENTATION_KEYS = [
  "DeployPlatform#TokenFactory",
  "DeployPlatform#ERC3643Token",
  "DeployPlatform#IdentityRegistry",
  "DeployPlatform#IdentityRegistryStorage",
  "DeployPlatform#ClaimTopicsRegistry",
  "DeployPlatform#TrustedIssuersRegistry",
  "DeployPlatform#Compliance",
];

type CliArgs = {
  address?: string;
  contract?: string;
  argsPath?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--address") args.address = value;
    if (argv[i] === "--contract") args.contract = value;
    if (argv[i] === "--args") args.argsPath = value;
  }
  return args;
}

async function loadConstructorArgs(argsPath?: string): Promise<unknown[]> {
  if (!argsPath) return [];
  const raw = await fs.readFile(argsPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected constructor args JSON array in ${argsPath}`);
  }
  return parsed;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.address || cli.contract || cli.argsPath) {
    if (!cli.address || !cli.contract) {
      throw new Error("Usage: --address <0x...> --contract <path:ContractName> [--args <file.json>]");
    }
    const constructorArguments = await loadConstructorArgs(cli.argsPath);
    await hre.tasks.getTask("verify").run({
      address: cli.address,
      contract: cli.contract,
      constructorArgs: constructorArguments,
    });
    console.log(`[verify] ${cli.contract} ${cli.address}`);
    return;
  }

  const connection = await hre.network.connect();
  const chainIdHex = (await connection.provider.request({
    method: "eth_chainId",
  })) as string;
  const chainId = Number.parseInt(chainIdHex, 16);

  const deploymentId = `chain-${chainId}`;
  const deploymentsDir = path.join(hre.config.paths.ignition, "deployments", deploymentId);
  const addressesPath = path.join(deploymentsDir, "deployed_addresses.json");

  const raw = await fs.readFile(addressesPath, "utf8");
  const deployed = JSON.parse(raw) as Record<string, string>;

  const targets = IMPLEMENTATION_KEYS.map((key) => ({ key, address: deployed[key] })).filter((entry) => entry.address);

  if (targets.length === 0) {
    throw new Error(`No implementation addresses found in ${addressesPath}`);
  }

  for (const target of targets) {
    try {
      await hre.tasks.getTask("verify").run({
        address: target.address,
        constructorArgs: [],
      });
      console.log(`[verify] ${target.key} ${target.address}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[verify:skip] ${target.key} ${target.address} -> ${message}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
