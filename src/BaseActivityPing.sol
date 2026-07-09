// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title BaseActivityPing
/// @notice Low-cost direct-call target for creating Base mainnet Contract Call history from the caller wallet.
contract BaseActivityPing {
    event Activity(address indexed caller, string action, uint256 timestamp);

    mapping(address => uint256) public callCount;

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function ping() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function touch() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function check() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function pulse() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function mark() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function signal() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function alive() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function tick() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function tap() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function wave() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function note() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function step() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function trace() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function echo() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function beat() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function probe() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function stamp() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function cycle() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function anchor() external {}

    // Ultra-low-gas activity call.
    // No storage write, no event, no parameter, no return.
    // The transaction itself remains visible from the caller wallet on BaseScan.
    function attest() external {}

    /// @notice Emits an Activity event for occasional, more explicit history.
    /// @dev More expensive than empty calls because it writes a log; longer action strings add calldata cost.
    function logActivity(string calldata action) external {
        emit Activity(msg.sender, action, block.timestamp);
    }

    /// @notice Records how many times the caller used countPing.
    /// @dev More expensive than empty calls because it writes storage; use only when an on-contract count matters.
    function countPing() external {
        callCount[msg.sender] += 1;
    }

    /// @notice Read-only version helper.
    /// @dev Usually queried with eth_call; it does not need a transaction for wallet activity history.
    function version() external pure returns (string memory) {
        return "BaseActivityPing v1";
    }

    receive() external payable {
        revert("No ETH accepted");
    }

    fallback() external payable {
        revert("No ETH accepted");
    }
}
