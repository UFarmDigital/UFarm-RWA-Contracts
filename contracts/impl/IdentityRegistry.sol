// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {AgentRole} from "./AgentRole.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";
import {IIdentityRegistryStorage} from "../interfaces/IIdentityRegistryStorage.sol";
import {IClaimTopicsRegistry} from "../interfaces/IClaimTopicsRegistry.sol";
import {ITrustedIssuersRegistry} from "../interfaces/ITrustedIssuersRegistry.sol";
import {IOnchainID} from "../interfaces/IOnchainID.sol";
import {IClaimIssuer} from "../interfaces/IClaimIssuer.sol";
import {AlreadyBound, AlreadyExists, NotAgent, NotFactory, NotFound, ZeroAddress} from "../lib/Errors.sol";

/// @title Identity Registry
/// @author UFarm Digital
/// @notice Manages identity eligibility checks for ERC-3643 tokens.
contract IdentityRegistry is Initializable, UUPSUpgradeable, AgentRole, IIdentityRegistry {
    IIdentityRegistryStorage private _storage;
    IClaimTopicsRegistry private _ctr;
    ITrustedIssuersRegistry private _tir;
    address private _factory;
    address private _boundToken;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the identity registry.
    /// @param owner_ Initial owner address.
    /// @param storage_ Identity registry storage.
    /// @param ctr_ Claim topics registry.
    /// @param tir_ Trusted issuers registry.
    /// @param agents Initial agents list.
    /// @param factory_ Factory authorized to bind the suite token.
    function initialize(
        address owner_,
        IIdentityRegistryStorage storage_,
        IClaimTopicsRegistry ctr_,
        ITrustedIssuersRegistry tir_,
        address[] calldata agents,
        address factory_
    ) external initializer {
        if (
            owner_ == address(0) ||
            address(storage_) == address(0) ||
            address(ctr_) == address(0) ||
            address(tir_) == address(0) ||
            factory_ == address(0)
        ) {
            revert ZeroAddress();
        }
        __AgentRole_init(owner_, agents);
        _storage = storage_;
        _ctr = ctr_;
        _tir = tir_;
        _factory = factory_;
    }

    /// @notice Returns the storage contract.
    /// @return storageContract Identity registry storage contract.
    function identityStorage() external view override returns (IIdentityRegistryStorage storageContract) {
        return _storage;
    }

    /// @notice Returns the claim topics registry.
    /// @return registry Claim topics registry contract.
    function claimTopicsRegistry() external view override returns (IClaimTopicsRegistry registry) {
        return _ctr;
    }

    /// @notice Returns the trusted issuers registry.
    /// @return registry Trusted issuers registry contract.
    function trustedIssuersRegistry() external view override returns (ITrustedIssuersRegistry registry) {
        return _tir;
    }

    /// @notice Binds the suite token authorized to recover identities.
    /// @param token Token address.
    function bindToken(address token) external override {
        if (msg.sender != _factory) revert NotFactory();
        if (token == address(0)) revert ZeroAddress();
        if (_boundToken != address(0)) revert AlreadyBound();
        _boundToken = token;
        emit TokenBound(token);
    }

    /// @notice Returns the suite token authorized to recover identities.
    /// @return token Token address.
    function boundToken() external view override returns (address token) {
        return _boundToken;
    }

    /// @notice Registers a wallet with an identity and country.
    /// @param wallet Investor wallet.
    /// @param identity Identity contract address.
    /// @param country Country code.
    function registerIdentity(address wallet, IOnchainID identity, uint16 country) external override onlyAgent {
        // Registry storage is a trusted suite dependency; event ordering does not authorize state changes.
        // slither-disable-start reentrancy-events
        _storage.storeInvestor(wallet, identity, country);
        emit IdentityRegistered(wallet, address(identity), country);
        // slither-disable-end reentrancy-events
    }

    /// @notice Removes a wallet registration.
    /// @param wallet Investor wallet.
    function removeIdentity(address wallet) external override onlyAgent {
        // Registry storage is a trusted suite dependency; event ordering does not authorize state changes.
        // slither-disable-start reentrancy-events
        _storage.removeInvestor(wallet);
        emit IdentityRemoved(wallet);
        // slither-disable-end reentrancy-events
    }

    /// @notice Recovers identity from lost wallet to a new wallet.
    /// @param lostWallet Old wallet address.
    /// @param newWallet New wallet address.
    function recoverIdentity(address lostWallet, address newWallet) external override {
        // Registry storage is a trusted suite dependency; event ordering does not authorize state changes.
        // slither-disable-start reentrancy-events
        if (!_isAgent(msg.sender) && msg.sender != _boundToken) revert NotAgent();
        if (newWallet == address(0)) revert ZeroAddress();
        if (_storage.contains(newWallet)) revert AlreadyExists();
        if (!_storage.contains(lostWallet)) revert NotFound();
        IIdentityRegistryStorage.InvestorData memory data = _storage.getInvestor(lostWallet);
        _storage.removeInvestor(lostWallet);
        _storage.storeInvestor(newWallet, data.identity, data.country);
        emit IdentityRecovered(lostWallet, newWallet, address(data.identity));
        // slither-disable-end reentrancy-events
    }

    /// @notice Returns whether wallet is verified for holding/transfers.
    /// @dev Returns false if an identity claim accessor or claim-issuer validation call fails.
    ///      Registered identities remain verified when no claim topics are required.
    /// @param wallet Wallet address.
    /// @return True if verified.
    function isVerified(address wallet) external view override returns (bool) {
        // Claim topics and trusted issuers are owner-configured bounded policy sets.
        if (!_storage.contains(wallet)) return false;
        IIdentityRegistryStorage.InvestorData memory data = _storage.getInvestor(wallet);
        uint256[] memory topics = _ctr.getClaimTopics();
        if (topics.length == 0) return true;
        for (uint256 i = 0; i < topics.length; ++i) {
            uint256 topic = topics[i];
            bool satisfied = false;
            // Assigned only on successful enumeration; catch returns false.
            // slither-disable-next-line uninitialized-local
            bytes32[] memory claimIds;
            // Bounded policy-topic loop necessarily reads the identity externally.
            // slither-disable-next-line calls-loop
            try data.identity.getClaimIdsByTopic(topic) returns (bytes32[] memory ids) {
                claimIds = ids;
            } catch {
                return false;
            }
            for (uint256 j = 0; j < claimIds.length; ++j) {
                if (_isValidClaim(data.identity, claimIds[j], topic)) {
                    satisfied = true;
                    break;
                }
            }
            if (!satisfied) return false;
        }
        return true;
    }

    function _isValidClaim(IOnchainID identity, bytes32 claimId, uint256 topic) private view returns (bool) {
        // Bounded claim-ID loops must read identities; ERC-735 scheme and URI do not affect validation.
        // slither-disable-next-line calls-loop,unused-return
        try identity.getClaim(claimId) returns (
            uint256 claimTopic,
            uint256,
            address claimIssuer,
            bytes memory signature,
            bytes memory claimData,
            string memory
        ) {
            // Trusted-issuer lookup is required for each candidate claim.
            // slither-disable-next-line calls-loop
            if (claimTopic != topic || !_tir.isTrustedIssuerForTopic(claimIssuer, topic)) return false;
            // Issuer validation is required for each candidate claim.
            // slither-disable-next-line calls-loop
            try IClaimIssuer(claimIssuer).isClaimValid(identity, topic, signature, claimData) returns (bool valid) {
                return valid;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    /// @notice Returns investor identity for wallet.
    /// @param wallet Investor wallet address.
    /// @return identity Identity contract address.
    function investorIdentity(address wallet) external view override returns (IOnchainID identity) {
        return _storage.getInvestor(wallet).identity;
    }

    /// @notice Returns investor country for wallet.
    /// @param wallet Investor wallet address.
    /// @return country Country code.
    function investorCountry(address wallet) external view override returns (uint16 country) {
        return _storage.getInvestor(wallet).country;
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
