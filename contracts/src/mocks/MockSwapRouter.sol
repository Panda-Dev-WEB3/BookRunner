// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapRouter02} from "../interfaces/external/ISwapRouter02.sol";
import {IAttestedOracle} from "../interfaces/IAttestedOracle.sol";
import {MockERC20} from "./MockERC20.sol";

/// @title MockSwapRouter — devnet/test stand-in for Uniswap v3 SwapRouter02 (`exactInputSingle`, `exactInput`).
/// @notice NEVER deploy to mainnet. Fills swaps at a deterministic price, from its own inventory or by
///         minting `MockERC20` output tokens flagged `mintOnDemand`. Used for BKRN buybacks (USDC -> BKRN)
///         and desk hedges (USDC <-> Stock Token).
///
///         Price resolution for (tokenIn -> tokenOut), first match wins:
///           1. an explicit pair price `pairPrice[tokenIn][tokenOut]` (WAD: whole tokenOut per whole tokenIn)
///           2. USD valuations of both tokens: a fixed `usdPrice` (e.g. USDC = 1e18) or an oracle feed
///              (`IAttestedOracle.priceOf(priceId) * multiplierWad / 1e18`, WAD USD per whole token).
///         Amounts are decimals-aware: `out = in * price * 10^decOut / (10^decIn * 1e18)`, floored, after
///         an optional input fee `feeBps`.
contract MockSwapRouter is ISwapRouter02, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    struct OracleFeed {
        address oracle;
        bytes32 priceId;
        uint256 multiplierWad;
    }

    /// @notice Explicit pair price: whole `tokenOut` per whole `tokenIn` (WAD).
    mapping(address tokenIn => mapping(address tokenOut => uint256 priceWad)) public pairPrice;
    /// @notice Fixed USD price per whole token (WAD), e.g. 1e18 for USDC.
    mapping(address token => uint256 priceWad) public usdPrice;
    /// @notice Oracle-backed USD price per whole token (Stock Tokens / index tokens).
    mapping(address token => OracleFeed) public oracleFeed;
    /// @notice Output tokens the router may mint when its inventory is short (MockERC20 only).
    mapping(address token => bool) public mintOnDemand;
    /// @notice Input fee in bps (Uniswap-style, taken from `amountIn`). Default 0.
    uint16 public feeBps;

    error NoPrice(address tokenIn, address tokenOut);
    error SameToken();
    error ZeroAmount();
    error ZeroAddress();
    error EthNotAccepted();
    error TooLittleReceived(uint256 amountOut, uint256 minimum);
    error InsufficientLiquidity(address token, uint256 available, uint256 required);
    error InvalidFee(uint16 feeBps);

    event PairPriceSet(address indexed tokenIn, address indexed tokenOut, uint256 priceWad);
    event UsdPriceSet(address indexed token, uint256 priceWad);
    event OracleFeedSet(address indexed token, address oracle, bytes32 priceId, uint256 multiplierWad);
    event MintOnDemandSet(address indexed token, bool enabled);
    event FeeSet(uint16 feeBps);
    event Swap(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );

    constructor(address owner_) Ownable(owner_) {}

    // ---------------------------------------------------------------------------------------------
    // Owner configuration
    // ---------------------------------------------------------------------------------------------

    /// @notice Sets the one-way price for `tokenIn -> tokenOut` (whole tokenOut per whole tokenIn, WAD).
    ///         Zero clears it (falls back to USD valuations).
    function setPrice(address tokenIn, address tokenOut, uint256 priceWad) external onlyOwner {
        _setPairPrice(tokenIn, tokenOut, priceWad);
    }

    /// @notice Sets `tokenA -> tokenB` at `priceWad` and the inverse `tokenB -> tokenA` at `1e36 / priceWad`.
    function setPriceBoth(address tokenA, address tokenB, uint256 priceWad) external onlyOwner {
        if (priceWad == 0) revert ZeroAmount();
        _setPairPrice(tokenA, tokenB, priceWad);
        _setPairPrice(tokenB, tokenA, (WAD * WAD) / priceWad);
    }

    /// @notice Fixed USD price per whole token (WAD). Zero clears it.
    function setUsdPrice(address token, uint256 priceWad) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        usdPrice[token] = priceWad;
        emit UsdPriceSet(token, priceWad);
    }

    /// @notice Prices `token` from `IAttestedOracle(oracle).priceOf(priceId)` times `multiplierWad`
    ///         (shares of underlying per whole token). `oracle == 0` clears the feed.
    function setOracleFeed(address token, address oracle, bytes32 priceId, uint256 multiplierWad)
        external
        onlyOwner
    {
        if (token == address(0)) revert ZeroAddress();
        if (oracle != address(0) && multiplierWad == 0) revert ZeroAmount();
        oracleFeed[token] = OracleFeed({oracle: oracle, priceId: priceId, multiplierWad: multiplierWad});
        emit OracleFeedSet(token, oracle, priceId, multiplierWad);
    }

    /// @notice Allows the router to mint `token` (must be a MockERC20) to cover output shortfalls.
    function setMintOnDemand(address token, bool enabled) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        mintOnDemand[token] = enabled;
        emit MintOnDemandSet(token, enabled);
    }

    /// @notice Input fee in bps (< 10000).
    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps >= BPS) revert InvalidFee(newFeeBps);
        feeBps = newFeeBps;
        emit FeeSet(newFeeBps);
    }

    /// @notice Withdraws router inventory.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Swaps
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc ISwapRouter02
    /// @dev Pulls `amountIn` of `tokenIn` from the caller, pays `quote` of `tokenOut` to `recipient`.
    ///      `fee` and `sqrtPriceLimitX96` are ignored. Reverts if the output is below `amountOutMinimum`.
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        if (msg.value != 0) revert EthNotAccepted();
        if (params.amountIn == 0) revert ZeroAmount();
        if (params.recipient == address(0)) revert ZeroAddress();
        amountOut = quote(params.tokenIn, params.tokenOut, params.amountIn);
        if (amountOut < params.amountOutMinimum) {
            revert TooLittleReceived(amountOut, params.amountOutMinimum);
        }

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        uint256 available = IERC20(params.tokenOut).balanceOf(address(this));
        if (available < amountOut) {
            if (!mintOnDemand[params.tokenOut]) {
                revert InsufficientLiquidity(params.tokenOut, available, amountOut);
            }
            MockERC20(params.tokenOut).mint(address(this), amountOut - available);
        }
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
        emit Swap(msg.sender, params.tokenIn, params.tokenOut, params.amountIn, amountOut, params.recipient);
    }

    /// @inheritdoc ISwapRouter02
    /// @dev Multi-hop: decodes the packed v3 path (token, fee, token, ...), prices each hop with `quote`
    ///      (fees ignored, `feeBps` charged per hop), pulls the input from the caller and pays the final
    ///      output to `recipient`. Intermediate tokens never move (devnet stand-in only).
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        if (msg.value != 0) revert EthNotAccepted();
        if (params.amountIn == 0) revert ZeroAmount();
        if (params.recipient == address(0)) revert ZeroAddress();
        bytes calldata path = params.path;
        if (path.length < 43 || (path.length - 20) % 23 != 0) revert NoPrice(address(0), address(0));
        uint256 hops = (path.length - 20) / 23;
        address tokenIn = _hopIn(path, 0);
        address tokenOut = tokenIn;
        amountOut = params.amountIn;
        for (uint256 i; i < hops; ++i) {
            tokenOut = _hopIn(path, i + 1);
            amountOut = quote(_hopIn(path, i), tokenOut, amountOut);
        }
        if (amountOut < params.amountOutMinimum) revert TooLittleReceived(amountOut, params.amountOutMinimum);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        uint256 available = IERC20(tokenOut).balanceOf(address(this));
        if (available < amountOut) {
            if (!mintOnDemand[tokenOut]) revert InsufficientLiquidity(tokenOut, available, amountOut);
            MockERC20(tokenOut).mint(address(this), amountOut - available);
        }
        IERC20(tokenOut).safeTransfer(params.recipient, amountOut);
        emit Swap(msg.sender, tokenIn, tokenOut, params.amountIn, amountOut, params.recipient);
    }

    function _hopIn(bytes calldata path, uint256 i) private pure returns (address) {
        uint256 o = 23 * i;
        return address(bytes20(path[o:o + 20]));
    }

    /// @notice Output for swapping `amountIn` of `tokenIn` into `tokenOut` at current prices (after fee).
    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        if (tokenIn == tokenOut) revert SameToken();
        uint256 inAfterFee = (amountIn * (BPS - feeBps)) / BPS;
        uint256 scaleIn = 10 ** IERC20Metadata(tokenIn).decimals();
        uint256 scaleOut = 10 ** IERC20Metadata(tokenOut).decimals();

        uint256 p = pairPrice[tokenIn][tokenOut];
        if (p != 0) return Math.mulDiv(inAfterFee, p * scaleOut, scaleIn * WAD);

        uint256 pIn = usdPriceOf(tokenIn);
        uint256 pOut = usdPriceOf(tokenOut);
        if (pIn == 0 || pOut == 0) revert NoPrice(tokenIn, tokenOut);
        return Math.mulDiv(inAfterFee, pIn * scaleOut, scaleIn * pOut);
    }

    /// @notice USD price per whole token (WAD): oracle feed if configured, else the fixed price, else 0.
    /// @dev Oracle reads revert with `StalePrice` when the feed is stale, like a halted market would.
    function usdPriceOf(address token) public view returns (uint256) {
        OracleFeed memory f = oracleFeed[token];
        if (f.oracle != address(0)) {
            (uint256 priceWad,) = IAttestedOracle(f.oracle).priceOf(f.priceId);
            return Math.mulDiv(priceWad, f.multiplierWad, WAD);
        }
        return usdPrice[token];
    }

    function _setPairPrice(address tokenIn, address tokenOut, uint256 priceWad) private {
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (tokenIn == tokenOut) revert SameToken();
        pairPrice[tokenIn][tokenOut] = priceWad;
        emit PairPriceSet(tokenIn, tokenOut, priceWad);
    }
}
