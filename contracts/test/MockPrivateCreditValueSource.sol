// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

contract MockPrivateCreditValueSource {
    // The source ABI requires the lowercase stablecoin() getter name.
    // solhint-disable-next-line immutable-vars-naming
    address public immutable stablecoin;
    mapping(address => uint256) private _valueOf;

    constructor(address stablecoin_) {
        stablecoin = stablecoin_;
    }

    function setValue(address holder, uint256 value) external {
        _valueOf[holder] = value;
    }

    function totalValueOf(address holder) external view returns (uint256) {
        return _valueOf[holder];
    }
}
