// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BaseActivityPingV2} from "../src/BaseActivityPingV2.sol";

interface Vm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract DeployBaseActivityPingV2 {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (BaseActivityPingV2 deployed) {
        vm.startBroadcast();
        deployed = new BaseActivityPingV2();
        vm.stopBroadcast();
    }
}
