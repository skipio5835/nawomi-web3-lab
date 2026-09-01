// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract BaseActivityToken is ERC20, ERC20Burnable, ERC20Permit, Ownable {
    uint256 public immutable maxSupply;

    error MaxSupplyBelowInitialSupply(uint256 initialSupply, uint256 maxSupply);
    error MaxSupplyExceeded(uint256 requestedSupply, uint256 maxSupply);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply_,
        uint256 maxSupply_,
        address initialOwner_
    ) ERC20(name_, symbol_) ERC20Permit(name_) Ownable(initialOwner_) {
        if (maxSupply_ < initialSupply_) {
            revert MaxSupplyBelowInitialSupply(initialSupply_, maxSupply_);
        }

        maxSupply = maxSupply_;
        _mint(initialOwner_, initialSupply_);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        uint256 requestedSupply = totalSupply() + amount;
        if (requestedSupply > maxSupply) {
            revert MaxSupplyExceeded(requestedSupply, maxSupply);
        }

        _mint(to, amount);
    }
}
