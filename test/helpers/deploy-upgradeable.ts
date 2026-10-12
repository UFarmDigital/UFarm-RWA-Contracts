export async function deployUpgradeable(viem: any, contractName: string) {
  const implementation = await viem.deployContract(contractName);
  const proxy = await viem.deployContract("TestERC1967Proxy", [implementation.address, "0x"]);
  const contract = await viem.getContractAt(contractName, proxy.address);
  return { implementation, proxy, contract };
}
