// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ExitGuard} from "../src/ExitGuard.sol";

/// Stand-in for the Reactivity precompile at 0x0100: records subscriptions with their owner (msg.sender).
contract MockPrecompile {
    struct Sub {
        ExitGuard.SubscriptionData d;
        address owner;
        bool active;
    }

    uint256 public nextId;
    bool public failSubscribe;
    bool public failUnsubscribe;
    bool public hugeId;
    mapping(uint256 => Sub) internal subs;
    uint256 public subscribeCalls;
    uint256 public unsubscribeCalls;

    function setFail(bool subFail, bool unsubFail) external {
        failSubscribe = subFail;
        failUnsubscribe = unsubFail;
    }

    function setHugeId(bool v) external {
        hugeId = v;
    }

    function subscribe(ExitGuard.SubscriptionData calldata d) external returns (uint256 id) {
        require(!failSubscribe, "subscribe refused");
        require(msg.sender.balance >= 32 ether, "owner below 32");
        subscribeCalls++;
        id = hugeId ? uint256(type(uint64).max) + 1 : 1_000 + (++nextId);
        subs[id].d = d;
        subs[id].owner = msg.sender;
        subs[id].active = true;
    }

    function unsubscribe(uint256 id) external {
        require(!failUnsubscribe, "unsubscribe refused");
        require(subs[id].active && subs[id].owner == msg.sender, "not owner");
        unsubscribeCalls++;
        subs[id].active = false;
    }

    /// A one-shot Schedule fired: the precompile removes it.
    function consume(uint256 id) external {
        subs[id].active = false;
    }

    function activeCount(address owner) external view returns (uint256 n) {
        for (uint256 i = 1001; i <= 1000 + nextId; i++) if (subs[i].active && subs[i].owner == owner) n++;
    }

    function sub(uint256 id) external view returns (ExitGuard.SubscriptionData memory d, address owner, bool active) {
        return (subs[id].d, subs[id].owner, subs[id].active);
    }
}

contract MockMarginBank {
    struct Position {
        int128 size;
        uint128 avgEntryPrice;
        int256 entryFundingIndex;
        uint64 lastUpdatedTimestampNs;
    }

    mapping(address => mapping(address => int128)) public size;

    function setSize(address account, address pool, int128 s) external {
        size[account][pool] = s;
    }

    /// Only a pool may move a position (as the real MarginBank does on fills).
    function applyFill(address account, int128 delta) external {
        size[account][msg.sender] += delta;
    }

    function getPosition(address account, address pool) external view returns (Position memory p) {
        p.size = size[account][pool];
    }
}

/// A perp pool: settable mark and book parameters; placeOrder fills a set fraction for the caller, or reverts.
contract MockPool {
    error ImmediateOrCancelNoFill();

    MockMarginBank public bank;
    address public reportedBank;
    bool public markOk = true;
    uint256 public mark;
    bool public markReverts;
    uint256 public tick;
    uint256 public minQty;
    uint256 public lot;
    uint16 public fillBps = 10_000; // share of each order that fills
    uint8 public mode;              // 0 fill, 1 revert IOC no fill, 2 revert empty, 3 re-enter the caller
    bytes public reenterCall;
    bool public reenterOk;

    struct Order {
        address sender;
        bool isBid;
        uint64 userData;
        uint256 price;
        uint256 quantity;
        uint64 expireNs;
        uint8 orderType;
        uint8 selfMatch;
        address builder;
        uint96 builderFee;
        uint256 value;
    }

    Order[] internal orders;

    constructor(MockMarginBank b, uint256 tick_, uint256 minQty_, uint256 lot_) {
        bank = b;
        reportedBank = address(b);
        tick = tick_;
        minQty = minQty_;
        lot = lot_;
    }

    function setMark(bool ok_, uint256 m) external {
        markOk = ok_;
        mark = m;
    }

    function setMarkReverts(bool v) external {
        markReverts = v;
    }

    function setReportedBank(address a) external {
        reportedBank = a;
    }

    function setMode(uint8 m, uint16 fill) external {
        mode = m;
        fillBps = fill;
    }

    function setReenter(bytes calldata data) external {
        mode = 3;
        reenterCall = data;
    }

    function marginBank() external view returns (address) {
        return reportedBank;
    }

    function tryGetMarkPrice() external view returns (bool, uint256) {
        require(!markReverts, "oracle down");
        return (markOk, mark);
    }

    function getOrderBookParameters() external view returns (uint256, uint256, uint256) {
        return (tick, minQty, lot);
    }

    function placeOrder(
        bool isBid,
        uint64 userData,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k
    ) external payable returns (bool, uint128) {
        if (mode == 1) revert ImmediateOrCancelNoFill();
        if (mode == 2) revert();
        if (mode == 3) {
            (reenterOk,) = msg.sender.call(reenterCall);
        }
        orders.push(Order(msg.sender, isBid, userData, price, quantity, expireTimestampNs, orderType, selfMatchingOption, builder, builderFeeBpsTimes1k, msg.value));
        uint256 filled = (quantity * fillBps) / 10_000;
        if (lot > 1) filled -= filled % lot;
        int128 d = int128(int256(filled));
        bank.applyFill(msg.sender, isBid ? d : -d);
        return (true, uint128(orders.length));
    }

    function orderCount() external view returns (uint256) {
        return orders.length;
    }

    function order(uint256 i) external view returns (Order memory) {
        return orders[i];
    }
}
