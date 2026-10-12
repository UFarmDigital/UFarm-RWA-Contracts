// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PrivateCreditValueAggregator} from "../impl/PrivateCreditValueAggregator.sol";

contract PrivateCreditValueAggregatorV2 is PrivateCreditValueAggregator {
    function versionV2() external pure returns (string memory) {
        return "v2";
    }
}
