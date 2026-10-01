// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title BRTypes — shared types for Bookrunner.
/// @notice Units (protocol-wide, see docs/ARCHITECTURE.md §Units):
///   - USD amounts: 6 decimals (USDC units). `...Usd` suffix.
///   - Tranche shares: 6 decimals. 1 share == 1 USDC unit at window close.
///   - Prices: 1e18 (WAD) USD per 1 whole unit of the underlying.
///   - Stock Token multiplier: 1e18 (WAD) shares-of-underlying per 1 whole token.
///   - bps: 1e4 = 100%.
library BRTypes {
    /// @dev Charter.venue
    uint8 internal constant VENUE_ORDERLY = 0;
    uint8 internal constant VENUE_POOL_ENGINE = 1;

    /// @dev Charter.oracle
    uint8 internal constant ORACLE_CHAINLINK = 0;
    uint8 internal constant ORACLE_ATTESTED = 1;

    /// @dev Tranche kinds
    uint8 internal constant SENIOR = 0;
    uint8 internal constant JUNIOR = 1;

    /// @dev Venue sub-accounts held by a book
    uint8 internal constant ACCOUNT_IF = 0; // insurance fund
    uint8 internal constant ACCOUNT_MM = 1; // market-making margin / pool liquidity

    /// @dev Revenue sources reported to RevenueRouter.notifySettlement
    uint8 internal constant SRC_VENUE_TAKER_SHARE = 0; // Orderly builder 50% of base taker fees
    uint8 internal constant SRC_ENGINE_FEES = 1; // in-house engine taker/maker fees
    uint8 internal constant SRC_FUNDING = 2; // funding received net of paid
    uint8 internal constant SRC_LIQUIDATION = 3; // in-house liquidation fees
    uint8 internal constant SRC_OTHER = 4;

    enum CharterStatus {
        None,
        Filed, // awaiting jury + committee (48h)
        Approved, // book created
        Rejected, // fee refunded, bond unlocked
        Expired, // no decision within 48h; treated as rejected
        Retired // book wound down; bond released
    }

    enum BookState {
        Subscription, // window open: commitments accepted
        Cancelled, // window failed checks; all commitments refundable 1:1
        Live, // capital deployed; marks + redemptions running
        Retiring, // retire() filed: quoting stops, inventory flattened, IF recalled
        Retired // final mark applied: redemptions honoured immediately at final price
    }

    /// @notice MM mandate letter. Enforced on-chain for on-chain legs (MMMandate) and mirrored by the
    ///         risk service for venue quoting. Semantics are normative — see ARCHITECTURE.md §Mandate.
    struct Mandate {
        uint128 maxInventoryUsd; // max |net MM position notional| on venue (book's directional exposure)
        int16 maxSkewBps; // max |quote mid - oracle| / oracle, bps (quote skew used to mean-revert)
        uint16 minQuoteWidthBps; // min (ask - bid) / mid, bps
        uint16 maxHedgeLeverage; // perp hedge legs: max leverage in 0.01x units (100 = 1.00x). Spot = 1x.
        uint16 hedgeRatioMinBps; // hedge band lower bound: |hedge notional| / |inventory| (bps)
        uint16 hedgeRatioMaxBps; // hedge band upper bound
        bool noNewRiskOffHours; // off-hours (feed held / session closed) => reduce-only everywhere
        int16 killAtDrawdownBps; // book-level drawdown from high-water performance index, e.g. -800
        bytes32 hedgeAllowRoot; // StandardMerkleTree root over (bytes32 asset, bytes32 venue)
    }

    /// @notice Charter filed by a sponsor. Fields up to `sponsor` are verbatim from the spec; the
    ///         trailing fields are required by the flows and are documented extensions.
    struct Charter {
        bytes32 underlying; // canonical Stock Token addr (left-padded) or index id (see StockTokenRegistry)
        uint8 venue; // VENUE_ORDERLY | VENUE_POOL_ENGINE
        uint8 oracle; // ORACLE_CHAINLINK | ORACLE_ATTESTED
        bytes32 sessions; // encoded trading sessions (codec: packages/shared/src/sessions.ts)
        uint128 ifTargetUsd; // insurance-fund size; >= venue minimum (Orderly ~25k USDC/symbol, VERIFY)
        uint128 mmInventoryUsd; // MM inventory capital to deploy on venue
        Mandate mandate;
        uint16 seniorHurdleBps; // Senior's share of net fee flow (after expenses + carry); rest to Junior
        uint16 seniorCapBps; // Senior max share of book capital, e.g. 7000
        uint32 subscriptionWindow; // seconds
        uint64 juniorNoticeSeconds; // 7d default; never a gate
        address sponsor; // must hold >= 10% of Junior at close of window
        // ---- extensions ----
        uint128 perWalletCapUsd; // max commitment per wallet per window (sponsor exempt); 0 = no cap
        bytes32 symbol; // venue symbol, ASCII right-padded (e.g. "PERP_NVDA_USDC")
        uint16 takerFeeBps; // in-house venue only
        uint16 makerFeeBps; // in-house venue only
    }

    /// @notice Addresses of one book's components. bookId == charterId.
    struct BookComponents {
        address book;
        address senior;
        address junior;
        address vault;
        address mandate;
        address router;
        address desk;
        address adapter;
    }

    /// @notice Mark payload signed (EIP-712) by a MARK_SIGNER. See IMarkRegistry for the typehash.
    struct MarkInput {
        uint256 bookId;
        uint64 periodEnd; // multiple of config.markInterval()
        uint256 navUsd; // informational total book NAV computed off-chain
        uint256 deployedValueUsd; // venue equity (IF + MM) + desk hedge inventory + in-transit; used on-chain
        uint64 flowNonce; // book.flowNonce() the valuation was computed against
        bytes32 inventoryRoot;
        bytes32 pnlJsonHash;
        bytes32 receiptsRoot;
    }

    struct Mark {
        MarkInput input;
        address signer;
        uint64 committedAt;
        bool applied;
    }
}
