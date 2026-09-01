// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ArcAirdropCampaign} from "../contracts/ArcAirdropCampaign.sol";

interface Vm {
    function deal(address account, uint256 newBalance) external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
    function warp(uint256 newTimestamp) external;
}

contract ReentrantRecipient {
    ArcAirdropCampaign private immutable _campaign;
    bytes32 private immutable _campaignId;
    bool private _attempted;

    constructor(ArcAirdropCampaign campaign, bytes32 campaignId) {
        _campaign = campaign;
        _campaignId = campaignId;
    }

    function claim() external {
        _campaign.claim(_campaignId);
    }

    receive() external payable {
        if (!_attempted) {
            _attempted = true;
            try _campaign.claim(_campaignId) {} catch {}
        }
    }
}

contract RejectingRecipient {
    ArcAirdropCampaign private immutable _campaign;
    bytes32 private immutable _campaignId;

    constructor(ArcAirdropCampaign campaign, bytes32 campaignId) {
        _campaign = campaign;
        _campaignId = campaignId;
    }

    function claim() external {
        _campaign.claim(_campaignId);
    }

    receive() external payable {
        revert("reject transfer");
    }
}

contract ArcAirdropCampaignTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ArcAirdropCampaign private campaign;
    address private constant OWNER = address(0xA11CE);
    address private constant RECIPIENT = address(0xB0B);
    address private constant ATTACKER = address(0xBAD);

    function setUp() public {
        campaign = new ArcAirdropCampaign();
        vm.deal(OWNER, 100 ether);
        vm.deal(ATTACKER, 100 ether);
    }

    function testRejectsCampaignIdNotBoundToCaller() public {
        string memory label = "owner-campaign";
        bytes32 ownerCampaignId = _campaignId(OWNER, label);
        (address[] memory recipients, uint256[] memory amounts) = _singleAllocation(RECIPIENT, 1 ether);

        bytes32 attackerCampaignId = _campaignId(ATTACKER, label);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcAirdropCampaign.InvalidCampaignId.selector,
                attackerCampaignId,
                ownerCampaignId
            )
        );
        vm.prank(ATTACKER);
        campaign.createCampaign{value: 1 ether}(
            ownerCampaignId,
            recipients,
            amounts,
            1 hours,
            label
        );
    }

    function testOwnerCannotCloseBeforeExpiry() public {
        (bytes32 campaignId, uint64 closesAt) = _createCampaign(
            OWNER,
            RECIPIENT,
            1 ether,
            1 hours,
            "protected-window"
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                ArcAirdropCampaign.CampaignActive.selector,
                campaignId,
                closesAt
            )
        );
        vm.prank(OWNER);
        campaign.closeCampaign(campaignId);
    }

    function testNonOwnerCannotCloseExpiredCampaign() public {
        (bytes32 campaignId, uint64 closesAt) = _createCampaign(
            OWNER,
            RECIPIENT,
            1 ether,
            1 hours,
            "owner-only-close"
        );

        vm.warp(uint256(closesAt) + 1);
        vm.expectRevert(abi.encodeWithSelector(ArcAirdropCampaign.Unauthorized.selector));
        vm.prank(ATTACKER);
        campaign.closeCampaign(campaignId);
    }

    function testOwnerReceivesOnlyRemainingFundsAfterExpiry() public {
        string memory label = "expiry-refund";
        bytes32 campaignId = _campaignId(OWNER, label);
        address[] memory recipients = new address[](2);
        recipients[0] = RECIPIENT;
        recipients[1] = ATTACKER;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1 ether;
        amounts[1] = 2 ether;

        vm.prank(OWNER);
        campaign.createCampaign{value: 3 ether}(
            campaignId,
            recipients,
            amounts,
            1 hours,
            label
        );

        vm.prank(RECIPIENT);
        campaign.claim(campaignId);

        uint64 closesAt = campaign.getCampaign(campaignId).closesAt;
        uint256 ownerBalanceBefore = OWNER.balance;

        vm.warp(uint256(closesAt) + 1);
        vm.prank(OWNER);
        campaign.closeCampaign(campaignId);

        ArcAirdropCampaign.Campaign memory result = campaign.getCampaign(campaignId);
        assert(result.closed);
        assert(OWNER.balance == ownerBalanceBefore + 2 ether);
        assert(RECIPIENT.balance == 1 ether);
        assert(result.totalClaimed == 1 ether);
    }

    function testExpiredAllocationIsNotClaimable() public {
        (bytes32 campaignId, uint64 closesAt) = _createCampaign(
            OWNER,
            RECIPIENT,
            1 ether,
            1 hours,
            "expired-allocation"
        );

        vm.warp(uint256(closesAt) + 1);
        (uint256 allocation, bool claimed, uint256 claimable) = campaign.getAllocation(campaignId, RECIPIENT);
        assert(allocation == 1 ether);
        assert(!claimed);
        assert(claimable == 0);

        vm.expectRevert(abi.encodeWithSelector(ArcAirdropCampaign.CampaignExpired.selector, campaignId));
        vm.prank(RECIPIENT);
        campaign.claim(campaignId);
    }

    function testReentrantRecipientCannotClaimTwice() public {
        string memory label = "reentrancy";
        bytes32 campaignId = _campaignId(OWNER, label);
        ReentrantRecipient recipient = new ReentrantRecipient(campaign, campaignId);
        (address[] memory recipients, uint256[] memory amounts) = _singleAllocation(
            address(recipient),
            3 ether
        );

        vm.prank(OWNER);
        campaign.createCampaign{value: 3 ether}(
            campaignId,
            recipients,
            amounts,
            1 hours,
            label
        );

        recipient.claim();

        ArcAirdropCampaign.Campaign memory result = campaign.getCampaign(campaignId);
        (, bool claimed, uint256 claimable) = campaign.getAllocation(campaignId, address(recipient));
        assert(claimed);
        assert(claimable == 0);
        assert(result.totalClaimed == 3 ether);
        assert(address(recipient).balance == 3 ether);
    }

    function testTransferFailureDoesNotConsumeClaim() public {
        string memory label = "failed-transfer";
        bytes32 campaignId = _campaignId(OWNER, label);
        RejectingRecipient recipient = new RejectingRecipient(campaign, campaignId);
        (address[] memory recipients, uint256[] memory amounts) = _singleAllocation(
            address(recipient),
            2 ether
        );

        vm.prank(OWNER);
        campaign.createCampaign{value: 2 ether}(
            campaignId,
            recipients,
            amounts,
            1 hours,
            label
        );

        vm.expectRevert(abi.encodeWithSelector(ArcAirdropCampaign.TransferFailed.selector));
        recipient.claim();

        ArcAirdropCampaign.Campaign memory result = campaign.getCampaign(campaignId);
        (, bool claimed, uint256 claimable) = campaign.getAllocation(campaignId, address(recipient));
        assert(!claimed);
        assert(claimable == 2 ether);
        assert(result.totalClaimed == 0);
    }

    function testRejectsRecipientBatchAboveLimit() public {
        uint256 count = campaign.MAX_RECIPIENTS() + 1;
        address[] memory recipients = new address[](count);
        uint256[] memory amounts = new uint256[](count);
        for (uint256 i = 0; i < count; i += 1) {
            recipients[i] = address(uint160(i + 1));
            amounts[i] = 1;
        }

        string memory label = "oversized";
        bytes32 campaignId = _campaignId(OWNER, label);
        vm.expectRevert(
            abi.encodeWithSelector(
                ArcAirdropCampaign.TooManyRecipients.selector,
                count,
                campaign.MAX_RECIPIENTS()
            )
        );
        vm.prank(OWNER);
        campaign.createCampaign{value: count}(
            campaignId,
            recipients,
            amounts,
            1 hours,
            label
        );
    }

    function _createCampaign(
        address owner,
        address recipient,
        uint256 amount,
        uint64 duration,
        string memory label
    ) private returns (bytes32 campaignId, uint64 closesAt) {
        campaignId = _campaignId(owner, label);
        (address[] memory recipients, uint256[] memory amounts) = _singleAllocation(recipient, amount);
        vm.prank(owner);
        campaign.createCampaign{value: amount}(
            campaignId,
            recipients,
            amounts,
            duration,
            label
        );
        closesAt = campaign.getCampaign(campaignId).closesAt;
    }

    function _campaignId(address owner, string memory label) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, label));
    }

    function _singleAllocation(address recipient, uint256 amount)
        private
        pure
        returns (address[] memory recipients, uint256[] memory amounts)
    {
        recipients = new address[](1);
        amounts = new uint256[](1);
        recipients[0] = recipient;
        amounts[0] = amount;
    }
}
