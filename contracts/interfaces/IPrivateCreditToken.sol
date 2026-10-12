// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ICompliance} from "./ICompliance.sol";
import {IIdentityRegistry} from "./IIdentityRegistry.sol";

/// @title Private Credit Token Interface
/// @notice Interface for a fixed-term, private-credit ERC-3643 token.
interface IPrivateCreditToken {
    enum DistributionTerms {
        Monthly,
        Quarterly,
        SemiAnnual,
        Annual,
        AtMaturity,
        OnDemand
    }

    enum YieldMode {
        Distributing,
        Accreting
    }

    /// @notice Immutable packed commercial terms, including the yield-accounting mode.
    struct DebtConditions {
        uint256 minTicket;
        uint64 duration;
        uint64 minPeriod;
        uint64 lockup;
        uint16 apyBps;
        DistributionTerms distributionTerms;
        YieldMode yieldMode;
    }

    /// @notice Oracle feed addresses and timing limits supplied at initialization.
    /// @dev Feed addresses are fixed for the proxy. Both configured price feeds MUST share a quote currency.
    struct OracleParameters {
        /// @notice Fixed denomination price-feed address, or zero when disabled.
        address denominationFeed;
        /// @notice Maximum permitted age in seconds for denomination-feed answers.
        uint32 denominationMaxAge;
        /// @notice Fixed stablecoin price-feed address, or zero when disabled.
        address stablecoinFeed;
        /// @notice Maximum permitted age in seconds for stablecoin-feed answers.
        uint32 stablecoinMaxAge;
        /// @notice Fixed sequencer uptime-feed address, or zero when disabled.
        address sequencerFeed;
        /// @notice Required elapsed seconds after sequencer recovery.
        uint32 sequencerGracePeriod;
    }

    /// @notice Oracle configuration stored by the proxy.
    /// @dev Feed addresses are fixed for the proxy. Both configured price feeds MUST share a quote currency.
    struct OracleConfig {
        /// @notice Fixed denomination price-feed address, or zero when disabled.
        address denominationFeed;
        /// @notice Owner-adjustable maximum age in seconds for denomination-feed answers.
        uint32 denominationMaxAge;
        /// @notice Denomination-feed decimals cached at initialization.
        uint8 denominationFeedDecimals;
        /// @notice Fixed stablecoin price-feed address, or zero when disabled.
        address stablecoinFeed;
        /// @notice Owner-adjustable maximum age in seconds for stablecoin-feed answers.
        uint32 stablecoinMaxAge;
        /// @notice Stablecoin-feed decimals cached at initialization.
        uint8 stablecoinFeedDecimals;
        /// @notice Fixed sequencer uptime-feed address, or zero when disabled.
        address sequencerFeed;
        /// @notice Owner-adjustable required elapsed seconds after sequencer recovery.
        uint32 sequencerGracePeriod;
    }

    event PrivateCreditTokenInitialized(
        address indexed stablecoin,
        address indexed fundingAddress,
        DebtConditions conditions
    );
    event DebtStarted(uint256 startTime, uint256 maturity, uint256 mintingCutoff);
    event FundingAddressSet(address indexed fundingAddress);
    event InvestmentMinted(address indexed investor, uint256 tokenAmount, uint256 stablecoinAmount);
    event IncomeDistributed(uint256 amount, uint256 incomePerToken);
    event IncomeClaimed(address indexed holder, uint256 amount);
    event WithdrawalRequested(address indexed holder, uint256 amount);
    event WithdrawalsSettled(address[] holders);
    /// @notice Emitted after the owner updates configured price-feed timing limits.
    /// @param denominationMaxAge New denomination-feed maximum age in seconds.
    /// @param stablecoinMaxAge New stablecoin-feed maximum age in seconds.
    event OracleMaxAgesUpdated(uint32 denominationMaxAge, uint32 stablecoinMaxAge);
    /// @notice Emitted after the owner updates configured sequencer recovery time.
    /// @param sequencerGracePeriod New required elapsed seconds after sequencer recovery.
    event SequencerGracePeriodUpdated(uint32 sequencerGracePeriod);

    function initialize(
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        string calldata version_,
        address owner_,
        IIdentityRegistry identityRegistry_,
        ICompliance compliance_,
        address[] calldata agents,
        address stablecoin_,
        address fundingAddress_,
        DebtConditions calldata conditions_,
        OracleParameters calldata oracleParameters_
    ) external;

