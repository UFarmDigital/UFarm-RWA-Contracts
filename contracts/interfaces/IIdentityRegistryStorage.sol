// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IOnchainID} from "./IOnchainID.sol";
import {IERC5313} from "@openzeppelin/contracts/interfaces/IERC5313.sol";

/// @title Identity Registry Storage Interface
/// @author UFarm Digital
/// @notice Stores wallet -> identity bindings and metadata (e.g., country).
/// @dev Designed to be reusable across multiple tokens for a single issuer.
interface IIdentityRegistryStorage is IERC5313 {
    error InvalidIdentity(address identity);

    /// @notice Investor record.
    /// @param identity Identity contract address.
    /// @param country Country code (ISO-3166 numeric or platform-defined).
    struct InvestorData {
        IOnchainID identity;
        uint16 country;
    }

    /// @notice Emitted when an investor record is added or updated.
    /// @param wallet Investor wallet address.
    /// @param identity Identity contract address.
    /// @param country Country code.
    event InvestorStored(address indexed wallet, address indexed identity, uint16 country);

    /// @notice Emitted when an investor record is removed.
    /// @param wallet Investor wallet address.
    event InvestorRemoved(address indexed wallet);

    /// @notice Returns investor data for a wallet.
    /// @param wallet Investor wallet address.
    /// @return data InvestorData record.
    function getInvestor(address wallet) external view returns (InvestorData memory data);

    /// @notice Returns whether a wallet is stored.
    /// @param wallet Investor wallet address.
    /// @return True if stored.
    function contains(address wallet) external view returns (bool);

    /// @notice Stores investor data.
    /// @dev Must be restricted to bound registries/agents in implementation. Identity must be a deployed contract.
    /// @param wallet Wallet address.
    /// @param identity Identity contract.
    /// @param country Country code.
    function storeInvestor(address wallet, IOnchainID identity, uint16 country) external;

    /// @notice Removes investor data.
    /// @dev Must be restricted to bound registries/agents in implementation.
    /// @param wallet Wallet address.
    function removeInvestor(address wallet) external;

    /// @notice Returns all stored investor wallets (may be expensive).
    /// @dev Optional; implementations may omit or paginate.
    /// @return wallets Array of investor wallet addresses.
    function getAllInvestors() external view returns (address[] memory wallets);
}
