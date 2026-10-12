// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PrivateCreditToken} from "../impl/PrivateCreditToken.sol";

/// @title Private Credit Token V2
/// @notice Test implementation used to validate UUPS upgrades.
contract PrivateCreditTokenV2 is PrivateCreditToken {
    function versionV2() external pure returns (string memory) {
        return "v2";
    }
}
