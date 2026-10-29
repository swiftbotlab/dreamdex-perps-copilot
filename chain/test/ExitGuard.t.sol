// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base, Vm} from "./Base.sol";
import {ExitGuard} from "../src/ExitGuard.sol";
import {MockPrecompile, MockMarginBank, MockPool} from "./Mocks.sol";

contract Stranger {
    function call(address to, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = to.call(data);
    }
}

contract ExitGuardTest is Base {
    address constant PRECOMPILE = address(0x0100);
    bytes32 constant SCHEDULE = keccak256("Schedule(uint256)");
    bytes32 constant EPOCH_TICK = keccak256("EpochTick(uint64,uint64)");

    // reasons and kinds, as the contract defines them (restated here as the spec)
    uint8 constant SL = 1;
    uint8 constant TP = 2;
    uint8 constant END_OWNER = 1;
    uint8 constant END_FIRED = 2;
    uint8 constant END_EXPIRED = 3;
    uint8 constant END_BUDGET = 4;
    uint8 constant END_NO_POSITION = 5;
    uint8 constant END_FAILURES = 6;
    uint8 constant END_DUST = 7;

    ExitGuard impl;
    MockPrecompile pc;
    MockMarginBank bank;
    MockPool pool;
    address payable acct = payable(address(0xA11ce0000000000000000000000000000000a11c));
    ExitGuard g; // the delegating account seen through the ExitGuard ABI
    Stranger stranger;

    uint256 constant MARK = 79e18;          // HYPE-like: 79 USDso
    uint256 constant TICK = 1e16;           // 0.01
    uint256 constant MIN_QTY = 120_000;     // 0.12 HYPE at 6 decimals
    uint256 constant LOT = 10_000;          // 0.01 HYPE
    uint32 constant IV = 5_000;             // wake every 5 s

    // explicit clocks: via-IR may reuse one block.number / block.timestamp read inside a function
    uint256 internal bn = 36_000_000;
    uint256 internal ts = 1_793_250_000;

    function setUp() public {
        vm.warp(ts);
        vm.roll(bn);
        bank = new MockMarginBank();
        impl = new ExitGuard(address(bank));
        vm.etch(PRECOMPILE, type(MockPrecompile).runtimeCode);
        pc = MockPrecompile(PRECOMPILE);
        pool = new MockPool(bank, TICK, MIN_QTY, LOT);
        pool.setMark(true, MARK);
        // EIP-7702: the account's code is the delegation designator 0xef0100 || implementation
        vm.etch(acct, abi.encodePacked(hex"ef0100", address(impl)));
        vm.deal(acct, 50 ether);
        g = ExitGuard(acct);
        stranger = new Stranger();
    }

    // ---- helpers ----
    function _long(uint256 qty) internal {
        bank.setSize(acct, address(pool), int128(int256(qty)));
    }

    function _short(uint256 qty) internal {
        bank.setSize(acct, address(pool), -int128(int256(qty)));
    }

    function _arm(uint128 sl, uint128 tp) internal returns (uint64 e, uint64 t) {
        vm.prank(acct);
        (e, t) = g.arm(address(pool), sl, tp, 50, 1_000, uint64(ts + 3_600), IV);
    }

    function _topics(bytes32 a, uint256 b) internal pure returns (bytes32[] memory t) {
        t = new bytes32[](2);
        t[0] = a;
        t[1] = bytes32(b);
    }

    function _call(address emitter, bytes32[] memory topics) internal {
        vm.prank(PRECOMPILE, acct); // the chain calls with msg.sender 0x0100 and tx.origin = the subscription owner
        g.onEvent(emitter, topics, "");
    }

    /// The booked Schedule fires: time moves past it, a new block, and the chain calls with topic 1 = the time it
    /// fired in ms (as on Somnia: the booked time, rounded up to the block; the fired one-shot stays listed).
    function _wake() internal {
        ExitGuard.Stop memory s = g.stopState();
        ts = s.nextWakeMs / 1000 + 1;
        bn += 1;
        vm.warp(ts);
        vm.roll(bn);
        _call(PRECOMPILE, _topics(SCHEDULE, ts * 1000 + 52));
    }

    function _heartbeat(uint256 advanceS) internal {
        ts += advanceS;
        bn += 1;
        vm.warp(ts);
        vm.roll(bn);
        _call(PRECOMPILE, _topics(EPOCH_TICK, 1));
    }

    function _armedPool() internal view returns (address) {
        return g.stopState().pool;
    }

    // ---- constants match the protocol ----
    function test_constants() public view {
        bytes32 slot = keccak256(abi.encode(uint256(keccak256("swiftbotlab.exitguard.v2")) - 1)) & ~bytes32(uint256(0xff));
        ok(slot == 0xc983c76572b07c42bff4cf0e41302f45f894830edf2123a67df35066b4edd400, "storage slot");
        ok(vm.load(acct, slot) == bytes32(0), "slot empty before arm");
        ok(bytes4(keccak256("onEvent(address,bytes32[],bytes)")) == bytes4(0x53edf33d), "onEvent selector");
        ok(bytes4(keccak256("subscribe((bytes32[4],address,address,address,address,bytes4,uint64,uint64,uint64,bool,bool))")) == bytes4(0xc5fca91e), "subscribe selector");
        ok(bytes4(keccak256("unsubscribe(uint256)")) == bytes4(0xad0b27fb), "unsubscribe selector");
        ok(SCHEDULE == 0x67aa3d752967d87d8944b9c7adf73172518777fa4703f336edee81f0736d8987, "Schedule topic");
        ok(EPOCH_TICK == 0x2e0c8e351f738401ab3e8e932f7251c170afb7b5539cbab5d24743f09b52aec8, "EpochTick topic");
        ok(g.supportsInterface(0x01ffc9a7) && g.supportsInterface(0x53edf33d) && !g.supportsInterface(0xffffffff), "erc165");
        eq(g.VERSION(), 3, "version");
        eqA(g.MARGIN_BANK(), address(bank), "bank");
    }

    function test_storage_lives_in_the_account_not_the_implementation() public {
        _long(500_000);
        _arm(78e18, 0);
        bytes32 slot = 0xc983c76572b07c42bff4cf0e41302f45f894830edf2123a67df35066b4edd400;
        ok(vm.load(acct, slot) != bytes32(0), "account slot written");
        ok(vm.load(address(impl), slot) == bytes32(0), "implementation untouched");
    }

    // ---- who may arm ----
    function test_arm_onlySelf() public {
        _long(500_000);
        vm.expectRevert(ExitGuard.NotSelf.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, uint64(ts + 60), IV);
        vm.prank(PRECOMPILE, acct);
        vm.expectRevert(ExitGuard.NotSelf.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, uint64(ts + 60), IV);
        (bool s,) = stranger.call(acct, abi.encodeCall(ExitGuard.disarm, ()));
        ok(!s, "stranger cannot disarm");
        vm.expectRevert(ExitGuard.NotSelf.selector);
        impl.arm(address(pool), 78e18, 0, 50, 10, uint64(ts + 60), IV);
    }

    function test_arm_validation() public {
        uint64 exp = uint64(ts + 60);
        vm.prank(acct);
        vm.expectRevert(ExitGuard.NoPosition.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, exp, IV);
        _long(500_000);
        pool.setReportedBank(address(0xBEEF));
        vm.prank(acct);
        vm.expectRevert(ExitGuard.BadPool.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, exp, IV);
        pool.setReportedBank(address(bank));
        address[3] memory bad = [address(0), address(0x1234), PRECOMPILE];
        for (uint256 i; i < bad.length; i++) {
            vm.prank(acct);
            vm.expectRevert(ExitGuard.BadPool.selector);
            g.arm(bad[i], 78e18, 0, 50, 10, exp, IV);
        }
        pool.setMark(false, MARK);
        vm.prank(acct);
        vm.expectRevert(ExitGuard.NoMark.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, exp, IV);
        pool.setMark(true, MARK);
        uint128[4] memory badSl = [uint128(0), uint128(MARK), uint128(80e18), uint128(MARK + 1)];
        for (uint256 i; i < badSl.length; i++) {
            vm.prank(acct);
            vm.expectRevert(ExitGuard.BadLevels.selector);
            g.arm(address(pool), badSl[i], 0, 50, 10, exp, IV);
        }
        vm.prank(acct);
        vm.expectRevert(ExitGuard.BadLevels.selector);
        g.arm(address(pool), 78e18, uint128(MARK), 50, 10, exp, IV);
        uint16[2] memory badBps = [uint16(0), uint16(501)];
        for (uint256 i; i < badBps.length; i++) {
            vm.prank(acct);
            vm.expectRevert(ExitGuard.BadSlippage.selector);
            g.arm(address(pool), 78e18, 0, badBps[i], 10, exp, IV);
        }
        MockPool coarse = new MockPool(bank, 1e18, MIN_QTY, LOT); // 1 USDso tick on a 79 USDso mark: 1 bp is < 1 tick
        coarse.setMark(true, MARK);
        bank.setSize(acct, address(coarse), int128(500_000));
        vm.prank(acct);
        vm.expectRevert(ExitGuard.BadSlippage.selector);
        g.arm(address(coarse), 78e18, 0, 1, 10, exp, IV);
        vm.prank(acct);
        vm.expectRevert(ExitGuard.BadBudget.selector);
        g.arm(address(pool), 78e18, 0, 50, 0, exp, IV);
        vm.prank(acct);
        vm.expectRevert(ExitGuard.BadBudget.selector);
        g.arm(address(pool), 78e18, 0, 50, 1_000_001, exp, IV);
        vm.prank(acct);
        vm.expectRevert(ExitGuard.BadExpiry.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, uint64(ts), IV);
        vm.prank(acct);
        vm.expectRevert(ExitGuard.BadExpiry.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, uint64(ts + 7 days + 1), IV);
        uint32[2] memory badIv = [uint32(1_999), uint32(300_001)];
        for (uint256 i; i < badIv.length; i++) {
            vm.prank(acct);
            vm.expectRevert(ExitGuard.BadInterval.selector);
            g.arm(address(pool), 78e18, 0, 50, 10, exp, badIv[i]);
        }
        vm.deal(acct, 31 ether);
        vm.prank(acct);
        vm.expectRevert(ExitGuard.LowBalance.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, exp, IV);
        vm.deal(acct, 50 ether);
        pc.setFail(true, false);
        vm.prank(acct);
        vm.expectRevert(ExitGuard.SubscribeFailed.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, exp, IV);
        pc.setFail(false, false);
        pc.setHugeId(true);
        vm.prank(acct);
        vm.expectRevert(ExitGuard.SubscribeFailed.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, exp, IV);
        pc.setHugeId(false);
        eqA(_armedPool(), address(0), "nothing armed after refusals");
        _short(500_000);
        vm.prank(acct);
        vm.expectRevert(ExitGuard.BadLevels.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, exp, IV);
        vm.prank(acct);
        vm.expectRevert(ExitGuard.BadLevels.selector);
        g.arm(address(pool), 80e18, 80e18, 50, 10, exp, IV);
    }

    function test_arm_books_a_schedule_and_a_heartbeat_owned_by_the_account() public {
        _long(500_000);
        vm.recordLogs();
        (uint64 e, uint64 t) = _arm(78e18, 80e18);
        ExitGuard.Stop memory s = g.stopState();
        eqA(s.pool, address(pool), "pool");
        ok(s.isLong, "long");
        eq(s.slPrice, 78e18, "sl");
        eq(s.tpPrice, 80e18, "tp");
        eq(s.slippageBps, 50, "bps");
        eq(s.checksLeft, 1_000, "budget");
        eq(s.scheduleSubId, e, "schedule sub");
        eq(s.tickSubId, t, "tick sub");
        eq(s.intervalMs, IV, "interval");
        eq(s.nextWakeMs, ts * 1000 + IV, "first wake in 5 s");
        eq(s.lastMark, MARK, "mark at arm");
        (ExitGuard.SubscriptionData memory d, address owner, bool active) = pc.sub(e);
        ok(active, "schedule active");
        eqA(owner, acct, "schedule owned by the account");
        eqA(d.handlerContractAddress, acct, "handler = account");
        eqA(d.emitter, PRECOMPILE, "system event");
        ok(d.eventTopics[0] == SCHEDULE && uint256(d.eventTopics[1]) == ts * 1000 + IV && d.origin == address(0) && d.caller == address(0), "schedule filter");
        ok(d.handlerFunctionSelector == bytes4(0x53edf33d), "selector");
        eq(d.gasLimit, 30_000_000, "gas limit");
        eq(d.priorityFeePerGas, 2 gwei, "priority");
        eq(d.maxFeePerGas, 20 gwei, "max fee");
        ok(!d.isGuaranteed && !d.isCoalesced, "reserved flags");
        (d, owner, active) = pc.sub(t);
        ok(active && owner == acct && d.emitter == PRECOMPILE && d.eventTopics[0] == EPOCH_TICK && d.eventTopics[1] == 0, "epoch heartbeat (recurring)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        ok(logs.length == 1 && logs[0].emitter == acct && logs[0].topics[0] == ExitGuard.Armed.selector, "Armed event from the account");
        vm.prank(acct);
        vm.expectRevert(ExitGuard.AlreadyArmed.selector);
        g.arm(address(pool), 78e18, 0, 50, 10, uint64(ts + 60), IV);
    }

    // ---- who may make it check ----
    function test_onEvent_auth() public {
        _long(500_000);
        _arm(78e18, 0);
        bytes32[] memory w = _topics(SCHEDULE, g.stopState().nextWakeMs);
        vm.expectRevert(ExitGuard.NotPrecompile.selector);
        g.onEvent(PRECOMPILE, w, "");
        (bool s,) = stranger.call(acct, abi.encodeCall(ExitGuard.onEvent, (PRECOMPILE, w, bytes(""))));
        ok(!s, "stranger refused");
        // a subscription somebody else owns (tx.origin = them) may not spend this account's checks or renew its schedule
        vm.prank(PRECOMPILE, address(stranger));
        vm.expectRevert(ExitGuard.ForeignSubscription.selector);
        g.onEvent(PRECOMPILE, w, "");
        eq(g.stopState().checks, 0, "no check counted");
    }

    function test_only_system_wakeups_count() public {
        _call(PRECOMPILE, _topics(SCHEDULE, 1)); // nothing armed: returns quietly
        _long(500_000);
        _arm(78e18, 0);
        bn += 1;
        vm.roll(bn);
        _call(address(pool), _topics(SCHEDULE, g.stopState().nextWakeMs)); // a log from another emitter
        _call(PRECOMPILE, new bytes32[](0));
        _call(PRECOMPILE, _topics(keccak256("BlockTick(uint64)"), bn));
        eq(g.stopState().checks, 0, "other emitters, empty topics and other system events are ignored");
        _wake();
        _heartbeat(1);
        eq(g.stopState().checks, 2, "schedule wake + heartbeat counted");
        eq(pool.orderCount(), 0, "no order while above the stop");
    }

    // ---- the schedule ----
    function test_each_wake_books_the_next() public {
        _long(500_000);
        (uint64 first,) = _arm(78e18, 0);
        for (uint256 i; i < 5; i++) {
            uint64 before = g.stopState().scheduleSubId;
            _wake();
            ExitGuard.Stop memory s = g.stopState();
            ok(s.scheduleSubId != before && s.scheduleSubId != 0, "a new one-shot booked");
            eq(s.nextWakeMs, ts * 1000 + IV, "next wake = now + interval");
            (,, bool active) = pc.sub(s.scheduleSubId);
            ok(active, "new schedule active");
        }
        eq(g.stopState().checks, 5, "five checks");
        eq(pc.activeCount(acct), 2, "always exactly one schedule + the heartbeat");
        ok(first != g.stopState().scheduleSubId, "ids move on");
    }

    function test_used_schedule_is_removed_and_a_failed_removal_does_not_stop_renewal() public {
        _long(500_000);
        (uint64 first,) = _arm(78e18, 0);
        _wake();
        (,, bool active) = pc.sub(first);
        ok(!active, "the schedule that woke it is removed");
        pc.setFail(false, true); // removal refused (e.g. already gone)
        uint64 second = g.stopState().scheduleSubId;
        _wake();
        ok(g.stopState().scheduleSubId != second && g.stopState().scheduleSubId != 0, "renewed anyway");
        eq(g.stopState().checks, 2, "two checks");
    }

    function test_stray_wake_checks_but_does_not_fork_the_schedule() public {
        _long(500_000);
        _arm(78e18, 0);
        uint64 booked = g.stopState().scheduleSubId;
        bn += 1;
        vm.roll(bn);
        _call(PRECOMPILE, _topics(SCHEDULE, 12345)); // a late wake from some older schedule of this account
        eq(g.stopState().checks, 1, "it still checks");
        eq(g.stopState().scheduleSubId, booked, "no second schedule chain");
        eq(pc.activeCount(acct), 2, "still one schedule + heartbeat");
    }

    function test_heartbeat_restarts_a_dead_schedule() public {
        _long(500_000);
        _arm(78e18, 0);
        // the renewal fails (the account dropped under 32 STT): reported, the heartbeat keeps checking
        vm.deal(acct, 31 ether);
        vm.recordLogs();
        _wake();
        eq(g.stopState().scheduleSubId, 0, "no schedule pending");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        ok(logs.length == 1 && logs[0].topics[0] == ExitGuard.RescheduleFailed.selector, "RescheduleFailed");
        _heartbeat(300);
        eq(g.stopState().checks, 2, "heartbeat checks");
        eq(g.stopState().scheduleSubId, 0, "still too poor to renew");
        vm.deal(acct, 50 ether);
        _heartbeat(300);
        ok(g.stopState().scheduleSubId != 0, "renewed once it can");
        eq(g.stopState().nextWakeMs, ts * 1000 + IV, "back on the 5 s schedule");
        // a lost wake-up (pending id never fired for far too long): the heartbeat books a fresh one
        uint64 lost = g.stopState().scheduleSubId;
        _heartbeat(60);
        ok(g.stopState().scheduleSubId != lost && g.stopState().scheduleSubId != 0, "dead schedule replaced");
        // but a heartbeat while the schedule is on time leaves it alone
        uint64 fresh = g.stopState().scheduleSubId;
        _heartbeat(1);
        eq(g.stopState().scheduleSubId, fresh, "on-time schedule untouched");
    }

    function test_one_check_per_block_but_the_schedule_still_renews() public {
        _long(500_000);
        _arm(78e18, 0);
        ExitGuard.Stop memory s = g.stopState();
        ts = s.nextWakeMs / 1000 + 1;
        bn += 1;
        vm.warp(ts);
        vm.roll(bn);
        _call(PRECOMPILE, _topics(EPOCH_TICK, 1)); // heartbeat first in this block
        _call(PRECOMPILE, _topics(SCHEDULE, ts * 1000)); // then the wake, same block
        eq(g.stopState().checks, 1, "one check in the block");
        ok(g.stopState().scheduleSubId != s.scheduleSubId && g.stopState().scheduleSubId != 0, "renewed anyway");
    }

    function test_no_fire_above_stop_and_on_stale_mark() public {
        _long(500_000);
        _arm(78e18, 0);
        pool.setMark(true, 78e18 + 1);
        _wake();
        pool.setMark(false, 1e18); // stale feed: never acts on it
        _wake();
        pool.setMarkReverts(true);
        _wake();
        eq(pool.orderCount(), 0, "no order");
        eq(g.stopState().checks, 3, "three checks");
        eq(g.stopState().lastMark, 78e18 + 1, "last good mark kept");
    }

    // ---- firing ----
    function test_stopLoss_long_closes_whole_position() public {
        _long(1_234_567); // 1.234567 HYPE: not lot-aligned, the close rounds down to the lot
        (, uint64 t) = _arm(78e18, 0);
        pool.setMark(true, 77.9e18);
        vm.recordLogs();
        _wake();
        eq(pool.orderCount(), 1, "one order");
        MockPool.Order memory o = pool.order(0);
        eqA(o.sender, acct, "the account places it itself");
        ok(!o.isBid, "sell closes a long");
        eq(o.quantity, 1_230_000, "whole position, lot-aligned down");
        // floor = 77.9 * (1 - 0.005) = 77.5105 -> rounded UP to the 0.01 tick = 77.52
        eq(o.price, 77.52e18, "limit at most 0.5 % below the mark, rounded toward safety");
        eq(o.orderType, 2, "IOC");
        eq(o.selfMatch, 1, "cancel own maker");
        eqA(o.builder, address(0), "no builder");
        eq(o.builderFee, 0, "no builder fee");
        eq(o.value, 0, "no value");
        eq(o.userData, 0x45584954, "EXIT tag");
        eq(o.expireNs, (ts + 60) * 1e9, "expiry 60 s");
        eq(uint256(uint128(bank.size(acct, address(pool)))), 4_567, "dust below one lot left");
        ok(_armedPool() == address(0), "done: nothing the market would take is left");
        ExitGuard.Last memory l = g.lastEnd();
        eq(l.reason, END_FIRED, "ended as fired");
        eq(l.checks, 1, "one check");
        (,, bool ta) = pc.sub(t);
        ok(!ta, "heartbeat removed");
        eq(pc.activeCount(acct), 0, "no subscription left, no schedule booked after the fire");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool fired;
        bool disarmed;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != acct) continue;
            if (logs[i].topics[0] == ExitGuard.Fired.selector) {
                (uint8 kind, uint256 m, uint256 trig, uint256 q, uint256 rem,,) = abi.decode(logs[i].data, (uint8, uint256, uint256, uint256, uint256, uint128, uint32));
                ok(kind == SL && m == 77.9e18 && trig == 78e18 && q == 1_230_000 && rem == 4_567, "Fired fields");
                fired = true;
            }
            if (logs[i].topics[0] == ExitGuard.Disarmed.selector) {
                (uint8 r,, bool us, bool ut) = abi.decode(logs[i].data, (uint8, uint32, bool, bool));
                ok(r == END_FIRED && us && ut, "Disarmed fields");
                disarmed = true;
            }
        }
        ok(fired && disarmed, "events");
        _heartbeat(1); // a late call is a no-op
        eq(pool.orderCount(), 1, "no second order");
    }

    function test_takeProfit_long_by_heartbeat() public {
        _long(500_000);
        _arm(78e18, 80e18);
        pool.setMark(true, 80e18);
        _heartbeat(1); // the epoch heartbeat can fire it too
        MockPool.Order memory o = pool.order(0);
        ok(!o.isBid && o.quantity == 500_000, "sells the position");
        eq(g.lastEnd().reason, END_FIRED, "fired");
        eq(pc.activeCount(acct), 0, "pending schedule and heartbeat removed");
    }

    function test_short_stopLoss_and_takeProfit() public {
        _short(500_000);
        _arm(80e18, 77e18);
        pool.setMark(true, 79.99e18);
        _wake();
        eq(pool.orderCount(), 0, "below the stop: nothing");
        pool.setMark(true, 80.004e18);
        _wake();
        MockPool.Order memory o = pool.order(0);
        ok(o.isBid, "buy closes a short");
        eq(o.quantity, 500_000, "whole short");
        // cap = 80.004 * 1.005 = 80.40402 -> rounded DOWN to the tick = 80.40
        eq(o.price, 80.40e18, "limit at most 0.5 % above the mark");
        eq(g.lastEnd().reason, END_FIRED, "fired");
        pool.setMark(true, MARK);
        _short(500_000);
        _arm(80e18, 77e18);
        pool.setMark(true, 77e18);
        _wake();
        ok(pool.order(1).isBid && pool.order(1).quantity == 500_000, "tp buys");
    }

    function test_partial_fill_keeps_the_rest_armed() public {
        _long(1_000_000);
        _arm(78e18, 0);
        pool.setMode(0, 6_000); // the book takes 60 % of each order
        pool.setMark(true, 77e18);
        _wake();
        eq(uint256(uint128(bank.size(acct, address(pool)))), 400_000, "40 % left");
        eqA(_armedPool(), address(pool), "still armed for the rest");
        ok(g.stopState().scheduleSubId != 0, "and the next wake is booked");
        _wake();
        eq(uint256(uint128(bank.size(acct, address(pool)))), 160_000, "16 % left");
        pool.setMode(0, 10_000);
        _wake();
        eq(bank.size(acct, address(pool)) == 0 ? 1 : 0, 1, "flat");
        eq(pool.orderCount(), 3, "three closes, each sized from the fresh position");
        eq(pool.order(1).quantity, 400_000, "second close = what was left");
        eq(pool.order(2).quantity, 160_000, "third close = what was left");
        eq(g.lastEnd().reason, END_FIRED, "fired");
    }

    function test_reverting_close_retries_then_gives_up() public {
        _long(500_000);
        _arm(78e18, 0);
        pool.setMark(true, 77e18);
        pool.setMode(1, 10_000); // ImmediateOrCancelNoFill
        _wake();
        eq(g.stopState().failures, 1, "one failure");
        pool.setMode(2, 10_000); // empty revert (out of gas in the pool)
        _wake();
        eq(g.stopState().failures, 2, "two");
        eqA(_armedPool(), address(pool), "still armed");
        _wake();
        ok(_armedPool() == address(0), "gives up after 3");
        eq(g.lastEnd().reason, END_FAILURES, "reason");
        eq(uint256(uint128(bank.size(acct, address(pool)))), 500_000, "position untouched");
        eq(pc.activeCount(acct), 0, "nothing left subscribed");
    }

    function test_position_closed_or_flipped_elsewhere_sends_nothing() public {
        _long(500_000);
        _arm(78e18, 0);
        bank.setSize(acct, address(pool), 0); // closed by hand or by the bot first
        pool.setMark(true, 77e18);
        _wake();
        eq(pool.orderCount(), 0, "no order on a flat account");
        eq(g.lastEnd().reason, END_NO_POSITION, "ended");
        pool.setMark(true, MARK);
        _long(500_000);
        _arm(78e18, 0);
        pool.setMark(true, 77e18);
        _short(300_000); // flipped to a short elsewhere: a sell would ADD to it
        _wake();
        eq(pool.orderCount(), 0, "never adds to a flipped position");
        eq(g.lastEnd().reason, END_NO_POSITION, "ended");
    }

    function test_dust_position_ends_without_order() public {
        _long(500_000);
        _arm(78e18, 0);
        _long(MIN_QTY - LOT); // reduced elsewhere below the minimum
        pool.setMark(true, 77e18);
        _wake();
        eq(pool.orderCount(), 0, "no order below the minimum size");
        eq(g.lastEnd().reason, END_DUST, "dust");
    }

    function test_expiry_and_budget_end_the_stop() public {
        _long(500_000);
        vm.prank(acct);
        g.arm(address(pool), 78e18, 0, 50, 2, uint64(ts + 100), IV);
        _wake();
        _wake();
        _wake(); // budget of 2 used up
        eq(g.lastEnd().reason, END_BUDGET, "budget");
        eq(g.lastEnd().checks, 2, "two checks");
        eq(pc.activeCount(acct), 0, "no schedule booked after the end");
        vm.prank(acct);
        g.arm(address(pool), 78e18, 0, 50, 100, uint64(ts + 100), IV);
        _heartbeat(100);
        eq(pool.orderCount(), 0, "no order after expiry");
        eq(g.lastEnd().reason, END_EXPIRED, "expired");
    }

    function test_owner_disarm() public {
        _long(500_000);
        (uint64 e, uint64 t) = _arm(78e18, 0);
        vm.prank(acct);
        g.disarm();
        ok(_armedPool() == address(0), "disarmed");
        eq(g.lastEnd().reason, END_OWNER, "owner");
        (,, bool ea) = pc.sub(e);
        (,, bool ta) = pc.sub(t);
        ok(!ea && !ta, "subscriptions removed");
        vm.prank(acct);
        vm.expectRevert(ExitGuard.NotArmed.selector);
        g.disarm();
        _arm(78e18, 0);
        eqA(_armedPool(), address(pool), "re-armed");
    }

    function test_unsubscribe_failure_still_clears_the_stop() public {
        _long(500_000);
        _arm(78e18, 0);
        pc.setFail(false, true);
        vm.recordLogs();
        vm.prank(acct);
        g.disarm();
        ok(_armedPool() == address(0), "cleared anyway");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint8 r,, bool us, bool ut) = abi.decode(logs[logs.length - 1].data, (uint8, uint32, bool, bool));
        ok(r == END_OWNER && !us && !ut, "failure reported");
        pool.setMark(true, 1e18);
        _heartbeat(1); // the leftover subscription can still call: nothing happens
        eq(pool.orderCount(), 0, "late call is inert");
    }

    function test_reentry_from_the_pool_cannot_arm_disarm_or_fire() public {
        _long(500_000);
        _arm(78e18, 0);
        bytes[3] memory calls = [
            abi.encodeCall(ExitGuard.disarm, ()),
            abi.encodeCall(ExitGuard.onEvent, (PRECOMPILE, _topics(SCHEDULE, 1), bytes(""))),
            abi.encodeCall(ExitGuard.arm, (address(pool), 70e18, 0, 50, 10, uint64(ts + 60), IV))
        ];
        for (uint256 i; i < calls.length; i++) {
            pool.setMark(true, MARK);
            _long(500_000);
            if (_armedPool() == address(0)) _arm(78e18, 0);
            pool.setReenter(calls[i]);
            pool.setMark(true, 77e18);
            _wake();
            ok(!pool.reenterOk(), "re-entry refused");
        }
    }

    function test_receive_still_works() public {
        uint256 b = acct.balance;
        (bool s,) = acct.call{value: 1 ether}("");
        ok(s, "STT transfer to the account works");
        eq(acct.balance, b + 1 ether, "balance");
        (s,) = acct.call(hex"deadbeef");
        ok(!s, "unknown calls revert");
    }

    /// Whatever the position, mark and slippage: the close only ever goes against the position, never above its size,
    /// and never beyond the slippage bound (+ one tick of rounding toward the safe side).
    function testFuzz_close_is_reduce_only_and_bounded(uint256 rawSize, bool long_, uint256 rawMark, uint256 rawBps) public {
        uint256 size = bound(rawSize, MIN_QTY, 1e15);
        uint256 mark = bound(rawMark, 1e18, 1e24);
        uint16 bps = uint16(bound(rawBps, 1, 500));
        pool.setMark(true, mark);
        if (long_) _long(size);
        else _short(size);
        uint256 lim = long_ ? (mark * (10_000 - bps) + 9_999) / 10_000 : (mark * (10_000 + bps)) / 10_000;
        vm.assume(long_ ? ((lim + TICK - 1) / TICK) * TICK < mark : (lim / TICK) * TICK > mark); // arm refuses < 1 tick
        vm.prank(acct);
        g.arm(address(pool), long_ ? uint128(mark - 1) : uint128(mark + 1), 0, bps, 10, uint64(ts + 60), IV);
        uint256 m2 = long_ ? mark - 1 : mark + 1;
        pool.setMark(true, m2); // crossed by one wei
        _wake();
        eq(pool.orderCount(), 1, "one close");
        MockPool.Order memory o = pool.order(0);
        ok(o.isBid != long_, "opposite side only");
        ok(o.quantity <= size && o.quantity + LOT > size, "at most the position, at least all but one lot");
        if (long_) ok(o.price * 10_000 >= m2 * (10_000 - bps) && o.price <= m2, "sell floor within bps");
        else ok(o.price * 10_000 <= m2 * (10_000 + bps) && o.price >= m2, "buy cap within bps");
        int128 after_ = bank.size(acct, address(pool));
        ok(long_ ? after_ >= 0 : after_ <= 0, "never flips");
    }
}
