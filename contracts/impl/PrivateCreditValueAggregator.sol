// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IChainlinkAggregatorV3} from "../interfaces/IChainlinkAggregatorV3.sol";
import {IPrivateCreditToken} from "../interfaces/IPrivateCreditToken.sol";
import {
    InvalidOracleAnswer,
    InvalidOracleConfiguration,
    InvalidOracleTimestamp,
    LengthMismatch,
    SequencerDown,
    SequencerGracePeriodNotElapsed,
    StaleOracleAnswer,
    UnsupportedOracleDecimals,
    ZeroAddress
} from "../lib/Errors.sol";

/// @title Private Credit Value Aggregator
/// @author UFarm Digital
/// @notice Sums private-credit position values and returns their USD value with 18 decimals.
/// @dev Each configured feed must be the direct stablecoin/USD feed for its mapping key. Feed identity is an
/// owner-controlled deployment invariant because Chainlink-compatible feeds do not expose a standard pair identifier.
contract PrivateCreditValueAggregator is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    struct OracleConfig {
        address feed;
        uint32 maxAge;
        uint8 stablecoinDecimals;
        uint8 feedDecimals;
    }

    error DuplicateValueContract(address valueContract);
    error InvalidValueContract(address valueContract);
    error MissingOracle(address stablecoin);
    error UnsupportedTokenDecimals(address stablecoin, uint8 decimals);

    event ValueContractsUpdated(address[] valueContracts);
    event OracleUpdated(address indexed stablecoin, address indexed feed, uint32 maxAge);
    event OracleRemoved(address indexed stablecoin);
    event SequencerOracleUpdated(address indexed feed, uint32 gracePeriod);

    uint256 private constant USD_SCALE = 1e18;
    uint8 private constant MAX_SUPPORTED_DECIMALS = 18;

    address[] private _valueContracts;
    mapping(address => OracleConfig) private _oracleByStablecoin;
    address private _sequencerFeed;
    uint32 private _sequencerGracePeriod;

    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes ownership, value sources, USD feeds, and optional L2 sequencer protection.
    function initialize(
        address owner_,
        address[] calldata valueContracts_,
        address[] calldata stablecoins_,
        address[] calldata usdFeeds_,
        uint32[] calldata maxAges_,
        address sequencerFeed_,
        uint32 sequencerGracePeriod_
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (stablecoins_.length != usdFeeds_.length || usdFeeds_.length != maxAges_.length) revert LengthMismatch();

        __Ownable_init(owner_);
        _setValueContracts(valueContracts_);

        for (uint256 i = 0; i < stablecoins_.length; ++i) {
            if (_oracleByStablecoin[stablecoins_[i]].feed != address(0)) {
                revert InvalidOracleConfiguration();
            }
            _setOracle(stablecoins_[i], usdFeeds_[i], maxAges_[i]);
        }

        _setSequencerOracle(sequencerFeed_, sequencerGracePeriod_);
    }

    /// @notice Returns the holder's combined position value as 18-decimal USD.
    function totalValueOf(address holder) external view returns (uint256 totalUsdValue) {
        _checkSequencer();

        uint256 valueContractCount = _valueContracts.length;
        for (uint256 i = 0; i < valueContractCount; ++i) {
            IPrivateCreditToken valueContract = IPrivateCreditToken(_valueContracts[i]);
            // Valuation must query each owner-configured source.
            // slither-disable-next-line calls-loop
            address stablecoin = valueContract.stablecoin();
            OracleConfig memory config = _oracleByStablecoin[stablecoin];
            if (config.feed == address(0)) revert MissingOracle(stablecoin);

            uint256 price = _readPrice(config.feed, config.maxAge, config.feedDecimals);
            // Valuation must query each owner-configured source.
            // slither-disable-next-line calls-loop
            totalUsdValue += Math.mulDiv(
                valueContract.totalValueOf(holder),
                price,
                10 ** uint256(config.stablecoinDecimals)
            );
        }
    }

    /// @notice Replaces the complete list of private-credit value sources.
    function setValueContracts(address[] calldata valueContracts_) external onlyOwner {
        _setValueContracts(valueContracts_);
    }

    /// @notice Adds or replaces the USD oracle used for one stablecoin.
    function setOracle(address stablecoin, address feed, uint32 maxAge) external onlyOwner {
        _setOracle(stablecoin, feed, maxAge);
    }

    /// @notice Removes a stablecoin oracle. Valuation reverts while a listed source still uses it.
    function removeOracle(address stablecoin) external onlyOwner {
        if (_oracleByStablecoin[stablecoin].feed == address(0)) revert MissingOracle(stablecoin);
        delete _oracleByStablecoin[stablecoin];
        emit OracleRemoved(stablecoin);
    }

    /// @notice Sets optional L2 sequencer protection; pass zero values to disable it on L1.
    function setSequencerOracle(address feed, uint32 gracePeriod) external onlyOwner {
        _setSequencerOracle(feed, gracePeriod);
    }

    /// @notice Returns the configured private-credit value sources.
    function getValueContracts() external view returns (address[] memory) {
        return _valueContracts;
    }

    /// @notice Returns the cached USD oracle configuration for a stablecoin.
    function oracleConfig(address stablecoin) external view returns (OracleConfig memory) {
        return _oracleByStablecoin[stablecoin];
    }

    /// @notice Returns the optional L2 sequencer feed and recovery grace period.
    function sequencerOracle() external view returns (address feed, uint32 gracePeriod) {
        return (_sequencerFeed, _sequencerGracePeriod);
    }

    function _setValueContracts(address[] calldata valueContracts_) private {
        delete _valueContracts;

        for (uint256 i = 0; i < valueContracts_.length; ++i) {
            address valueContract = valueContracts_[i];
            if (valueContract == address(0) || valueContract.code.length == 0) {
                revert InvalidValueContract(valueContract);
            }
            for (uint256 j = 0; j < i; ++j) {
                if (valueContracts_[j] == valueContract) revert DuplicateValueContract(valueContract);
            }
            _valueContracts.push(valueContract);
        }

        emit ValueContractsUpdated(valueContracts_);
    }

    function _setOracle(address stablecoin, address feed, uint32 maxAge) private {
        if (stablecoin == address(0) || feed == address(0)) revert ZeroAddress();
        if (stablecoin.code.length == 0 || feed.code.length == 0 || maxAge == 0) {
            revert InvalidOracleConfiguration();
        }

        // Initialization may batch owner-configured oracles; metadata is read once and cached.
        // slither-disable-next-line calls-loop
        uint8 stablecoinDecimals = IERC20Metadata(stablecoin).decimals();
        if (stablecoinDecimals > MAX_SUPPORTED_DECIMALS) {
            revert UnsupportedTokenDecimals(stablecoin, stablecoinDecimals);
        }
        // Initialization may batch owner-configured oracles; metadata is read once and cached.
        // slither-disable-next-line calls-loop
        uint8 feedDecimals = IChainlinkAggregatorV3(feed).decimals();
        if (feedDecimals > MAX_SUPPORTED_DECIMALS) revert UnsupportedOracleDecimals(feed, feedDecimals);

        _oracleByStablecoin[stablecoin] = OracleConfig({
            feed: feed,
            maxAge: maxAge,
            stablecoinDecimals: stablecoinDecimals,
            feedDecimals: feedDecimals
        });
        emit OracleUpdated(stablecoin, feed, maxAge);
    }

    function _setSequencerOracle(address feed, uint32 gracePeriod) private {
        if ((feed == address(0)) != (gracePeriod == 0) || (feed != address(0) && feed.code.length == 0))
            revert InvalidOracleConfiguration();

        _sequencerFeed = feed;
        _sequencerGracePeriod = gracePeriod;
        emit SequencerOracleUpdated(feed, gracePeriod);
    }

    function _readPrice(address feed, uint32 maxAge, uint8 feedDecimals) private view returns (uint256) {
        // Only answer and updatedAt affect price validation.
        // Valuation must read the mapped feed for each configured source.
        // slither-disable-next-line unused-return,calls-loop
        (, int256 answer, , uint256 updatedAt, ) = IChainlinkAggregatorV3(feed).latestRoundData();
        // solhint-disable-next-line gas-strict-inequalities
        if (answer <= 0) revert InvalidOracleAnswer(feed, answer);
        if (updatedAt == 0 || updatedAt > block.timestamp) revert InvalidOracleTimestamp(feed, updatedAt);
        // Oracle freshness is intentionally defined in block-timestamp seconds.
        // slither-disable-next-line timestamp
        if (block.timestamp - updatedAt > maxAge) revert StaleOracleAnswer(feed, updatedAt, maxAge);
        return Math.mulDiv(uint256(answer), USD_SCALE, 10 ** uint256(feedDecimals));
    }

    function _checkSequencer() private view {
        address feed = _sequencerFeed;
        if (feed == address(0)) return;

        // Only uptime answer and recovery start affect the sequencer gate.
        // slither-disable-next-line unused-return
        (, int256 answer, uint256 startedAt, , ) = IChainlinkAggregatorV3(feed).latestRoundData();
        if (answer != 0) revert SequencerDown();
        if (startedAt > block.timestamp) revert InvalidOracleTimestamp(feed, startedAt);
        uint256 gracePeriod = _sequencerGracePeriod;
        // Sequencer recovery is intentionally defined in block-timestamp seconds.
        // solhint-disable gas-strict-inequalities
        // slither-disable-next-line timestamp
        if (startedAt == 0 || block.timestamp - startedAt <= gracePeriod) {
            revert SequencerGracePeriodNotElapsed(startedAt, gracePeriod);
        }
        // solhint-enable gas-strict-inequalities
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // slither-disable-next-line naming-convention,unused-state
    uint256[47] private __gap;
}
