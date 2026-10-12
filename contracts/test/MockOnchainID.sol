// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IOnchainID} from "../interfaces/IOnchainID.sol";

/// @title Mock OnchainID
/// @author UFarm Digital
/// @notice Test helper to simulate ERC-735 claims for identities.
contract MockOnchainID is IOnchainID {
    error MockClaimReadFailed();

    struct Claim {
        uint256 topic;
        address issuer;
        bytes data;
    }

    mapping(bytes32 => Claim) private _claims;
    mapping(uint256 => bytes32[]) private _claimIdsByTopic;
    mapping(bytes32 => bool) private _claimExists;
    bool private _revertClaimIds;
    bool private _revertClaim;

    /// @notice Sets deterministic claim accessor failure modes.
    /// @param revertClaimIds Whether claim ID enumeration reverts.
    /// @param revertClaim Whether claim reads revert.
    function setFailureModes(bool revertClaimIds, bool revertClaim) external {
        _revertClaimIds = revertClaimIds;
        _revertClaim = revertClaim;
    }

    /// @notice Sets claim validity for a topic/issuer pair.
    /// @param topic Claim topic.
    /// @param issuer Claim issuer.
    /// @param valid Whether the claim is valid.
    function setClaim(uint256 topic, address issuer, bool valid) external {
        bytes32 claimId = keccak256(abi.encode(issuer, topic));
        if (!_claimExists[claimId]) _claimIdsByTopic[topic].push(claimId);
        _claims[claimId] = Claim({topic: topic, issuer: issuer, data: abi.encode(valid)});
        _claimExists[claimId] = true;
    }

    /// @notice Returns claim ids for a topic.
    /// @param topic Claim topic identifier.
    /// @return claimIds Claim identifiers.
    function getClaimIdsByTopic(uint256 topic) external view override returns (bytes32[] memory claimIds) {
        if (_revertClaimIds) revert MockClaimReadFailed();
        return _claimIdsByTopic[topic];
    }

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
        override
        returns (
            uint256 topic,
            uint256 scheme,
            address issuer,
            bytes memory signature,
            bytes memory data,
            string memory uri
        )
    {
        if (_revertClaim) revert MockClaimReadFailed();
        Claim storage claim = _claims[claimId];
        return (claim.topic, 1, claim.issuer, "", claim.data, "");
    }
}
