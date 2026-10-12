// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IOnchainID} from "./IOnchainID.sol";

/// @title Claim Issuer Interface
/// @author UFarm Digital
/// @notice Validates ONCHAINID claims.
interface IClaimIssuer {
    /// @notice Returns whether a claim is valid for an identity.
    /// @param identity Identity containing the claim.
    /// @param claimTopic Claim topic identifier.
    /// @param signature Claim signature.
    /// @param data Claim data.
    /// @return claimValid Whether the claim is valid.
    function isClaimValid(
        IOnchainID identity,
        uint256 claimTopic,
        bytes calldata signature,
        bytes calldata data
    ) external view returns (bool claimValid);
}
