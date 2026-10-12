// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ERC3643Token} from "./ERC3643Token.sol";
import {IPrivateCreditToken} from "../interfaces/IPrivateCreditToken.sol";
import {IChainlinkAggregatorV3} from "../interfaces/IChainlinkAggregatorV3.sol";
import {ICompliance} from "../interfaces/ICompliance.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";
import {
    DebtAlreadyStarted,
    DebtNotActive,
    DecimalDifferenceTooLarge,
    DistributionNotDue,
    FundingAddressCannotInvest,
    EmptyBatch,
    InvalidDebtConditions,
    MaturedTransfersDisabled,
    MintingClosed,
    MintPriceExceeded,
    NonRepresentableAmount,
    PrivateCreditOperationUnavailable,
    AcquisitionPeriodNotElapsed,
    DirectBurnDisabled,
    MissingWithdrawalRequest,
    ReservedBalanceExceeded,
    TicketSizeTooLow,
    WithdrawalLockupNotElapsed,
    ZeroAmount,
    ZeroAddress,
    InvalidOracleConfiguration,
    UnsupportedOracleDecimals,
    InvalidOracleAnswer,
    InvalidOracleTimestamp,
    StaleOracleAnswer,
    SequencerDown,
    SequencerGracePeriodNotElapsed
} from "../lib/Errors.sol";

