// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC1967Proxy as OZERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Local wrapper to expose OZ ERC1967Proxy as a project artifact for Ignition.
contract ERC1967Proxy is OZERC1967Proxy {
    constructor(address implementation, bytes memory data) OZERC1967Proxy(implementation, data) {}
}
