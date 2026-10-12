// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC5313} from "@openzeppelin/contracts/interfaces/IERC5313.sol";

import {IIdentityRegistryStorage} from "../interfaces/IIdentityRegistryStorage.sol";
import {IOnchainID} from "../interfaces/IOnchainID.sol";
import {AlreadyBound, NotBoundToken, NotFound, NotOwnerOrFactory, ZeroAddress} from "../lib/Errors.sol";

/// @title Identity Registry Storage
/// @author UFarm Digital
/// @notice Stores wallet to identity bindings and metadata.
contract IdentityRegistryStorage is Initializable, OwnableUpgradeable, UUPSUpgradeable, IIdentityRegistryStorage {
    mapping(address => InvestorData) private _investor;
    mapping(address => bool) private _contains;
    address[] private _wallets;
    mapping(address => uint256) private _indexPlus1;
    mapping(address => bool) private _boundRegistries;
    address private _factory;

    /// @notice Emitted when a registry is bound.
    /// @param registry Registry address.
    event RegistryBound(address indexed registry);

    /// @notice Emitted when a registry is unbound.
    /// @param registry Registry address.
    event RegistryUnbound(address indexed registry);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the storage contract.
    /// @param owner_ Initial owner address.
    /// @param factory_ Factory allowed to bind registries.
    function initialize(address owner_, address factory_) external initializer {
        if (owner_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        _factory = factory_;
    }

    /// @notice Returns the storage contract owner.
    function owner() public view override(OwnableUpgradeable, IERC5313) returns (address) {
        return super.owner();
    }

    /// @notice Binds a registry to allow mutations.
    /// @param registry Registry address.
    function bindRegistry(address registry) external onlyOwnerOrFactory {
        if (registry == address(0)) revert ZeroAddress();
        if (_boundRegistries[registry]) revert AlreadyBound();
        _boundRegistries[registry] = true;
        emit RegistryBound(registry);
    }

    /// @notice Unbinds a registry to revoke mutations.
    /// @param registry Registry address.
    function unbindRegistry(address registry) external onlyOwner {
        if (!_boundRegistries[registry]) revert NotFound();
        _boundRegistries[registry] = false;
        emit RegistryUnbound(registry);
    }

    /// @notice Returns investor data for a wallet.
    /// @param wallet Investor wallet address.
    /// @return data InvestorData record.
    function getInvestor(address wallet) external view override returns (InvestorData memory data) {
        return _investor[wallet];
    }

    /// @notice Returns whether a wallet is stored.
    /// @param wallet Investor wallet address.
    /// @return True if stored.
    function contains(address wallet) external view override returns (bool) {
        return _contains[wallet];
    }

    /// @notice Stores investor data.
    /// @param wallet Wallet address.
    /// @param identity Identity contract.
    /// @param country Country code.
    function storeInvestor(address wallet, IOnchainID identity, uint16 country) external override onlyAuthorized {
        if (wallet == address(0) || address(identity) == address(0)) revert ZeroAddress();
        if (address(identity).code.length == 0) revert InvalidIdentity(address(identity));
        _investor[wallet] = InvestorData({identity: identity, country: country});
        if (!_contains[wallet]) {
            _contains[wallet] = true;
            _wallets.push(wallet);
            _indexPlus1[wallet] = _wallets.length;
        }
        emit InvestorStored(wallet, address(identity), country);
    }

    /// @notice Removes investor data.
    /// @param wallet Wallet address.
    function removeInvestor(address wallet) external override onlyAuthorized {
        if (!_contains[wallet]) revert NotFound();
        delete _investor[wallet];
        _contains[wallet] = false;
        _removeWallet(wallet);
        emit InvestorRemoved(wallet);
    }

    /// @notice Returns all stored investor wallets (may be expensive).
    /// @return wallets Array of investor wallet addresses.
    function getAllInvestors() external view override returns (address[] memory wallets) {
        return _wallets;
    }

    /// @notice Returns the configured factory address.
    /// @return factoryAddress Factory address.
    function factory() external view returns (address factoryAddress) {
        return _factory;
    }

    /// @dev Restricts to owner or configured factory.
    modifier onlyOwnerOrFactory() {
        if (msg.sender != owner() && msg.sender != _factory) revert NotOwnerOrFactory();
        _;
    }

    /// @dev Restricts to bound registries or owner/factory.
    modifier onlyAuthorized() {
        if (!_boundRegistries[msg.sender] && msg.sender != owner() && msg.sender != _factory) revert NotBoundToken();
        _;
    }

    /// @notice Removes wallet from the enumeration using swap-and-pop.
    /// @param wallet Wallet address.
    function _removeWallet(address wallet) internal {
        uint256 index = _indexPlus1[wallet];
        if (index == 0) return;
        uint256 lastIndex = _wallets.length;
        if (index != lastIndex) {
            address lastWallet = _wallets[lastIndex - 1];
            _wallets[index - 1] = lastWallet;
            _indexPlus1[lastWallet] = index;
        }
        _wallets.pop();
        delete _indexPlus1[wallet];
    }

    /// @notice Authorizes a UUPS upgrade.
    /// @param newImplementation New implementation address.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /// @dev Storage gap for upgrade safety.
    // slither-disable-next-line naming-convention,unused-state
    uint256[48] private __gap;
}