/// @title Private Credit Token
/// @author UFarm Digital
/// @notice Fixed-term ERC-3643 credit instrument denominated in token units and paid in a configured ERC-20 stablecoin.
/// @dev Inherits ERC-3643 identity, compliance, agent, pause, forced-transfer, recovery, and owner-authorized UUPS
/// upgrade behavior. The owner starts the debt, changes its funding address, distributes accrued income, settles
/// withdrawals, and authorizes upgrades. Investors self-mint subject to this contract's lifecycle gates after paying
/// the funding address. The funding address must approve this contract to pull stablecoins before distributions and
/// settlements. Identity, compliance, the stablecoin, and configured price feeds are trusted external dependencies.
/// Debt terms and feed addresses have no setter after initialization, but an owner-approved UUPS upgrade can change
/// behavior. Principal is measured and interest accrues in the token denomination. Payments convert those amounts using
/// the denomination/quote and stablecoin/quote feeds. Missing feed sides contribute a unit price; with both absent,
/// the conversion is 1:1 in whole-token units. The income index is in stablecoin base units per token base unit,
/// scaled by 1e27. Unfunded income follows balances; funded distributions are checkpointed per holder.
/// Token amounts MUST convert exactly between token and stablecoin decimal systems before FX pricing.
contract PrivateCreditToken is ERC3643Token, ReentrancyGuard, IPrivateCreditToken {
    using SafeERC20 for IERC20;

    struct HolderState {
        /// @dev Holder's last checkpointed distributed-income-per-token index.
        uint256 incomeIndex;
        /// @dev Distributed income owed to the holder, in 1e27-scaled stablecoin base units.
        uint256 claimableIncomeScaled;
        /// @dev Token base units reserved for the holder's pending withdrawal.
        uint256 reservedWithdrawal;
        /// @dev Weighted-average token acquisition time used to enforce the minimum holding period.
        uint64 acquisitionTimestamp;
        /// @dev Time of the holder's latest withdrawal request, used to enforce lockup.
        uint64 withdrawalRequestedAt;
    }

    struct DebtState {
        /// @dev Debt activation timestamp; zero until the owner starts the lifecycle.
        uint256 startTime;
        /// @dev Timestamp after which accrual and normal transfers stop.
        uint256 maturity;
        /// @dev Last timestamp at which investor-funded minting is allowed.
        uint256 mintingCutoff;
        /// @dev End timestamp of the latest funded income distribution.
        uint256 lastDistributionTime;
        /// @dev Cumulative funded stablecoin income per token base unit, scaled by 1e27.
        uint256 distributedIncomePerToken;
        /// @dev Unclaimed funded income liability in 1e27-scaled stablecoin base units.
        uint256 outstandingDistributedIncomeScaled;
        /// @dev Sub-stablecoin-unit funding carried into the next distribution, scaled by 1e27.
        uint256 fundingRemainderScaled;
    }

    struct PriceSnapshot {
        /// @dev Denomination and payment-token prices normalized to 1e18 against a shared quote currency.
        uint256 denominationPrice;
        uint256 stablecoinPrice;
    }

    /// @dev Fixed-point scale for all per-token indexes and fractional income liabilities.
    uint256 private constant INDEX_SCALE = 1e27;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant YEAR = 365 days;
    uint256 private constant MAX_DECIMAL_DIFF = 18;
    uint256 private constant PRICE_SCALE = 1e18;

    /// @dev ERC-20 used to fund principal and income payments; fixed at initialization.
    address private _stablecoin;
    /// @dev Address from which this contract pulls stablecoins after an ERC-20 approval; owner-configurable.
    address private _fundingAddress;
    /// @dev Stablecoin decimals cached at initialization so accounting cannot change with external metadata.
    uint8 private _stablecoinDecimals;
    /// @dev Commercial terms set during initialization and not otherwise mutable by this implementation.
    DebtConditions private _debtConditions;
    /// @dev Mutable lifecycle and aggregate income-accounting state.
    DebtState private _debtState;
    /// @dev Fixed feed addresses and cached decimals; timing limits are owner-adjustable. Exactly three storage slots.
    OracleConfig private _oracleConfig;
    mapping(address => HolderState) private _holderState;
    /// @dev Enables the otherwise disabled direct burn only while owner settlement is executing.
    bool private _settling;
    /// @dev Enables the otherwise disabled inherited mint only while an investor-funded mint is executing.
    bool private _investmentMinting;
    /// @dev Enables only the reserved-balance debit exception during administrative custody migration.
    bool private _recovering;
    /// @dev Funded settlement proceeds in stablecoin base units; paid with distributed income by claim functions.
    mapping(address => uint256) private _claimableSettlement;

    /// @notice Disables the generic ERC-3643 initializer for this implementation.
    /// @dev Call the overloaded private-credit initializer instead. This function always reverts so a proxy cannot be
    /// initialized without its stablecoin, funding address, and debt conditions.
    function initialize(
        string calldata,
        string calldata,
        uint8,
        string calldata,
        address,
        IIdentityRegistry,
        ICompliance,
        address[] calldata
    ) external pure override {
        revert PrivateCreditOperationUnavailable();
    }

    /// @notice Initializes the private-credit token and its commercial terms.
    /// @dev May be called once through a proxy. Validates payment addresses, debt terms, decimal compatibility,
    /// and fixed oracle dependencies. It does not start the debt or mint tokens.
    /// @param name_ ERC-20 name.
    /// @param symbol_ ERC-20 symbol.
    /// @param decimals_ Token denomination decimal precision.
    /// @param version_ ERC-3643 version string.
    /// @param owner_ Initial owner with lifecycle, funding-address, and UUPS upgrade authority.
    /// @param identityRegistry_ Identity registry inherited from ERC3643Token.
    /// @param compliance_ Compliance engine inherited from ERC3643Token.
    /// @param agents Initial ERC-3643 agents allowed to perform inherited agent operations other than issuance.
    /// @param stablecoin_ ERC-20 stablecoin used for all principal and income payments.
    /// @param fundingAddress_ Initial stablecoin payer, which must approve this contract before payments.
    /// @param conditions_ APY in basis points, duration and timing periods in seconds, minimum ticket in token base
    /// units, distribution cadence, and immutable yield mode.
    /// @param oracleParameters_ Fixed denomination/quote and stablecoin/quote feeds, sequencer feed, and timing limits.
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
    ) external override initializer {
        if (stablecoin_ == address(0) || fundingAddress_ == address(0)) revert ZeroAddress();
        // solhint-disable gas-strict-inequalities
        if (
            conditions_.minTicket == 0 ||
            conditions_.duration == 0 ||
            conditions_.minPeriod >= conditions_.duration ||
            conditions_.apyBps == 0
        ) revert InvalidDebtConditions();
        // solhint-enable gas-strict-inequalities

        uint8 stablecoinDecimals_ = IERC20Metadata(stablecoin_).decimals();
        _validateDecimalDifference(decimals_, stablecoinDecimals_);
        _initializeOracle(oracleParameters_);

        __ERC3643Token_init(name_, symbol_, decimals_, version_, owner_, identityRegistry_, compliance_, agents);
        _stablecoin = stablecoin_;
        _fundingAddress = fundingAddress_;
        _stablecoinDecimals = stablecoinDecimals_;
        _debtConditions = conditions_;
        emit PrivateCreditTokenInitialized(stablecoin_, fundingAddress_, conditions_);
    }

    /// @notice Activates the debt lifecycle and derives maturity and minting cutoff timestamps.
    /// @dev Only the owner may call once. Uses block.timestamp; reverts with DebtAlreadyStarted after activation.
    function start() external override onlyOwner {
        // Zero is the explicit not-started lifecycle sentinel.
        // slither-disable-next-line timestamp
        if (_debtState.startTime != 0) revert DebtAlreadyStarted();
        _debtState.startTime = block.timestamp;
        _debtState.maturity = _debtState.startTime + _debtConditions.duration;
        _debtState.mintingCutoff = _debtState.maturity - _debtConditions.minPeriod;
        _debtState.lastDistributionTime = _debtState.startTime;
        emit DebtStarted(_debtState.startTime, _debtState.maturity, _debtState.mintingCutoff);
    }

    /// @notice Replaces the address from which stablecoin payments are pulled.
    /// @dev Only the owner may call. The address MUST be nonzero and MUST approve this contract before payments.
    /// @param newFundingAddress New stablecoin funding address.
    function setFundingAddress(address newFundingAddress) external override onlyOwner {
        if (newFundingAddress == address(0)) revert ZeroAddress();
        _fundingAddress = newFundingAddress;
        emit FundingAddressSet(newFundingAddress);
    }

    /// @notice Disables inherited agent issuance for private-credit instruments.
    /// @dev Investors may issue only through mintInvestment, which collects stablecoin and uses a one-shot _update
    /// gate.
    function mint(address, uint256) external pure override {
        revert PrivateCreditOperationUnavailable();
    }

    /// @notice Disables inherited agent batch issuance for private-credit instruments.
    /// @dev Reverts before validating batch lengths so empty and malformed batches cannot bypass this restriction.
    function batchMint(address[] calldata, uint256[] calldata) external pure override {
        revert PrivateCreditOperationUnavailable();
    }

    /// @notice Collects the live FX-priced stablecoin payment and mints token base units to the caller.
    /// @dev The caller must be eligible under inherited ERC-3643 checks, cannot be the funding address, and must
    /// approve this contract to collect the quoted stablecoin amount. The stablecoin transfer and mint are atomic.
    function mintInvestment(uint256 tokenAmountOut, uint256 maxStablecoinIn) external override nonReentrant {
        if (msg.sender == _fundingAddress) revert FundingAddressCannotInvest();
        uint256 stablecoinIn = mintPrice(tokenAmountOut);
        // This is a caller-provided slippage bound, not timestamp-derived randomness.
        // slither-disable-next-line timestamp
        if (stablecoinIn > maxStablecoinIn) revert MintPriceExceeded(stablecoinIn, maxStablecoinIn);

        IERC20(_stablecoin).safeTransferFrom(msg.sender, _fundingAddress, stablecoinIn);
        _investmentMinting = true;
        _mint(msg.sender, tokenAmountOut);
        emit InvestmentMinted(msg.sender, tokenAmountOut, stablecoinIn);
    }

    /// @notice Quotes stablecoin payment for token principal and a ceiling-rounded accrued-income premium.
    /// @dev Uses a live price snapshot and validates the lifecycle and ticket constraints shared with mintInvestment.
    /// Minting remains allowed at the cutoff.
    function mintPrice(uint256 tokenAmountOut) public view override returns (uint256 stablecoinIn) {
        // Zero is the explicit not-started lifecycle sentinel.
        // slither-disable-next-line incorrect-equality,timestamp
        if (_debtState.startTime == 0) revert DebtNotActive();
        if (tokenAmountOut == 0) revert ZeroAmount();
        if (tokenAmountOut < _debtConditions.minTicket) revert TicketSizeTooLow();
        // Debt cutoff is intentionally defined in block-timestamp seconds.
        // slither-disable-next-line timestamp
        if (block.timestamp > _debtState.mintingCutoff) revert MintingClosed();
        return _mintPrice(tokenAmountOut, _priceSnapshot());
    }

    /// @notice Returns the immutable debt terms, including the configured yield mode.
    /// @return conditions APY in basis points, timing in seconds, minTicket in token base units, and yieldMode.
    function debtConditions() external view override returns (DebtConditions memory) {
        return _debtConditions;
    }

    /// @notice Returns fixed feed addresses, cached decimals, and owner-adjustable timing limits.
    function oracleConfig() external view override returns (OracleConfig memory) {
        return _oracleConfig;
    }

    /// @notice Updates timing limits for the fixed denomination and stablecoin feeds.
    function setOracleMaxAges(uint32 denominationMaxAge, uint32 stablecoinMaxAge) external override onlyOwner {
        if (
            (_oracleConfig.denominationFeed == address(0)) != (denominationMaxAge == 0) ||
            (_oracleConfig.stablecoinFeed == address(0)) != (stablecoinMaxAge == 0)
        ) revert InvalidOracleConfiguration();
        _oracleConfig.denominationMaxAge = denominationMaxAge;
        _oracleConfig.stablecoinMaxAge = stablecoinMaxAge;
        emit OracleMaxAgesUpdated(denominationMaxAge, stablecoinMaxAge);
    }

    /// @notice Updates the recovery period for the fixed sequencer feed.
    function setSequencerGracePeriod(uint32 sequencerGracePeriod) external override onlyOwner {
        if ((_oracleConfig.sequencerFeed == address(0)) != (sequencerGracePeriod == 0)) {
            revert InvalidOracleConfiguration();
        }
        _oracleConfig.sequencerGracePeriod = sequencerGracePeriod;
        emit SequencerGracePeriodUpdated(sequencerGracePeriod);
    }

    /// @notice Returns the ERC-20 used for principal and income payments.
    /// @return token Stablecoin contract address.
    function stablecoin() external view override returns (address) {
        return _stablecoin;
    }

    /// @notice Returns the current stablecoin funding address.
    /// @return payer Address required to approve stablecoin transferFrom calls.
    function fundingAddress() external view override returns (address) {
        return _fundingAddress;
    }

    /// @notice Returns the activation timestamp, or zero before activation.
    /// @return timestamp Unix timestamp in seconds.
    function startTime() external view override returns (uint256) {
        return _debtState.startTime;
    }

    /// @notice Returns the maturity timestamp, or zero before activation.
    /// @return timestamp Unix timestamp in seconds.
    function maturity() external view override returns (uint256) {
        return _debtState.maturity;
    }

    /// @notice Returns the last timestamp at which minting is permitted, or zero before activation.
    /// @return timestamp Unix timestamp in seconds; minting rejects only after this timestamp.
    function mintingCutoff() external view override returns (uint256) {
        return _debtState.mintingCutoff;
    }

    /// @notice Returns the endpoint of the most recently recorded distribution interval.
    /// @return timestamp Unix timestamp in seconds; zero before activation.
    function lastDistributionTime() external view override returns (uint256) {
        return _debtState.lastDistributionTime;
    }

    /// @notice Converts accrued denomination income at current FX and funds a fixed stablecoin distribution.
    /// @dev Only owner and unavailable in accreting mode. AtMaturity requires maturity; OnDemand permits any positive
    /// elapsed interval; other terms use fixed 30/90/180/365-day cadences unless at maturity. Fractional base units
    /// remain in the scaled funding remainder. Reverts when inactive, premature, pricing fails, or payment fails.
    function distributeIncome() external override onlyOwner nonReentrant {
        if (_debtConditions.yieldMode == YieldMode.Accreting) revert PrivateCreditOperationUnavailable();
        // Zero is the explicit not-started lifecycle sentinel.
        // slither-disable-next-line timestamp
        if (_debtState.startTime == 0) revert DebtNotActive();

        uint256 distributionEnd = Math.min(block.timestamp, _debtState.maturity);
        // Cadence and maturity are intentionally defined in block-timestamp seconds.
        // slither-disable-start timestamp
        // solhint-disable gas-strict-inequalities
        if (
            distributionEnd <= _debtState.lastDistributionTime ||
            (_debtConditions.distributionTerms == DistributionTerms.AtMaturity &&
                distributionEnd != _debtState.maturity) ||
            (_debtConditions.distributionTerms != DistributionTerms.AtMaturity &&
                _debtConditions.distributionTerms != DistributionTerms.OnDemand &&
                distributionEnd != _debtState.maturity &&
                block.timestamp < _debtState.lastDistributionTime + _distributionPeriod())
        ) revert DistributionNotDue();
        // solhint-enable gas-strict-inequalities
        // slither-disable-end timestamp

        uint256 incomePerToken = _incomePerToken(_debtState.lastDistributionTime, distributionEnd, _priceSnapshot());
        uint256 distributedIncomeScaled = totalSupply() * incomePerToken;
        uint256 fundedIncomeScaled = distributedIncomeScaled + _debtState.fundingRemainderScaled;
        uint256 amount = fundedIncomeScaled / INDEX_SCALE;
        // Modulo retains fixed-point funding dust; it is not used as randomness.
        // slither-disable-next-line weak-prng
        _debtState.fundingRemainderScaled = fundedIncomeScaled % INDEX_SCALE;
        _debtState.distributedIncomePerToken += incomePerToken;
        _debtState.outstandingDistributedIncomeScaled += distributedIncomeScaled;
        _debtState.lastDistributionTime = distributionEnd;
        // The owner-configured funding address explicitly approves this liability pull.
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(_stablecoin).safeTransferFrom(_fundingAddress, address(this), amount);
        emit IncomeDistributed(amount, incomePerToken);
    }

    /// @notice Pays the caller's distributed income and funded settlement proceeds.
    /// @dev Checkpoints first, pays whole stablecoin base units, and retains scaled fractional income remainders.
    function claimIncome() external override nonReentrant {
        _payoutIncome(msg.sender);
    }

    /// @notice Pays distributed income and funded settlement proceeds to each supplied holder.
    /// @dev Owner-only bounded batch; not holder enumeration. An empty list or failed payout reverts atomically.
    /// @param holders Addresses whose combined claims should be paid.
    function distributeIncomeTo(address[] calldata holders) external override onlyOwner nonReentrant {
        // The owner supplies and bounds this payout batch.
        // slither-disable-start costly-loop
        if (holders.length == 0) revert EmptyBatch();
        for (uint256 i = 0; i < holders.length; ++i) {
            _payoutIncome(holders[i]);
        }
        // slither-disable-end costly-loop
    }

    /// @notice Reserves token base units for a later owner-operated withdrawal settlement.
    /// @dev Caller must wait minPeriod from weighted acquisition time. The unreserved position remaining after a
    /// request must be zero or at least minTicket. A request resets that holder's lockup start and locks the reserved
    /// units.
    /// @param amount Token base units to reserve.
    function requestWithdrawal(uint256 amount) external override {
        _requestWithdrawal(amount);
    }

    function requestFullWithdrawal() external override {
        HolderState storage state = _holderState[msg.sender];
        _requestWithdrawal(balanceOf(msg.sender) - state.reservedWithdrawal);
    }

    function _requestWithdrawal(uint256 amount) private {
        // Zero is the explicit not-started lifecycle sentinel.
        // slither-disable-next-line incorrect-equality,timestamp
        if (_debtState.startTime == 0) revert DebtNotActive();
        if (amount == 0) revert ZeroAmount();
        HolderState storage state = _holderState[msg.sender];
        // Minimum holding period is intentionally defined in block-timestamp seconds.
        // slither-disable-next-line timestamp
        if (block.timestamp < state.acquisitionTimestamp + _debtConditions.minPeriod) {
            revert AcquisitionPeriodNotElapsed();
        }

        uint256 unreservedBalance = balanceOf(msg.sender) - state.reservedWithdrawal;
        if (amount > unreservedBalance) revert ReservedBalanceExceeded();
        _requireNotFrozen(msg.sender);
        _requireFreeBalance(msg.sender, state.reservedWithdrawal + amount);
        uint256 remainingBalance = unreservedBalance - amount;
        if (remainingBalance != 0 && remainingBalance < _debtConditions.minTicket) revert TicketSizeTooLow();

        state.reservedWithdrawal += amount;
        state.withdrawalRequestedAt = uint64(block.timestamp);
        emit WithdrawalRequested(msg.sender, amount);
    }

    /// @notice Burns withdrawals and records funded settlement claims for supplied holders.
    /// @dev Owner-only. Before maturity, settles locked reservations; at or after maturity, settles every supplied
    /// holder's representable unfrozen balance without a request. Prices principal and current unfunded income at one
    /// live FX snapshot, then records them with crystallized funded income as a stablecoin claim. Frozen units and any
    /// nonrepresentable remainder stay with the holder. Funding failures revert all changes atomically.
    /// @param holders Holders to settle; an empty list reverts.
    // solhint-disable-next-line function-max-lines
    function settleWithdrawals(address[] calldata holders) external override onlyOwner nonReentrant {
        // The owner supplies and bounds this settlement batch. Whole-unit truncation intentionally retains scaled dust.
        // slither-disable-start costly-loop,divide-before-multiply
        // Zero is the explicit not-started lifecycle sentinel.
        // slither-disable-next-line incorrect-equality,timestamp
        if (_debtState.startTime == 0) revert DebtNotActive();
        if (holders.length == 0) revert EmptyBatch();

        // Maturity is intentionally defined in block-timestamp seconds.
        // slither-disable-next-line timestamp
        bool isMatured = block.timestamp >= _debtState.maturity; // solhint-disable-line gas-strict-inequalities
        PriceSnapshot memory prices = _priceSnapshot();
        for (uint256 i = 0; i < holders.length; ++i) {
            address holder = holders[i];
            HolderState storage state = _holderState[holder];
            (uint256 amount, uint256 newlyDue) = _settlementFundingRequired(holder, isMatured, prices);
            uint256 holderBalance = balanceOf(holder);
            // Exact equality identifies the only full-exit accounting path.
            // slither-disable-next-line incorrect-equality,timestamp
            bool isFullExit = amount == holderBalance;

            _checkpoint(holder);
            uint256 crystallizedIncome = state.claimableIncomeScaled / INDEX_SCALE;

            if (isFullExit) {
                _debtState.outstandingDistributedIncomeScaled -= state.claimableIncomeScaled;
                state.claimableIncomeScaled = 0;
            } else {
                state.claimableIncomeScaled -= crystallizedIncome * INDEX_SCALE;
                _debtState.outstandingDistributedIncomeScaled -= crystallizedIncome * INDEX_SCALE;
            }
            state.reservedWithdrawal = 0;
            state.withdrawalRequestedAt = 0;
            _settling = true;
            _burn(holder, amount);

            uint256 payment = newlyDue + crystallizedIncome;
            // The owner-configured funding address explicitly approves this settlement pull.
            // slither-disable-next-line arbitrary-send-erc20
            IERC20(_stablecoin).safeTransferFrom(_fundingAddress, address(this), newlyDue);
            _claimableSettlement[holder] += payment;
        }
        emit WithdrawalsSettled(holders);
        // slither-disable-end costly-loop,divide-before-multiply
    }

    /// @notice Quotes the stablecoin base units the funding address must supply for a settlement batch at the current
    /// block timestamp.
    /// @dev Applies the same lifecycle, request, lockup, free-balance, decimal-conversion, FX, and rounding rules as
    /// settlement. Before maturity, callers should approve a buffer for income accrued before the transaction mines.
    /// @param holders Holders that would be supplied to settleWithdrawals.
    /// @return stablecoinAmount Stablecoin base units required from the funding address.
    function settlementFundingRequired(
        address[] calldata holders
    ) external view override returns (uint256 stablecoinAmount) {
        // Zero is the explicit not-started lifecycle sentinel.
        // slither-disable-next-line incorrect-equality,timestamp
        if (_debtState.startTime == 0) revert DebtNotActive();
        if (holders.length == 0) revert EmptyBatch();

        // Maturity is intentionally defined in block-timestamp seconds.
        // The exact maturity boundary is a deliberate lifecycle check.
        // slither-disable-start incorrect-equality,timestamp
        // solhint-disable-next-line gas-strict-inequalities
        bool isMatured = block.timestamp >= _debtState.maturity;
        // slither-disable-end incorrect-equality,timestamp
        PriceSnapshot memory prices = _priceSnapshot();
        for (uint256 i = 0; i < holders.length; ++i) {
            (, uint256 newlyDue) = _settlementFundingRequired(holders[i], isMatured, prices);
            stablecoinAmount += newlyDue;
        }
    }

    /// @notice Returns accrued stablecoin base units per token base unit, scaled by 1e27.
    /// @dev Includes funded distributions and live-FX-priced unfunded accrual through maturity, without state changes.
    /// @return index Fixed-point income index scaled by 1e27.
    function accumulatedIncomePerToken() external view override returns (uint256) {
        // Zero is the explicit not-started lifecycle sentinel.
        // slither-disable-next-line incorrect-equality,timestamp
        if (_debtState.startTime == 0) return 0;
        return _currentIncomePerToken(_priceSnapshot());
    }

    /// @notice Returns a holder's distributed and undistributed accrued income.
    /// @dev Truncates to whole stablecoin base units and does not imply current funding or claimability.
    /// @param holder Holder address.
    /// @return amount Whole stablecoin base units accrued for the holder.
    function accumulatedIncomeOf(address holder) external view override returns (uint256) {
        // Zero is the explicit not-started lifecycle sentinel.
        // slither-disable-next-line incorrect-equality,timestamp
        if (_debtState.startTime == 0) return 0;
        return _accumulatedIncomeScaled(holder, _priceSnapshot()) / INDEX_SCALE;
    }

    /// @notice Returns the holder's total position value in stablecoin base units.
    /// @dev Includes current token principal, distributed and undistributed accrued income, and funded settlement
    /// claims. Already-paid claims are excluded.
    /// @param holder Holder address.
    /// @return amount Total current position value in stablecoin base units.
    function totalValueOf(address holder) external view override returns (uint256) {
        uint256 balance = balanceOf(holder);
        if (balance == 0) {
            return _distributedClaimableIncomeScaled(holder) / INDEX_SCALE + _claimableSettlement[holder];
        }
        PriceSnapshot memory prices = _priceSnapshot();
        return
            _principalForTokenAmount(balance, prices, Math.Rounding.Floor) +
            _accumulatedIncomeScaled(holder, prices) / INDEX_SCALE +
            _claimableSettlement[holder];
    }

    /// @notice Returns aggregate distributed liability plus current undistributed accrual.
    /// @dev Truncates to whole stablecoin base units; it is not a solvency proof.
    /// @return amount Whole stablecoin base units of aggregate accrued income.
    function totalAccumulatedIncome() external view override returns (uint256) {
        // Zero start and supply are explicit empty-state shortcuts.
        // slither-disable-next-line incorrect-equality,timestamp
        if (_debtState.startTime == 0 || totalSupply() == 0) {
            return _debtState.outstandingDistributedIncomeScaled / INDEX_SCALE;
        }
        PriceSnapshot memory prices = _priceSnapshot();
        uint256 currentUndistributedIncomeScaled = totalSupply() *
            (_currentIncomePerToken(prices) - _debtState.distributedIncomePerToken);
        return (_debtState.outstandingDistributedIncomeScaled + currentUndistributedIncomeScaled) / INDEX_SCALE;
    }

    /// @notice Returns a holder's distributed income and funded settlement proceeds available to claim.
    /// @dev Includes an unpersisted distributed-index checkpoint, excludes undistributed income, and truncates its
    /// scaled component. Settlement proceeds include principal but accumulated-income views exclude principal.
    /// @param holder Holder address.
    /// @return amount Whole stablecoin base units currently payable by claimIncome.
    function claimableIncome(address holder) external view override returns (uint256) {
        return _distributedClaimableIncomeScaled(holder) / INDEX_SCALE + _claimableSettlement[holder];
    }

    /// @notice Returns token base units reserved by a holder's latest outstanding withdrawal request.
    /// @param holder Holder address.
    /// @return amount Token base units unavailable for transfer, burn, or another request.
    function reservedWithdrawal(address holder) external view override returns (uint256) {
        return _holderState[holder].reservedWithdrawal;
    }

    /// @notice Returns the holder's weighted-average acquisition timestamp.
    /// @param holder Holder address.
    /// @return timestamp Unix timestamp in seconds used to test minPeriod eligibility.
    function acquisitionTimestamp(address holder) external view override returns (uint256) {
        return _holderState[holder].acquisitionTimestamp;
    }

    /// @dev Applies credit-instrument rules around every ERC-20 balance change before ERC3643Token.
    /// Nonzero amounts MUST convert exactly between token and stablecoin decimal systems. Investment mints require
    /// activation, the cutoff, and minTicket. Direct burns are disabled except during settlement. Ordinary transfers
    /// cannot spend reserved or frozen units; forced transfers cannot spend reserved units. Recovery moves the complete
    /// position. Normal transfers stop at maturity, while forced transfers and recovery bypass that maturity gate.
    /// Their inherited bypasses of pause, freeze, and compliance checks remain unchanged.
    /// Checkpoints precede balance changes, so distributed income follows the old holder and undistributed income
    /// follows balances. Recipient acquisition time is a truncated weighted average.
    /// @param from Address losing tokens, or the zero address for a mint.
    /// @param to Address receiving tokens, or the zero address for a settlement burn.
    /// @param amount Token base units being minted, transferred, or burned.
    // The hook intentionally centralizes all private-credit balance-change invariants.
    // slither-disable-start cyclomatic-complexity
    // solhint-disable-next-line function-max-lines
    function _update(address from, address to, uint256 amount) internal override {
        // This single hook intentionally centralizes all private-credit balance-change invariants. Registry and
        // compliance callbacks are owner-selected trusted dependencies.
        // slither-disable-start reentrancy-no-eth,costly-loop
        if (amount != 0) _requireRepresentableTokenAmount(amount);

        if (from == address(0)) {
            if (!_investmentMinting) revert PrivateCreditOperationUnavailable();
            _investmentMinting = false;
            // Zero and cutoff are intentional lifecycle timestamp boundaries.
            // slither-disable-next-line timestamp
            if (_debtState.startTime == 0) revert DebtNotActive();
            // slither-disable-next-line timestamp
            if (block.timestamp > _debtState.mintingCutoff) revert MintingClosed();
            if (amount < _debtConditions.minTicket) revert TicketSizeTooLow();
        }

        HolderState storage fromState = _holderState[from];
        if (from != address(0)) {
            if (to == address(0) && !_settling) revert DirectBurnDisabled();
            if (!_recovering) {
                uint256 transferable = balanceOf(from) - fromState.reservedWithdrawal;
                if (amount > transferable) revert ReservedBalanceExceeded();
                if (
                    to != address(0) &&
                    !_forceTransfer &&
                    (_frozenTokens[from] > transferable || amount > transferable - _frozenTokens[from])
                ) {
                    revert ReservedBalanceExceeded();
                }
            }
            // Maturity is intentionally defined in block-timestamp seconds.
            // slither-disable-next-line timestamp
            // solhint-disable-next-line gas-strict-inequalities
            if (to != address(0) && !_forceTransfer && block.timestamp >= _debtState.maturity) {
                revert MaturedTransfersDisabled();
            }
            if (to == address(0)) _settling = false;
        }

        uint256 fromBalance = balanceOf(from);
        uint256 toBalance = balanceOf(to);
        uint256 incomingAcquisitionTime = from == address(0) ? block.timestamp : fromState.acquisitionTimestamp;
        _checkpoint(from);
        if (to != from) _checkpoint(to);
        super._update(from, to, amount);

        // Self/zero updates intentionally preserve acquisition accounting.
        // slither-disable-next-line incorrect-equality
        if (from == to || amount == 0) return;
        // An exact full-balance debit intentionally clears the sender timestamp.
        // slither-disable-next-line incorrect-equality
        if (from != address(0) && amount == fromBalance) fromState.acquisitionTimestamp = 0;
        if (to != address(0)) {
            HolderState storage toState = _holderState[to];
            uint256 combinedBalance = toBalance + amount;
            toState.acquisitionTimestamp = uint64(
                Math.mulDiv(toBalance, toState.acquisitionTimestamp, combinedBalance) +
                    Math.mulDiv(amount, incomingAcquisitionTime, combinedBalance)
            );
        }
        // slither-disable-end reentrancy-no-eth,costly-loop
    }
    // slither-disable-end cyclomatic-complexity

    /// @dev Checkpoints and pays whole distributed-income units plus funded settlement proceeds.
    /// Fractional 1e27-scaled income stays claimable; settlement proceeds use stablecoin base units. SafeERC20
    /// reverts on a failed transfer.
    /// @param holder Claim recipient.
    function _payoutIncome(address holder) private {
        // Whole-unit payout intentionally retains the scaled fractional remainder.
        // slither-disable-start divide-before-multiply,costly-loop
        _checkpoint(holder);
        HolderState storage state = _holderState[holder];
        uint256 income = state.claimableIncomeScaled / INDEX_SCALE;
        uint256 settlement = _claimableSettlement[holder];
        uint256 amount = income + settlement;
        if (amount == 0) return;
        state.claimableIncomeScaled -= income * INDEX_SCALE;
        _debtState.outstandingDistributedIncomeScaled -= income * INDEX_SCALE;
        delete _claimableSettlement[holder];
        IERC20(_stablecoin).safeTransfer(holder, amount);
        emit IncomeClaimed(holder, amount);
        // slither-disable-end divide-before-multiply,costly-loop
    }

    /// @dev Crystallizes a holder's balance times the distributed-index change in 1e27-scaled base units.
    /// @param holder Holder whose checkpoint is updated; the zero address is ignored.
    function _checkpoint(address holder) internal {
        if (holder == address(0)) return;
        uint256 index = _debtState.distributedIncomePerToken;
        HolderState storage state = _holderState[holder];
        uint256 accountIndex = state.incomeIndex;
        // Equal cumulative indexes mean that no checkpoint work is due.
        // slither-disable-next-line incorrect-equality,timestamp
        if (index == accountIndex) return;
        state.claimableIncomeScaled += balanceOf(holder) * (index - accountIndex);
        state.incomeIndex = index;
    }

    /// @dev Private-credit recovery moves the complete position, including reserved units.
    function _recoveryBalance(address lostWallet) internal view override returns (uint256) {
        return balanceOf(lostWallet);
    }

    function _maxFrozenBalance(address wallet) internal view override returns (uint256) {
        return balanceOf(wallet) - _holderState[wallet].reservedWithdrawal;
    }

    /// @dev Permits the recovery transfer to debit a wallet's reserved position.
    function _beforeRecovery(address, address) internal override {
        _recovering = true;
    }

    /// @dev Moves all holder-owned rights and restrictions after the balance update has preserved acquisition
    /// weighting.
    function _afterRecovery(address lostWallet, address newWallet, uint256) internal override {
        _checkpoint(lostWallet);
        _checkpoint(newWallet);

        HolderState storage lostState = _holderState[lostWallet];
        HolderState storage newState = _holderState[newWallet];
        newState.claimableIncomeScaled += lostState.claimableIncomeScaled;
        newState.reservedWithdrawal += lostState.reservedWithdrawal;
        newState.withdrawalRequestedAt = uint64(
            Math.max(newState.withdrawalRequestedAt, lostState.withdrawalRequestedAt)
        );
        _claimableSettlement[newWallet] += _claimableSettlement[lostWallet];
        _frozenTokens[newWallet] += _frozenTokens[lostWallet];
        _frozen[newWallet] = _frozen[newWallet] || _frozen[lostWallet];

        delete _holderState[lostWallet];
        delete _claimableSettlement[lostWallet];
        delete _frozenTokens[lostWallet];
        delete _frozen[lostWallet];
        _recovering = false;
    }

    /// @dev Returns total accrued income in 1e27-scaled stablecoin base units, including undistributed accrual.
    /// @param holder Holder address.
    /// @return income Scaled accrued income.
    function _accumulatedIncomeScaled(address holder, PriceSnapshot memory prices) private view returns (uint256) {
        uint256 currentIndex = _currentIncomePerToken(prices);
        HolderState storage state = _holderState[holder];
        return state.claimableIncomeScaled + balanceOf(holder) * (currentIndex - state.incomeIndex);
    }

    /// @dev Returns only distributed claimable income in 1e27-scaled stablecoin base units.
    /// @param holder Holder address.
    /// @return income Scaled income payable through claim functions.
    function _distributedClaimableIncomeScaled(address holder) private view returns (uint256) {
        HolderState storage state = _holderState[holder];
        return
            state.claimableIncomeScaled +
            balanceOf(holder) * (_debtState.distributedIncomePerToken - state.incomeIndex);
    }

    /// @dev Returns the current cumulative income index through maturity without updating storage.
    /// @return index Stablecoin-base-units-per-token-base-unit scaled by 1e27.
    function _currentIncomePerToken(PriceSnapshot memory prices) private view returns (uint256) {
        // Zero is the explicit not-started lifecycle sentinel.
        // slither-disable-next-line incorrect-equality,timestamp
        if (_debtState.startTime == 0) return 0;
        return
            _debtState.distributedIncomePerToken +
            _incomePerToken(_debtState.lastDistributionTime, Math.min(block.timestamp, _debtState.maturity), prices);
    }

    /// @dev Returns FX-converted principal rounded up plus ceiling-rounded unfunded income embedded in token units,
    /// preventing split purchases from underfunding aggregate income.
    function _mintPrice(uint256 tokenAmountOut, PriceSnapshot memory prices) private view returns (uint256) {
        uint256 principal = _principalForTokenAmount(tokenAmountOut, prices, Math.Rounding.Ceil);
        uint256 premium = Math.mulDiv(
            tokenAmountOut,
            _currentIncomePerToken(prices) - _debtState.distributedIncomePerToken,
            INDEX_SCALE,
            Math.Rounding.Ceil
        );
        return principal + premium;
    }

    /// @dev Reads the configured prices once after confirming sequencer availability.
    function _priceSnapshot() private view returns (PriceSnapshot memory prices) {
        _checkSequencer();
        prices.denominationPrice = _readPrice(
            _oracleConfig.denominationFeed,
            _oracleConfig.denominationMaxAge,
            _oracleConfig.denominationFeedDecimals
        );
        prices.stablecoinPrice = _readPrice(
            _oracleConfig.stablecoinFeed,
            _oracleConfig.stablecoinMaxAge,
            _oracleConfig.stablecoinFeedDecimals
        );
    }

    /// @dev Returns one 1e18-normalized positive, current price; a disabled feed contributes a unit price.
    function _readPrice(address feed, uint32 maxAge, uint8 feedDecimals) private view returns (uint256) {
        if (feed == address(0)) return PRICE_SCALE;
        // Only answer and updatedAt affect price validation.
        // slither-disable-next-line unused-return
        (, int256 answer, , uint256 updatedAt, ) = IChainlinkAggregatorV3(feed).latestRoundData();
        // solhint-disable-next-line gas-strict-inequalities
        if (answer <= 0) revert InvalidOracleAnswer(feed, answer);
        if (updatedAt == 0 || updatedAt > block.timestamp) revert InvalidOracleTimestamp(feed, updatedAt);
        // Oracle freshness is intentionally defined in block-timestamp seconds.
        // slither-disable-next-line timestamp
        if (block.timestamp - updatedAt > maxAge) revert StaleOracleAnswer(feed, updatedAt, maxAge);
        return Math.mulDiv(uint256(answer), PRICE_SCALE, 10 ** uint256(feedDecimals));
    }

    /// @dev Blocks pricing while the configured sequencer is down or has not completed its recovery period.
    function _checkSequencer() private view {
        address feed = _oracleConfig.sequencerFeed;
        if (feed == address(0)) return;
        // Only uptime answer and recovery start affect the sequencer gate.
        // slither-disable-next-line unused-return
        (, int256 answer, uint256 startedAt, , ) = IChainlinkAggregatorV3(feed).latestRoundData();
        if (answer != 0) revert SequencerDown();
        if (startedAt > block.timestamp) revert InvalidOracleTimestamp(feed, startedAt);
        uint256 gracePeriod = _oracleConfig.sequencerGracePeriod;
        // Sequencer recovery is intentionally defined in block-timestamp seconds.
        // solhint-disable gas-strict-inequalities
        // slither-disable-next-line timestamp
        if (startedAt == 0 || block.timestamp - startedAt <= gracePeriod) {
            revert SequencerGracePeriodNotElapsed(startedAt, gracePeriod);
        }
        // solhint-enable gas-strict-inequalities
    }

    /// @dev Computes denomination APY accrual, then converts it to stablecoin units at the supplied FX snapshot.
    /// The denomination index uses the validated token/stablecoin decimal difference; both scaling and FX conversion
    /// round down.
    /// @param fromTime Inclusive interval start timestamp.
    /// @param toTime Exclusive interval end timestamp.
    /// @return income Stablecoin base units per token base unit, scaled by 1e27.
    function _incomePerToken(
        uint256 fromTime,
        uint256 toTime,
        PriceSnapshot memory prices
    ) private view returns (uint256) {
        // Interval ordering is an input relation, not a block-time dependency.
        // slither-disable-start timestamp
        // solhint-disable-next-line gas-strict-inequalities
        if (toTime <= fromTime) return 0;
        // slither-disable-end timestamp
        return _convertDenominatedAmount(_denominationIncomePerToken(fromTime, toTime), prices, Math.Rounding.Floor);
    }

    /// @dev Computes linear APY in the token denomination, scaled to stablecoin decimal precision before FX.
    /// Formula: apyBps * elapsed * 1e27 * 10**max(stableDecimals-tokenDecimals, 0) /
    /// (10,000 * 365 days * 10**max(tokenDecimals-stableDecimals, 0)).
    function _denominationIncomePerToken(uint256 fromTime, uint256 toTime) private view returns (uint256) {
        // Timestamp interval ordering is integral to the accrual formula.
        // slither-disable-start timestamp
        // solhint-disable-next-line gas-strict-inequalities
        if (toTime <= fromTime) return 0;
        // slither-disable-end timestamp
        uint8 tokenDecimals = decimals();
        uint8 stablecoinDecimals = _stablecoinDecimals;
        uint256 multiplier = INDEX_SCALE;
        uint256 denominator = BPS_DENOMINATOR * YEAR;
        if (stablecoinDecimals > tokenDecimals) {
            multiplier *= 10 ** uint256(stablecoinDecimals - tokenDecimals);
        } else if (tokenDecimals > stablecoinDecimals) {
            denominator *= 10 ** uint256(tokenDecimals - stablecoinDecimals);
        }
        return Math.mulDiv(uint256(_debtConditions.apyBps) * (toTime - fromTime), multiplier, denominator);
    }

    /// @dev Applies denomination/quote divided by stablecoin/quote to an amount scaled to stablecoin decimals.
    function _convertDenominatedAmount(
        uint256 amount,
        PriceSnapshot memory prices,
        Math.Rounding rounding
    ) private pure returns (uint256) {
        return Math.mulDiv(amount, prices.denominationPrice, prices.stablecoinPrice, rounding);
    }

    /// @dev Converts exactly between decimal systems, then prices principal in stablecoin base units at supplied FX.
    function _principalForTokenAmount(
        uint256 amount,
        PriceSnapshot memory prices,
        Math.Rounding rounding
    ) private view returns (uint256) {
        return _convertDenominatedAmount(_convertDecimals(amount, decimals(), _stablecoinDecimals), prices, rounding);
    }

    /// @dev Enforces exact decimal representability without consulting live price feeds.
    function _requireRepresentableTokenAmount(uint256 amount) private view {
        _convertDecimals(amount, decimals(), _stablecoinDecimals);
    }

    /// @dev Returns the representable burn amount and live-FX-priced stablecoin funding for one holder.
    function _settlementFundingRequired(
        address holder,
        bool isMatured,
        PriceSnapshot memory prices
    ) private view returns (uint256 amount, uint256 stablecoinAmount) {
        HolderState storage state = _holderState[holder];
        amount = isMatured ? balanceOf(holder) - _frozenTokens[holder] : state.reservedWithdrawal;
        if (isMatured && decimals() > _stablecoinDecimals) {
            uint256 unit = 10 ** uint256(decimals() - _stablecoinDecimals);
            amount -= amount % unit;
        }
        if (!isMatured) {
            uint64 requestedAt = state.withdrawalRequestedAt;
            if (requestedAt == 0) revert MissingWithdrawalRequest();
            // Withdrawal lockup is intentionally defined in block-timestamp seconds.
            // slither-disable-next-line timestamp
            if (block.timestamp < requestedAt + _debtConditions.lockup) revert WithdrawalLockupNotElapsed();
        }

        uint256 currentIncome = Math.mulDiv(
            amount,
            _currentIncomePerToken(prices) - _debtState.distributedIncomePerToken,
            INDEX_SCALE
        );
        stablecoinAmount = _principalForTokenAmount(amount, prices, Math.Rounding.Floor) + currentIncome;
    }

    /// @dev Rejects decimal differences greater than 18 to bound scaling factors.
    /// @param fromDecimals Source decimal precision.
    /// @param toDecimals Destination decimal precision.
    function _validateDecimalDifference(uint8 fromDecimals, uint8 toDecimals) private pure {
        uint8 difference = fromDecimals > toDecimals ? fromDecimals - toDecimals : toDecimals - fromDecimals;
        if (difference > MAX_DECIMAL_DIFF) {
            revert DecimalDifferenceTooLarge(fromDecimals, toDecimals);
        }
    }

    /// @dev Validates fixed oracle dependencies and caches their decimals during initialization.
    function _initializeOracle(OracleParameters calldata parameters) private {
        uint8 denominationFeedDecimals = _validateFeed(parameters.denominationFeed, parameters.denominationMaxAge);
        uint8 stablecoinFeedDecimals = _validateFeed(parameters.stablecoinFeed, parameters.stablecoinMaxAge);
        if (
            (parameters.sequencerFeed == address(0)) != (parameters.sequencerGracePeriod == 0) ||
            (parameters.sequencerFeed != address(0) && parameters.sequencerFeed.code.length == 0)
        ) revert InvalidOracleConfiguration();

        _oracleConfig = OracleConfig({
            denominationFeed: parameters.denominationFeed,
            denominationMaxAge: parameters.denominationMaxAge,
            denominationFeedDecimals: denominationFeedDecimals,
            stablecoinFeed: parameters.stablecoinFeed,
            stablecoinMaxAge: parameters.stablecoinMaxAge,
            stablecoinFeedDecimals: stablecoinFeedDecimals,
            sequencerFeed: parameters.sequencerFeed,
            sequencerGracePeriod: parameters.sequencerGracePeriod
        });
    }

    /// @dev Validates a fixed price feed and returns its initialization-time decimal precision.
    function _validateFeed(address feed, uint32 maxAge) private view returns (uint8 feedDecimals) {
        if (feed == address(0)) {
            if (maxAge != 0) revert InvalidOracleConfiguration();
            return 0;
        }
        if (maxAge == 0 || feed.code.length == 0) revert InvalidOracleConfiguration();
        feedDecimals = IChainlinkAggregatorV3(feed).decimals();
        if (feedDecimals > 18) revert UnsupportedOracleDecimals(feed, feedDecimals);
    }

    /// @dev Converts base units between decimal systems with exact downscaling only.
    /// @param amount Source base units.
    /// @param fromDecimals Source decimal precision.
    /// @param toDecimals Destination decimal precision.
    /// @return converted Destination base units.
    function _convertDecimals(uint256 amount, uint8 fromDecimals, uint8 toDecimals) private pure returns (uint256) {
        _validateDecimalDifference(fromDecimals, toDecimals);
        if (toDecimals == fromDecimals) return amount;

        if (toDecimals > fromDecimals) {
            return amount * (10 ** uint256(toDecimals - fromDecimals));
        }

        uint256 factor = 10 ** uint256(fromDecimals - toDecimals);
        // Modulo enforces exact divisibility; it is neither randomness nor time logic.
        // slither-disable-next-line weak-prng,timestamp
        if (amount % factor != 0) revert NonRepresentableAmount(amount, fromDecimals, toDecimals);
        return amount / factor;
    }

    /// @dev Maps non-maturity distribution terms to fixed second-based cadence, not calendar periods.
    /// @return period 30, 90, 180, or 365 days for monthly through annual terms.
    function _distributionPeriod() private view returns (uint256) {
        if (_debtConditions.distributionTerms == DistributionTerms.Monthly) return 30 days;
        if (_debtConditions.distributionTerms == DistributionTerms.Quarterly) return 90 days;
        if (_debtConditions.distributionTerms == DistributionTerms.SemiAnnual) return 180 days;
        return YEAR;
    }

    /// @dev Reserved storage for future upgrades.
    // OpenZeppelin-compatible reserved upgrade storage.
    // slither-disable-next-line naming-convention,unused-state
    uint256[30] private __gap;
}
