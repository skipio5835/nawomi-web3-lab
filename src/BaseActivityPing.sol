// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title BaseActivityPing
/// @notice Minimal no-op interaction target used by local Base workflows.
contract BaseActivityPing {
    event Activity(address indexed caller, string action, uint256 timestamp);

    mapping(address => uint256) public callCount;

    // No storage write, event, parameter, or return value.
    function ping() external {}

    // No storage write, event, parameter, or return value.
    function touch() external {}

    // No storage write, event, parameter, or return value.
    function check() external {}

    // No storage write, event, parameter, or return value.
    function pulse() external {}

    // No storage write, event, parameter, or return value.
    function mark() external {}

    // No storage write, event, parameter, or return value.
    function signal() external {}

    // No storage write, event, parameter, or return value.
    function alive() external {}

    // No storage write, event, parameter, or return value.
    function tick() external {}

    // No storage write, event, parameter, or return value.
    function tap() external {}

    // No storage write, event, parameter, or return value.
    function wave() external {}

    // No storage write, event, parameter, or return value.
    function note() external {}

    // No storage write, event, parameter, or return value.
    function step() external {}

    // No storage write, event, parameter, or return value.
    function trace() external {}

    // No storage write, event, parameter, or return value.
    function echo() external {}

    // No storage write, event, parameter, or return value.
    function beat() external {}

    // No storage write, event, parameter, or return value.
    function probe() external {}

    // No storage write, event, parameter, or return value.
    function stamp() external {}

    // No storage write, event, parameter, or return value.
    function cycle() external {}

    // No storage write, event, parameter, or return value.
    function anchor() external {}

    // No storage write, event, parameter, or return value.
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
    /// @dev Usually queried with eth_call.
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
