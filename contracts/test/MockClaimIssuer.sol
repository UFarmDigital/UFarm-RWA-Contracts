// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IClaimIssuer} from "../interfaces/IClaimIssuer.sol";
import {IOnchainID} from "../interfaces/IOnchainID.sol";

/// @title Mock Claim Issuer
/// @author UFarm Digital
/// @notice Test helper that validates boolean claim data.
contract MockClaimIssuer is IClaimIssuer {
    /// @inheritdoc IClaimIssuer
    function isClaimValid(
        IOnchainID,
        uint256,
        bytes calldata,
        bytes calldata data
    ) external pure override returns (bool claimValid) {
        return abi.decode(data, (bool));
    }
}
