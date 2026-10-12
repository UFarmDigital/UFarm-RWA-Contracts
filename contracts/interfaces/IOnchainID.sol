// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title Onchain Identity (ONCHAINID) Interface (ERC-734/735 style)
/// @author UFarm Digital
/// @notice Minimal interface used by registries to validate identity claims.
interface IOnchainID {
    /// @notice Returns claim ids for a topic.
    /// @param topic Claim topic identifier.
    /// @return claimIds Claim identifiers.
    function getClaimIdsByTopic(uint256 topic) external view returns (bytes32[] memory claimIds);

    /// @notice Returns a claim by identifier.
    /// @param claimId Claim identifier.
    /// @return topic Claim topic identifier.
    /// @return scheme Claim scheme.
    /// @return issuer Claim issuer address.
    /// @return signature Claim signature.
    /// @return data Claim data.
    /// @return uri Claim URI.
    function getClaim(
        bytes32 claimId
    )
        external
        view
        returns (
            uint256 topic,
            uint256 scheme,
            address issuer,
            bytes memory signature,
            bytes memory data,
            string memory uri
        );
}
