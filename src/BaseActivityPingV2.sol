// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title BaseActivityPingV2
/// @notice Expanded minimal interaction target used by local Base workflows.
contract BaseActivityPingV2 {
    event Activity(address indexed caller, string action, uint256 timestamp);

    mapping(address => uint256) public callCount;

    // Empty calls: no storage write, event, parameter, or return value.
    function ping() external {}
    function touch() external {}
    function check() external {}
    function pulse() external {}
    function mark() external {}
    function signal() external {}
    function alive() external {}
    function tick() external {}
    function tap() external {}
    function wave() external {}
    function note() external {}
    function step() external {}
    function trace() external {}
    function echo() external {}
    function beat() external {}
    function probe() external {}
    function stamp() external {}
    function cycle() external {}
    function anchor() external {}
    function attest() external {}
    function sync() external {}
    function shift() external {}
    function route() external {}
    function track() external {}
    function point() external {}
    function watch() external {}
    function guard() external {}
    function seal() external {}
    function frame() external {}
    function flash() external {}
    function spark() external {}
    function stream() external {}
    function flow() external {}
    function relay() external {}
    function pathway() external {}
    function align() external {}
    function focus() external {}
    function scan() external {}
    function mesh() external {}
    function grid() external {}
    function field() external {}
    function proof() external {}
    function cursor() external {}
    function marker() external {}
    function sample() external {}
    function record() external {}
    function mirror() external {}
    function channel() external {}
    function motion() external {}
    function vector() external {}
    function packet() external {}
    function ledger() external {}
    function signalA() external {}
    function signalB() external {}
    function signalC() external {}
    function touchA() external {}
    function pulseA() external {}
    function anchorA() external {}
    function attestA() external {}
    function pingA() external {}
    function checkA() external {}
    function markA() external {}
    function traceA() external {}
    function probeA() external {}

    /// @notice Emits an Activity event for occasional explicit local workflow notes.
    /// @dev More expensive than empty calls because it writes a log.
    function logActivity(string calldata action) external {
        emit Activity(msg.sender, action, block.timestamp);
    }

    /// @notice Records how many times the caller used countPing.
    /// @dev More expensive than empty calls because it writes storage.
    function countPing() external {
        callCount[msg.sender] += 1;
    }

    /// @notice Read-only version helper.
    function version() external pure returns (string memory) {
        return "BaseActivityPing v2";
    }

    receive() external payable {
        revert("No ETH accepted");
    }

    fallback() external payable {
        revert("No ETH accepted");
    }
}
