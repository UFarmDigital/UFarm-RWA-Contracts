// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title Test ERC1967 Proxy
/// @author UFarm Digital
/// @notice Test helper to deploy ERC1967 proxies in Hardhat tests.
contract TestERC1967Proxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}

    function _unsafeAllowUninitialized() internal pure override returns (bool) {
        return true;
    }
}
