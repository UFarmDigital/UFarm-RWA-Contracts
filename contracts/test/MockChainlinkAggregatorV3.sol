// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IChainlinkAggregatorV3} from "../interfaces/IChainlinkAggregatorV3.sol";

contract MockChainlinkAggregatorV3 is IChainlinkAggregatorV3 {
    error MockOracleRevert();

    // Chainlink's ABI requires the lowercase getter name.
    // solhint-disable-next-line immutable-vars-naming
    uint8 public immutable override decimals;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    bool private _shouldRevert;
    bool private _gasSensitive;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function setRoundData(int256 answer_, uint256 startedAt_, uint256 updatedAt_) external {
        _answer = answer_;
        _startedAt = startedAt_;
        _updatedAt = updatedAt_;
    }

    function setShouldRevert(bool value) external {
        _shouldRevert = value;
    }

    function setGasSensitive(bool value) external {
        _gasSensitive = value;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        if (_shouldRevert) revert MockOracleRevert();
        int256 answer = _gasSensitive ? _answer + int256(gasleft()) : _answer;
        return (1, answer, _startedAt, _updatedAt, 1);
    }
}
