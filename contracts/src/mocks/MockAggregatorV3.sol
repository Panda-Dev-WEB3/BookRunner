// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Test/devnet Chainlink AggregatorV3 (proxy-shaped reads only). Open setter — never deploy to mainnet.
contract MockAggregatorV3 {
    uint8 public immutable decimals;
    string public description;
    uint256 public constant version = 6;

    uint80 internal _roundId;
    int256 internal _answer;
    uint256 internal _startedAt;
    uint256 internal _updatedAt;

    constructor(uint8 decimals_, string memory description_) {
        decimals = decimals_;
        description = description_;
    }

    function set(int256 answer, uint256 updatedAt) external {
        _roundId++;
        _answer = answer;
        _startedAt = updatedAt;
        _updatedAt = updatedAt;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (_roundId, _answer, _startedAt, _updatedAt, _roundId);
    }
}
