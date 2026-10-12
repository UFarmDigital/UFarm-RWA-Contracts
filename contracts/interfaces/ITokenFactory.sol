// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IPrivateCreditToken} from "./IPrivateCreditToken.sol";

/// @title Token Factory Interface
/// @author UFarm Digital
/// @notice Deploys full ERC-3643 token suites (token + registries + compliance).
/// @dev Must support multi-asset issuance per issuer.
interface ITokenFactory {
    /// @notice Token suite deployment result.
    struct TokenSuite {
        address tokenProxy;
        address identityRegistryProxy;
        address identityRegistryStorageProxy;
        address claimTopicsRegistryProxy;
        address trustedIssuersRegistryProxy;
        address complianceProxy;
        address assetOnchainId; // optional, may be address(0)
    }

    /// @notice Deployment input for a new token.
    struct TokenDetails {
        string name;
        string symbol;
        uint8 decimals;
        string version; // optional informational
        address owner; // issuer owner of suite (ideally multisig)
        bytes32 salt; // for deterministic deployments (optional)
    }

    /// @notice Claim requirements for a token.
    struct ClaimDetails {
        uint256[] requiredTopics;
        address[] trustedIssuers;
        uint256[][] issuerTopics; // trustedIssuers[i] allowed topics
    }

    /// @notice Private-credit terms for a new token suite.
    /// @dev minTicket is in token base units. The private-credit lifecycle remains unstarted after deployment.
    struct PrivateCreditDetails {
        address stablecoin;
        address fundingAddress;
        IPrivateCreditToken.DebtConditions conditions;
        IPrivateCreditToken.OracleParameters oracleParameters;
    }

    /// @notice Emitted when a token suite is deployed.
    /// @param salt Salt used for deployment.
    /// @param owner Issuer owner address.
    /// @param tokenProxy Token proxy address.
    event TokenSuiteDeployed(bytes32 indexed salt, address indexed owner, address indexed tokenProxy);

    /// @notice Emitted after factory implementation addresses are updated.
    // slither-disable-next-line unindexed-event-address
    event ImplementationsUpdated(
        address tokenImpl,
        address privateCreditTokenImpl,
        address identityRegistryImpl,
        address identityRegistryStorageImpl,
        address claimTopicsRegistryImpl,
        address trustedIssuersRegistryImpl,
        address complianceImpl
    );

    /// @notice Deploys a new token suite.
    /// @dev Implementation must deploy UUPS proxies for each module and initialize them.
    /// @param token TokenDetails.
    /// @param claims ClaimDetails.
    /// @param reuseIdentityRegistryStorage If non-zero, reuse existing IRS (per issuer).
    /// @return suite Addresses of deployed proxies.
    function deployTokenSuite(
        TokenDetails calldata token,
        ClaimDetails calldata claims,
        address reuseIdentityRegistryStorage
    ) external returns (TokenSuite memory suite);

    /// @notice Deploys a new unstarted private-credit token suite.
    /// @dev The stablecoin and debt-condition amounts use their configured base units. The owner must call start()
    /// before investment, income distribution, or withdrawal lifecycle operations are available.
    /// @param token TokenDetails.
    /// @param claims ClaimDetails.
    /// @param credit Private-credit stablecoin, funding address, and immutable debt conditions.
    /// @param reuseIdentityRegistryStorage If non-zero, reuse existing IRS (per issuer).
    /// @return suite Addresses of deployed proxies.
    function deployPrivateCreditTokenSuite(
        TokenDetails calldata token,
        ClaimDetails calldata claims,
        PrivateCreditDetails calldata credit,
        address reuseIdentityRegistryStorage
    ) external returns (TokenSuite memory suite);

    /// @notice Returns latest implementation addresses used for proxies (optional).
    /// @return tokenImpl Token implementation address.
    /// @return privateCreditTokenImpl Private-credit token implementation address.
    /// @return identityRegistryImpl Identity registry implementation address.
    /// @return identityRegistryStorageImpl Identity registry storage implementation address.
    /// @return claimTopicsRegistryImpl Claim topics registry implementation address.
    /// @return trustedIssuersRegistryImpl Trusted issuers registry implementation address.
    /// @return complianceImpl Compliance implementation address.
    function getImplementations()
        external
        view
        returns (
            address tokenImpl,
            address privateCreditTokenImpl,
            address identityRegistryImpl,
            address identityRegistryStorageImpl,
            address claimTopicsRegistryImpl,
            address trustedIssuersRegistryImpl,
            address complianceImpl
        );

    /// @notice Updates implementation addresses (skip any zero address).
    /// @param tokenImpl Token implementation address or zero to skip.
    /// @param privateCreditTokenImpl Private-credit token implementation address or zero to skip.
    /// @param identityRegistryImpl Identity registry implementation address or zero to skip.
    /// @param identityRegistryStorageImpl Identity registry storage implementation address or zero to skip.
    /// @param claimTopicsRegistryImpl Claim topics registry implementation address or zero to skip.
    /// @param trustedIssuersRegistryImpl Trusted issuers registry implementation address or zero to skip.
    /// @param complianceImpl Compliance implementation address or zero to skip.
    function setImplementations(
        address tokenImpl,
        address privateCreditTokenImpl,
        address identityRegistryImpl,
        address identityRegistryStorageImpl,
        address claimTopicsRegistryImpl,
        address trustedIssuersRegistryImpl,
        address complianceImpl
    ) external;
}