    function start() external;
    function setFundingAddress(address newFundingAddress) external;
    /// @notice Mints token base units to the caller after collecting the ceiling-rounded current stablecoin price.
    /// @dev The configured funding address cannot call this function.
    /// @param tokenAmountOut Token base units to mint.
    /// @param maxStablecoinIn Maximum stablecoin base units the caller will pay.
    function mintInvestment(uint256 tokenAmountOut, uint256 maxStablecoinIn) external;
    /// @notice Quotes the current stablecoin base-unit price with a ceiling-rounded income premium.
    /// @param tokenAmountOut Token base units to mint.
    /// @return stablecoinIn Required stablecoin base units.
    function mintPrice(uint256 tokenAmountOut) external view returns (uint256 stablecoinIn);
    /// @notice Distributes accrued income and funds its distributed-income liability.
    function distributeIncome() external;
    /// @notice Pays the caller's distributed income plus funded settlement proceeds.
    function claimIncome() external;
    /// @notice Pays distributed income plus funded settlement proceeds for each supplied holder.
    function distributeIncomeTo(address[] calldata holders) external;
    /// @notice Reserves a holder's tokens for post-lockup settlement.
    function requestWithdrawal(uint256 amount) external;
    /// @notice Reserves the caller's complete unreserved balance using the balance observed during execution.
    /// @dev Includes tokens received before execution and reuses all request lifecycle, freeze, and ticket checks.
    function requestFullWithdrawal() external;
    /// @notice Funds and records settlement claims for requested withdrawals, or full balances after maturity.
    /// @dev Settlement does not transfer to holders; claim functions pay its principal and income proceeds.
    function settleWithdrawals(address[] calldata holders) external;
    /// @notice Quotes the stablecoin base units the funding address must supply for a settlement batch at the current
    /// block timestamp.
    /// @dev Before maturity, approve a buffer for income accrued before the settlement transaction mines.
    function settlementFundingRequired(address[] calldata holders) external view returns (uint256 stablecoinAmount);

    /// @notice Returns immutable debt terms, including the configured yield mode.
    function debtConditions() external view returns (DebtConditions memory);
    /// @notice Returns fixed feed addresses, cached decimals, and owner-adjustable timing limits.
    /// @dev Both configured price feeds share a quote currency; feed addresses cannot be changed for this proxy.
    /// @return config Current oracle configuration.
    function oracleConfig() external view returns (OracleConfig memory config);
    /// @notice Updates timing limits for the fixed denomination and stablecoin feeds.
    /// @dev Only the owner may call. Both configured price feeds share a quote currency and cannot be replaced.
    /// @param denominationMaxAge New denomination-feed maximum age in seconds.
    /// @param stablecoinMaxAge New stablecoin-feed maximum age in seconds.
    function setOracleMaxAges(uint32 denominationMaxAge, uint32 stablecoinMaxAge) external;
    /// @notice Updates the recovery period for the fixed sequencer feed.
    /// @dev Only the owner may call. The sequencer feed cannot be replaced for this proxy.
    /// @param sequencerGracePeriod New required elapsed seconds after sequencer recovery.
    function setSequencerGracePeriod(uint32 sequencerGracePeriod) external;
    function stablecoin() external view returns (address);
    function fundingAddress() external view returns (address);
    function startTime() external view returns (uint256);
    function maturity() external view returns (uint256);
    function mintingCutoff() external view returns (uint256);
    function lastDistributionTime() external view returns (uint256);
    /// @notice Returns accumulated stablecoin base units per token base unit, scaled by 1e27.
    function accumulatedIncomePerToken() external view returns (uint256);
    /// @notice Returns accrued income only and excludes any settled principal.
    function accumulatedIncomeOf(address holder) external view returns (uint256);
    /// @notice Returns the holder's current token principal, accrued income, and funded settlement claims.
    /// @return amount Total value in the configured stablecoin's base units.
    function totalValueOf(address holder) external view returns (uint256);
    /// @notice Returns aggregate accrued income only and excludes settled principal.
    function totalAccumulatedIncome() external view returns (uint256);
    /// @notice Returns the unified payable claim: distributed income plus funded settlement proceeds.
    function claimableIncome(address holder) external view returns (uint256);
    /// @notice Returns the token balance reserved for a holder's withdrawal.
    function reservedWithdrawal(address holder) external view returns (uint256);
    function acquisitionTimestamp(address holder) external view returns (uint256);
}
