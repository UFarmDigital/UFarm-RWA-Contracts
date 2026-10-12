// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IOnchainID} from "./IOnchainID.sol";

/// @title Identity Factory Interface
/// @author UFarm Digital
/// @notice Deploys OnchainID identities (optionally via CREATE2).
/// @dev Used by platform to create issuer/asset identities and investor identities when needed.
interface IIdFactory {
    /// @notice Emitted when an identity is deployed.
    /// @param identity Deployed identity address.
    /// @param owner Identity owner address.
    /// @param salt Salt used for deployment.
    event IdentityDeployed(address indexed identity, address indexed owner, bytes32 salt);

    /// @notice Deploys a new identity.
    /// @param owner Identity owner/controller.
    /// @param salt Salt for deterministic deploys (optional usage).
    /// @return identity Deployed identity contract.
    function deployIdentity(address owner, bytes32 salt) external returns (IOnchainID identity);

    /// @notice Computes expected identity address for owner+salt (if CREATE2 is used).
    /// @param owner Identity owner address.
    /// @param salt Salt for deterministic deploys.
    /// @return predicted Predicted identity address.
    function predictIdentityAddress(address owner, bytes32 salt) external view returns (address predicted);
}
