// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArcAuctionHouse} from "../contracts/ArcAuctionHouse.sol";
import {ArcMarketplaceOrders} from "../contracts/ArcMarketplaceOrders.sol";
import {ArcEventTickets} from "../contracts/ArcEventTickets.sol";
import {ArcExpenseSplitter} from "../contracts/ArcExpenseSplitter.sol";
import {ArcPreorderStore} from "../contracts/ArcPreorderStore.sol";
import {ArcRefundableDeposit} from "../contracts/ArcRefundableDeposit.sol";
import {ArcRentalEscrow} from "../contracts/ArcRentalEscrow.sol";
import {ArcServiceBookings} from "../contracts/ArcServiceBookings.sol";

interface Vm {
    function deal(address account, uint256 newBalance) external;
    function prank(address msgSender) external;
    function warp(uint256 newTimestamp) external;
}

contract RejectEtherBidder {
    function bid(ArcAuctionHouse auction, bytes32 auctionId) external payable {
        auction.bid{value: msg.value}(auctionId);
    }

    function withdraw(ArcAuctionHouse auction, address payable to) external {
        auction.withdrawBidRefund(to);
    }

    receive() external payable {
        revert("reject ether");
    }
}

contract ArcSecurityFlowsTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant BUYER = address(0xB0B);
    address private constant WORKER = address(0xA11CE);
    address payable private constant TREASURY = payable(address(0xCAFE));
    address payable private constant ATTACKER = payable(address(0xBAD));

    receive() external payable {}

    function testServiceCannotSettleUncompletedBookingOrRedirectFunds() external {
        ArcServiceBookings bookings = new ArcServiceBookings();
        bytes32 serviceId = keccak256("service");
        bookings.createService(serviceId, TREASURY, 1 ether, 1, "audit", "ipfs://service");

        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        bookings.bookService{value: 1 ether}(serviceId);

        (bool earlyOk,) = address(bookings).call(
            abi.encodeCall(ArcServiceBookings.settleService, (serviceId, TREASURY))
        );
        require(!earlyOk, "uncompleted booking was settled");

        bookings.completeBooking(serviceId, 1, "ipfs://complete");
        (bool redirectOk,) = address(bookings).call(
            abi.encodeCall(ArcServiceBookings.settleService, (serviceId, ATTACKER))
        );
        require(!redirectOk, "settlement was redirected");

        uint256 beforeBalance = TREASURY.balance;
        bookings.settleService(serviceId, TREASURY);
        require(TREASURY.balance == beforeBalance + 1 ether, "earned funds not settled");
    }

    function testWorkerCannotRefundWorkOrderToSelf() external {
        ArcServiceBookings bookings = new ArcServiceBookings();
        bytes32 workOrderId = keccak256("work-order");
        bookings.createWorkOrder{value: 1 ether}(workOrderId, WORKER, "audit", "ipfs://brief");

        vm.prank(WORKER);
        (bool stolen,) = address(bookings).call(
            abi.encodeCall(ArcServiceBookings.refundWorkOrder, (workOrderId, ATTACKER))
        );
        require(!stolen, "worker stole work-order escrow");

        bookings.refundWorkOrder(workOrderId, payable(address(this)));
    }

    function testMarketplaceSettlesOnlyFulfilledOrdersToTreasury() external {
        ArcMarketplaceOrders market = new ArcMarketplaceOrders();
        bytes32 listingId = keccak256("listing");
        market.createListing(listingId, TREASURY, 1 ether, 1, "audit", "ipfs://listing");

        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        market.purchase{value: 1 ether}(listingId);

        (bool earlyOk,) = address(market).call(
            abi.encodeCall(ArcMarketplaceOrders.settleListing, (listingId, TREASURY))
        );
        require(!earlyOk, "unfulfilled order was settled");

        market.fulfillOrder(listingId, 1, "ipfs://fulfilled");
        uint256 beforeBalance = TREASURY.balance;
        market.settleListing(listingId, TREASURY);
        require(TREASURY.balance == beforeBalance + 1 ether, "fulfilled order not settled");
    }

    function testDepositCannotBeTakenBeforeDeadlineOrRedirected() external {
        ArcRefundableDeposit deposits = new ArcRefundableDeposit();
        bytes32 depositId = keccak256("deposit");
        uint64 deadline = uint64(block.timestamp + 1 days);
        deposits.createDeposit{value: 1 ether}(depositId, WORKER, deadline, "audit", "ipfs://deposit");

        (bool earlyOk,) = address(deposits).call(
            abi.encodeCall(ArcRefundableDeposit.refundDeposit, (depositId, payable(address(this)), "early"))
        );
        require(!earlyOk, "payer reclaimed before resolution window");

        vm.warp(deadline);
        vm.prank(WORKER);
        (bool redirectOk,) = address(deposits).call(
            abi.encodeCall(ArcRefundableDeposit.forfeitDeposit, (depositId, ATTACKER, "redirect"))
        );
        require(!redirectOk, "beneficiary redirected forfeiture");

        vm.prank(WORKER);
        deposits.forfeitDeposit(depositId, payable(WORKER), "resolved");
    }

    function testPayerCanReclaimDepositAfterResolutionWindow() external {
        ArcRefundableDeposit deposits = new ArcRefundableDeposit();
        bytes32 depositId = keccak256("expired-deposit");
        uint64 deadline = uint64(block.timestamp + 1 days);
        deposits.createDeposit{value: 1 ether}(depositId, WORKER, deadline, "audit", "ipfs://deposit");

        uint64 reclaimAt = deadline + deposits.RESOLUTION_WINDOW();
        vm.warp(reclaimAt);

        vm.prank(WORKER);
        (bool lateForfeitOk,) = address(deposits).call(
            abi.encodeCall(ArcRefundableDeposit.forfeitDeposit, (depositId, payable(WORKER), "late"))
        );
        require(!lateForfeitOk, "beneficiary forfeited after resolution window");

        uint256 beforeBalance = address(this).balance;
        deposits.refundDeposit(depositId, payable(address(this)), "reclaimed");
        require(address(this).balance == beforeBalance + 1 ether, "payer reclaim failed");
    }

    function testRentalOwnerCannotRedirectRenterDeposit() external {
        ArcRentalEscrow rental = new ArcRentalEscrow();
        bytes32 rentalId = keccak256("rental");
        rental.createRental(rentalId, TREASURY, 1 ether, 1 ether, "audit", "ipfs://rental");

        vm.deal(BUYER, 2 ether);
        vm.prank(BUYER);
        rental.bookRental{value: 2 ether}(rentalId);

        (bool redirectOk,) = address(rental).call(
            abi.encodeCall(ArcRentalEscrow.returnRental, (rentalId, 0, ATTACKER, "returned"))
        );
        require(!redirectOk, "renter deposit was redirected");

        uint256 beforeBalance = BUYER.balance;
        rental.returnRental(rentalId, 0, payable(BUYER), "returned");
        require(BUYER.balance == beforeBalance + 1 ether, "deposit not returned to renter");
    }

    function testRejectingBidderCannotBlockNextBid() external {
        ArcAuctionHouse auction = new ArcAuctionHouse();
        RejectEtherBidder rejectingBidder = new RejectEtherBidder();
        bytes32 auctionId = keccak256("auction");
        auction.createAuction(auctionId, TREASURY, 1 ether, 0, "audit", "ipfs://auction");

        rejectingBidder.bid{value: 1 ether}(auction, auctionId);

        vm.deal(BUYER, 2 ether);
        vm.prank(BUYER);
        auction.bid{value: 2 ether}(auctionId);
        require(auction.pendingReturn(address(rejectingBidder)) == 1 ether, "refund credit missing");

        uint256 beforeBalance = TREASURY.balance;
        rejectingBidder.withdraw(auction, TREASURY);
        require(TREASURY.balance == beforeBalance + 1 ether, "pull refund failed");
    }

    function testRejectingBidderCannotBlockAuctionCancellation() external {
        ArcAuctionHouse auction = new ArcAuctionHouse();
        RejectEtherBidder rejectingBidder = new RejectEtherBidder();
        bytes32 auctionId = keccak256("cancel-auction");
        auction.createAuction(auctionId, TREASURY, 1 ether, 0, "audit", "ipfs://auction");
        rejectingBidder.bid{value: 1 ether}(auction, auctionId);

        auction.cancelAuction(auctionId, "ipfs://cancelled");
        require(auction.pendingReturn(address(rejectingBidder)) == 1 ether, "cancel refund credit missing");
    }

    function testPreorderCannotSettleBeforeFulfillment() external {
        ArcPreorderStore store = new ArcPreorderStore();
        bytes32 productId = keccak256("product");
        store.createProduct(productId, TREASURY, 1 ether, 1, "audit", "ipfs://product");

        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        store.preorder{value: 1 ether}(productId);

        (bool earlyOk,) = address(store).call(
            abi.encodeCall(ArcPreorderStore.settleProduct, (productId, TREASURY))
        );
        require(!earlyOk, "unfulfilled preorder was settled");
    }

    function testEventSettlesOnlyCheckedInTickets() external {
        ArcEventTickets tickets = new ArcEventTickets();
        bytes32 eventId = keccak256("event");
        tickets.createEvent(eventId, TREASURY, 1 ether, 1, "audit", "ipfs://event");

        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        tickets.buyTicket{value: 1 ether}(eventId);

        (bool earlyOk,) = address(tickets).call(
            abi.encodeCall(ArcEventTickets.settleEvent, (eventId, TREASURY))
        );
        require(!earlyOk, "unchecked ticket was settled");
        tickets.checkIn(eventId, 1);
        tickets.settleEvent(eventId, TREASURY);
    }

    function testExpenseFundsCanOnlyReachConfiguredPayee() external {
        ArcExpenseSplitter splitter = new ArcExpenseSplitter();
        bytes32 expenseId = keccak256("expense");
        splitter.createExpense(expenseId, TREASURY, 1 ether, "audit", "ipfs://expense");

        vm.deal(BUYER, 1 ether);
        vm.prank(BUYER);
        splitter.contribute{value: 1 ether}(expenseId);

        (bool redirectOk,) = address(splitter).call(
            abi.encodeCall(ArcExpenseSplitter.withdraw, (expenseId, 1 ether, ATTACKER))
        );
        require(!redirectOk, "contributions were redirected");
        splitter.withdraw(expenseId, 1 ether, TREASURY);
    }
}
