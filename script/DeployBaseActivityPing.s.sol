// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BaseActivityPing} from "../src/BaseActivityPing.sol";

interface Vm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract DeployBaseActivityPing {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (BaseActivityPing deployed) {
        vm.startBroadcast();
        deployed = new BaseActivityPing();
        vm.stopBroadcast();
    }
}
