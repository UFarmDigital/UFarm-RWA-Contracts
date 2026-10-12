// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {ITokenFactory} from "../interfaces/ITokenFactory.sol";
import {IClaimTopicsRegistry} from "../interfaces/IClaimTopicsRegistry.sol";
import {ICompliance} from "../interfaces/ICompliance.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";
import {IIdentityRegistryStorage} from "../interfaces/IIdentityRegistryStorage.sol";
import {IPrivateCreditToken} from "../interfaces/IPrivateCreditToken.sol";
import {ITrustedIssuersRegistry} from "../interfaces/ITrustedIssuersRegistry.sol";
import {ClaimTopicsRegistry} from "./ClaimTopicsRegistry.sol";
import {Compliance} from "./Compliance.sol";
import {ERC3643Token} from "./ERC3643Token.sol";
import {IdentityRegistryStorage} from "./IdentityRegistryStorage.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";
import {TrustedIssuersRegistry} from "./TrustedIssuersRegistry.sol";
import {IdentityStorageOwnerMismatch, InvalidClaimConfiguration, LengthMismatch, ZeroAddress} from "../lib/Errors.sol";

/// @title Token Factory
/// @author UFarm Digital
/// @notice Deploys full ERC-3643 token suites behind UUPS proxies.
contract TokenFactory is Initializable, OwnableUpgradeable, UUPSUpgradeable, ITokenFactory {
    /// @notice Token implementation address.
    address public tokenImpl;
    /// @notice Private-credit token implementation address.
    address public privateCreditTokenImpl;
    /// @notice Identity registry implementation address.
    address public identityRegistryImpl;
    /// @notice Identity registry storage implementation address.
    address public identityRegistryStorageImpl;
    /// @notice Claim topics registry implementation address.
    address public claimTopicsRegistryImpl;
    /// @notice Trusted issuers registry implementation address.
    address public trustedIssuersRegistryImpl;
    /// @notice Compliance implementation address.
    address public complianceImpl;
    /// @notice Optional identity factory address.
    address public idFactory;

    struct SuiteInfrastructure {
        address identityRegistryProxy;
        address identityRegistryStorageProxy;
        address claimTopicsRegistryProxy;
        address trustedIssuersRegistryProxy;
        address complianceProxy;
        address[] agents;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the factory with implementation addresses.
    /// @param owner_ Initial owner address.
    /// @param tokenImpl_ Token implementation address.
    /// @param privateCreditTokenImpl_ Private-credit token implementation address.
    /// @param identityRegistryImpl_ Identity registry implementation address.
    /// @param identityRegistryStorageImpl_ Identity registry storage implementation address.
    /// @param claimTopicsRegistryImpl_ Claim topics registry implementation address.
    /// @param trustedIssuersRegistryImpl_ Trusted issuers registry implementation address.
    /// @param complianceImpl_ Compliance implementation address.
    /// @param idFactory_ Optional identity factory address.
    function initialize(
        address owner_,
        address tokenImpl_,
        address privateCreditTokenImpl_,
        address identityRegistryImpl_,
        address identityRegistryStorageImpl_,
        address claimTopicsRegistryImpl_,
        address trustedIssuersRegistryImpl_,
        address complianceImpl_,
        address idFactory_
    ) external initializer {
        if (
            owner_ == address(0) ||
            tokenImpl_ == address(0) ||
            privateCreditTokenImpl_ == address(0) ||
            identityRegistryImpl_ == address(0) ||
            identityRegistryStorageImpl_ == address(0) ||
            claimTopicsRegistryImpl_ == address(0) ||
            trustedIssuersRegistryImpl_ == address(0) ||
            complianceImpl_ == address(0)
        ) {
            revert ZeroAddress();
        }
        __Ownable_init(owner_);
        tokenImpl = tokenImpl_;
        privateCreditTokenImpl = privateCreditTokenImpl_;
        identityRegistryImpl = identityRegistryImpl_;
        identityRegistryStorageImpl = identityRegistryStorageImpl_;
        claimTopicsRegistryImpl = claimTopicsRegistryImpl_;
        trustedIssuersRegistryImpl = trustedIssuersRegistryImpl_;
        complianceImpl = complianceImpl_;
        // Zero intentionally disables optional external identity-factory integration.
        // slither-disable-next-line missing-zero-check
        idFactory = idFactory_;
    }

    /// @notice Deploys a new token suite.
    /// @param token TokenDetails.
    /// @param claims ClaimDetails.
    /// @param reuseIdentityRegistryStorage If non-zero, reuse existing IRS (per issuer).
    /// @return suite Addresses of deployed proxies.
    function deployTokenSuite(
        TokenDetails calldata token,
        ClaimDetails calldata claims,
        address reuseIdentityRegistryStorage
    ) external override returns (TokenSuite memory suite) {
        // Suite contracts are freshly deployed trusted dependencies; event ordering does not authorize state changes.
        // slither-disable-start reentrancy-events
        SuiteInfrastructure memory infrastructure = _deployInfrastructure(token, claims, reuseIdentityRegistryStorage);
        address tokenProxy = _deployERC3643Token(
            token,
            infrastructure.identityRegistryProxy,
            infrastructure.complianceProxy,
            infrastructure.agents
        );
        TokenSuite memory deployedSuite = _finalizeSuite(token, infrastructure, tokenProxy);
        // slither-disable-end reentrancy-events
        return deployedSuite;
    }

    /// @notice Deploys a new unstarted private-credit token suite.
    /// @param token Token details.
    /// @param claims Claim requirements.
    /// @param credit Private-credit funding and debt conditions.
    /// @param reuseIdentityRegistryStorage Existing storage address, if any.
    /// @return suite Deployed proxy addresses.
    function deployPrivateCreditTokenSuite(
        TokenDetails calldata token,
        ClaimDetails calldata claims,
        PrivateCreditDetails calldata credit,
        address reuseIdentityRegistryStorage
    ) external override returns (TokenSuite memory suite) {
        // Suite contracts are freshly deployed trusted dependencies; event ordering does not authorize state changes.
        // slither-disable-start reentrancy-events
        if (
            privateCreditTokenImpl == address(0) ||
            credit.stablecoin == address(0) ||
            credit.fundingAddress == address(0)
        ) revert ZeroAddress();
        SuiteInfrastructure memory infrastructure = _deployInfrastructure(token, claims, reuseIdentityRegistryStorage);
        address tokenProxy = _deployPrivateCreditToken(
            token,
            credit,
            infrastructure.identityRegistryProxy,
            infrastructure.complianceProxy,
            infrastructure.agents
        );
        TokenSuite memory deployedSuite = _finalizeSuite(token, infrastructure, tokenProxy);
        // slither-disable-end reentrancy-events
        return deployedSuite;
    }

    /// @notice Deploys the common infrastructure for either token suite type.
    /// @param token Token details.
    /// @param claims Claim requirements.
    /// @param reuseIdentityRegistryStorage Existing storage address, if any.
    /// @return infrastructure Deployed infrastructure proxies and default agents.
    function _deployInfrastructure(
        TokenDetails calldata token,
        ClaimDetails calldata claims,
        address reuseIdentityRegistryStorage
    ) internal returns (SuiteInfrastructure memory infrastructure) {
        _requireValidDeployInput(token, claims);
        infrastructure.agents = _defaultAgents(token.owner);
        infrastructure.identityRegistryStorageProxy = _deployIdentityRegistryStorage(
            token.owner,
            reuseIdentityRegistryStorage
        );
        infrastructure.claimTopicsRegistryProxy = _deployClaimTopicsRegistry(token.owner, claims.requiredTopics);
        infrastructure.trustedIssuersRegistryProxy = _deployTrustedIssuersRegistry(
            token.owner,
            claims.trustedIssuers,
            claims.issuerTopics
        );
        infrastructure.identityRegistryProxy = _deployIdentityRegistry(
            token.owner,
            infrastructure.identityRegistryStorageProxy,
            infrastructure.claimTopicsRegistryProxy,
            infrastructure.trustedIssuersRegistryProxy,
            infrastructure.agents
        );
        IdentityRegistryStorage(infrastructure.identityRegistryStorageProxy).bindRegistry(
            infrastructure.identityRegistryProxy
        );
        infrastructure.complianceProxy = _deployCompliance(token.owner);
    }

    /// @notice Validates deploy input.
    /// @param token Token details.
    /// @param claims Claim details.
    function _requireValidDeployInput(TokenDetails calldata token, ClaimDetails calldata claims) internal pure {
        if (token.owner == address(0)) revert ZeroAddress();
        if (claims.trustedIssuers.length != claims.issuerTopics.length) revert LengthMismatch();
        for (uint256 i = 0; i < claims.requiredTopics.length; ++i) {
            bool covered = false;
            for (uint256 j = 0; j < claims.issuerTopics.length; ++j) {
                for (uint256 k = 0; k < claims.issuerTopics[j].length; ++k) {
                    if (claims.requiredTopics[i] == claims.issuerTopics[j][k]) {
                        covered = true;
                        break;
                    }
                }
                if (covered) break;
            }
            if (!covered) revert InvalidClaimConfiguration();
        }
    }

    /// @notice Returns default agents array for a suite.
    /// @param owner Owner address.
    /// @return agents Agent list containing the owner.
    function _defaultAgents(address owner) internal pure returns (address[] memory agents) {
        agents = new address[](1);
        agents[0] = owner;
    }

    /// @notice Deploys an identity registry storage proxy.
    /// @param owner Owner address.
    /// @param reuse Existing storage address, if any.
    /// @return proxy Deployed or reused storage proxy address.
    function _deployIdentityRegistryStorage(address owner, address reuse) internal returns (address proxy) {
        if (reuse != address(0)) {
            address storageOwner = IIdentityRegistryStorage(reuse).owner();
            if (storageOwner != owner) revert IdentityStorageOwnerMismatch(reuse, owner, storageOwner);
            return reuse;
        }
        bytes memory storageData = abi.encodeCall(IdentityRegistryStorage.initialize, (owner, address(this)));
        return address(new ERC1967Proxy(identityRegistryStorageImpl, storageData));
    }

    /// @notice Deploys a claim topics registry proxy.
    /// @param owner Owner address.
    /// @param topics Required claim topics.
    /// @return proxy Deployed claim topics registry proxy address.
    function _deployClaimTopicsRegistry(address owner, uint256[] calldata topics) internal returns (address proxy) {
        bytes memory ctrData = abi.encodeCall(ClaimTopicsRegistry.initialize, (owner, topics));
        return address(new ERC1967Proxy(claimTopicsRegistryImpl, ctrData));
    }

    /// @notice Deploys a trusted issuers registry proxy.
    /// @param owner Owner address.
    /// @param issuers Trusted issuers list.
    /// @param issuerTopics Issuer topics list.
    /// @return proxy Deployed trusted issuers registry proxy address.
    function _deployTrustedIssuersRegistry(
        address owner,
        address[] calldata issuers,
        uint256[][] calldata issuerTopics
    ) internal returns (address proxy) {
        bytes memory tirData = abi.encodeCall(TrustedIssuersRegistry.initialize, (owner, issuers, issuerTopics));
        return address(new ERC1967Proxy(trustedIssuersRegistryImpl, tirData));
    }

    /// @notice Deploys an identity registry proxy.
    /// @param owner Owner address.
    /// @param storageProxy Storage proxy address.
    /// @param ctrProxy Claim topics registry proxy address.
    /// @param tirProxy Trusted issuers registry proxy address.
    /// @param agents Agents list.
    /// @return proxy Deployed identity registry proxy address.
    function _deployIdentityRegistry(
        address owner,
        address storageProxy,
        address ctrProxy,
        address tirProxy,
        address[] memory agents
    ) internal returns (address proxy) {
        bytes memory irData = abi.encodeCall(
            IdentityRegistry.initialize,
            (
                owner,
                IIdentityRegistryStorage(storageProxy),
                IClaimTopicsRegistry(ctrProxy),
                ITrustedIssuersRegistry(tirProxy),
                agents,
                address(this)
            )
        );
        return address(new ERC1967Proxy(identityRegistryImpl, irData));
    }

    /// @notice Deploys a compliance proxy.
    /// @param owner Owner address.
    /// @return proxy Deployed compliance proxy address.
    function _deployCompliance(address owner) internal returns (address proxy) {
        bytes memory complianceData = abi.encodeCall(Compliance.initialize, (owner, address(this)));
        return address(new ERC1967Proxy(complianceImpl, complianceData));
    }

    /// @notice Deploys a token proxy.
    /// @param token Token details.
    /// @param identityRegistryProxy Identity registry proxy address.
    /// @param complianceProxy Compliance proxy address.
    /// @param agents Agents list.
    /// @return proxy Deployed token proxy address.
    function _deployERC3643Token(
        TokenDetails calldata token,
        address identityRegistryProxy,
        address complianceProxy,
        address[] memory agents
    ) internal returns (address proxy) {
        bytes memory tokenData = abi.encodeCall(
            ERC3643Token.initialize,
            (
                token.name,
                token.symbol,
                token.decimals,
                token.version,
                token.owner,
                IIdentityRegistry(identityRegistryProxy),
                ICompliance(complianceProxy),
                agents
            )
        );
        return address(new ERC1967Proxy(tokenImpl, tokenData));
    }

    /// @notice Deploys a private-credit token proxy without starting its debt lifecycle.
    /// @param token Token details.
    /// @param credit Private-credit funding and debt conditions.
    /// @param identityRegistryProxy Identity registry proxy address.
    /// @param complianceProxy Compliance proxy address.
    /// @param agents Agents list.
    /// @return proxy Deployed private-credit token proxy address.
    function _deployPrivateCreditToken(
        TokenDetails calldata token,
        PrivateCreditDetails calldata credit,
        address identityRegistryProxy,
        address complianceProxy,
        address[] memory agents
    ) internal returns (address proxy) {
        bytes memory tokenData = abi.encodeCall(
            IPrivateCreditToken.initialize,
            (
                token.name,
                token.symbol,
                token.decimals,
                token.version,
                token.owner,
                IIdentityRegistry(identityRegistryProxy),
                ICompliance(complianceProxy),
                agents,
                credit.stablecoin,
                credit.fundingAddress,
                credit.conditions,
                credit.oracleParameters
            )
        );
        return address(new ERC1967Proxy(privateCreditTokenImpl, tokenData));
    }

    /// @notice Binds a token, builds a suite result, and emits its deployment event.
    /// @param token Token details.
    /// @param infrastructure Deployed infrastructure proxies.
    /// @param tokenProxy Deployed token proxy.
    /// @return suite Deployed proxy addresses.
    function _finalizeSuite(
        TokenDetails calldata token,
        SuiteInfrastructure memory infrastructure,
        address tokenProxy
    ) internal returns (TokenSuite memory suite) {
        // The freshly deployed compliance proxy is trusted; event ordering does not authorize state changes.
        // slither-disable-start reentrancy-events
        IdentityRegistry(infrastructure.identityRegistryProxy).bindToken(tokenProxy);
        Compliance(infrastructure.complianceProxy).bindToken(tokenProxy);
        suite = TokenSuite({
            tokenProxy: tokenProxy,
            identityRegistryProxy: infrastructure.identityRegistryProxy,
            identityRegistryStorageProxy: infrastructure.identityRegistryStorageProxy,
            claimTopicsRegistryProxy: infrastructure.claimTopicsRegistryProxy,
            trustedIssuersRegistryProxy: infrastructure.trustedIssuersRegistryProxy,
            complianceProxy: infrastructure.complianceProxy,
            assetOnchainId: address(0)
        });
        emit TokenSuiteDeployed(token.salt, token.owner, tokenProxy);
        // slither-disable-end reentrancy-events
    }

    /// @notice Returns latest implementation addresses used for proxies (optional).
    /// @return tokenImpl_ Token implementation address.
    /// @return privateCreditTokenImpl_ Private-credit token implementation address.
    /// @return identityRegistryImpl_ Identity registry implementation address.
    /// @return identityRegistryStorageImpl_ Identity registry storage implementation address.
    /// @return claimTopicsRegistryImpl_ Claim topics registry implementation address.
    /// @return trustedIssuersRegistryImpl_ Trusted issuers registry implementation address.
    /// @return complianceImpl_ Compliance implementation address.
    function getImplementations()
        external
        view
        override
        returns (
            address tokenImpl_,
            address privateCreditTokenImpl_,
            address identityRegistryImpl_,
            address identityRegistryStorageImpl_,
            address claimTopicsRegistryImpl_,
            address trustedIssuersRegistryImpl_,
            address complianceImpl_
        )
    {
        return (
            tokenImpl,
            privateCreditTokenImpl,
            identityRegistryImpl,
            identityRegistryStorageImpl,
            claimTopicsRegistryImpl,
            trustedIssuersRegistryImpl,
            complianceImpl
        );
    }

    /// @notice Updates implementation addresses (skip any zero address).
    /// @param tokenImpl_ Token implementation address or zero to skip.
    /// @param privateCreditTokenImpl_ Private-credit token implementation address or zero to skip.
    /// @param identityRegistryImpl_ Identity registry implementation address or zero to skip.
    /// @param identityRegistryStorageImpl_ Identity registry storage implementation address or zero to skip.
    /// @param claimTopicsRegistryImpl_ Claim topics registry implementation address or zero to skip.
    /// @param trustedIssuersRegistryImpl_ Trusted issuers registry implementation address or zero to skip.
    /// @param complianceImpl_ Compliance implementation address or zero to skip.
    function setImplementations(
        address tokenImpl_,
        address privateCreditTokenImpl_,
        address identityRegistryImpl_,
        address identityRegistryStorageImpl_,
        address claimTopicsRegistryImpl_,
        address trustedIssuersRegistryImpl_,
        address complianceImpl_
    ) external override onlyOwner {
        if (tokenImpl_ != address(0)) tokenImpl = tokenImpl_;
        if (privateCreditTokenImpl_ != address(0)) privateCreditTokenImpl = privateCreditTokenImpl_;
        if (identityRegistryImpl_ != address(0)) identityRegistryImpl = identityRegistryImpl_;
        if (identityRegistryStorageImpl_ != address(0)) {
            identityRegistryStorageImpl = identityRegistryStorageImpl_;
        }
        if (claimTopicsRegistryImpl_ != address(0)) claimTopicsRegistryImpl = claimTopicsRegistryImpl_;
        if (trustedIssuersRegistryImpl_ != address(0)) trustedIssuersRegistryImpl = trustedIssuersRegistryImpl_;
        if (complianceImpl_ != address(0)) complianceImpl = complianceImpl_;
        emit ImplementationsUpdated(
            tokenImpl,
            privateCreditTokenImpl,
            identityRegistryImpl,
            identityRegistryStorageImpl,
            claimTopicsRegistryImpl,
            trustedIssuersRegistryImpl,
            complianceImpl
        );
    }

    /// @notice Authorizes a UUPS upgrade.
    /// @param newImplementation New implementation address.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /// @dev Storage gap for upgrade safety.
    // slither-disable-next-line naming-convention,unused-state
    uint256[49] private __gap;
}
