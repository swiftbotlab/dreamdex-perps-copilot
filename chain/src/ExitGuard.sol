// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ExitGuard: a stop-loss (and optional take-profit) for one dreamDEX perp position, fired by the chain.
/// @notice How it is used. The trader's own account (an EOA) points its code at this contract with one EIP-7702
/// transaction and then calls `arm` on itself. From then on Somnia Reactivity wakes the account on a fixed schedule
/// (a one-shot `Schedule` subscription it renews on every wake, every `intervalMs`) and once per epoch as a heartbeat.
/// On each wake it reads the pool's mark; when the mark crosses the stop, the account closes its own position with one
/// immediate-or-cancel order in that same reactive transaction. No bot, key or server sends the close.
///
/// What this code can do, and nothing else:
/// - close the account's OWN position on the armed pool: one order on the opposite side, sized from the position
///   read in the same transaction (never more than the position, so it can only reduce it), with a limit price at
///   most `slippageBps` from the mark it checked;
/// - create and remove the account's own Reactivity subscriptions (the schedule and the epoch heartbeat).
/// No arbitrary calls, no token approvals, no transfers, no withdrawals, no upgrade hook. Only the account itself can
/// arm or disarm. Only the Reactivity precompile, on a subscription the account itself owns, can make it check.
/// The account's key keeps full control (it can disarm, cancel the subscriptions directly, or remove the delegation).
///
/// Version 3. Version 1 was woken by every new order on the market's book; on a busy book (market makers re-quote
/// ladders, ~9 orders per block) that cost up to ~36 STT an hour, so the wake-up became a fixed schedule. Version 2
/// matched the wake-up's topic 1 to the booked time, but the precompile passes the time it fired, so it never renewed.
///
/// Storage lives in the delegating account under an ERC-7201 namespace, so it cannot collide with another delegate.
contract ExitGuard {
    // ---- fixed protocol addresses and values --------------------------------------------------------------------
    /// Somnia Reactivity precompile: the only caller of onEvent, and where subscriptions are made. It has no bytecode,
    /// so it is always called with a low-level call.
    address internal constant PRECOMPILE = address(0x0100);
    /// keccak256("Schedule(uint256)"): one-shot system event in the first block at or after topic 1 (milliseconds).
    bytes32 internal constant SCHEDULE_TOPIC = 0x67aa3d752967d87d8944b9c7adf73172518777fa4703f336edee81f0736d8987;
    /// keccak256("EpochTick(uint64,uint64)"): the precompile's system event at the end of every epoch (~5 minutes).
    bytes32 internal constant EPOCH_TICK_TOPIC = 0x2e0c8e351f738401ab3e8e932f7251c170afb7b5539cbab5d24743f09b52aec8;
    /// subscribe((bytes32[4],address,address,address,address,bytes4,uint64,uint64,uint64,bool,bool)) and unsubscribe(uint256)
    bytes4 internal constant SUBSCRIBE_SELECTOR = 0xc5fca91e;
    bytes4 internal constant UNSUBSCRIBE_SELECTOR = 0xad0b27fb;
    /// onEvent(address,bytes32[],bytes)
    bytes4 internal constant ON_EVENT_SELECTOR = 0x53edf33d;

    /// Gas each wake may use. A close crossing several book levels can touch cold storage (1M gas each on Somnia);
    /// gas is billed on what a call uses, and the owner's balance must cover limit x price for the chain to call it.
    uint64 internal constant HANDLER_GAS_LIMIT = 30_000_000;
    uint64 internal constant PRIORITY_FEE_PER_GAS = 2 gwei;
    uint64 internal constant MAX_FEE_PER_GAS = 20 gwei;
    /// The precompile refuses to create a subscription for an owner holding less (it is not spent). The schedule is
    /// renewed on every wake, so the account must keep this much; below it the heartbeat keeps checking every epoch.
    uint256 internal constant MIN_OWNER_BALANCE = 32 ether;

    uint16 internal constant MAX_SLIPPAGE_BPS = 500;      // the close never accepts a price more than 5 % from the mark
    uint32 internal constant MAX_CHECKS = 1_000_000;      // spend cap: checks before the stop disarms itself
    uint64 internal constant MAX_DURATION = 7 days;       // spend cap: the stop disarms itself after its expiry
    uint8 internal constant MAX_FAILURES = 3;             // closes that revert (e.g. an empty book) before it gives up
    uint32 internal constant MIN_INTERVAL_MS = 2_000;     // the precompile needs a schedule at least ~1 s ahead
    uint32 internal constant MAX_INTERVAL_MS = 300_000;

    uint8 internal constant ORDER_TYPE_IOC = 2;         // ImmediateOrCancel: fills now or not at all, never rests
    uint8 internal constant SELF_MATCH_CANCEL_MAKER = 1; // a resting order of the account's own on the other side is
                                                        // cancelled instead of blocking the close
    uint64 internal constant USER_DATA = 0x45584954;    // "EXIT": tags the close order in the pool's own logs

    uint8 internal constant KIND_STOP_LOSS = 1;
    uint8 internal constant KIND_TAKE_PROFIT = 2;

    uint8 internal constant END_OWNER = 1;        // disarmed by the account
    uint8 internal constant END_FIRED = 2;        // the position is closed
    uint8 internal constant END_EXPIRED = 3;
    uint8 internal constant END_BUDGET = 4;       // maxChecks used up
    uint8 internal constant END_NO_POSITION = 5;  // the position was closed or flipped elsewhere before the stop fired
    uint8 internal constant END_FAILURES = 6;     // MAX_FAILURES closes reverted
    uint8 internal constant END_DUST = 7;         // what is left is below the market's minimum order size

    /// keccak256(abi.encode(uint256(keccak256("swiftbotlab.exitguard.v2")) - 1)) & ~bytes32(uint256(0xff)) (layout v2 = v3)
    bytes32 internal constant STORAGE_SLOT = 0xc983c76572b07c42bff4cf0e41302f45f894830edf2123a67df35066b4edd400;

    uint256 public constant VERSION = 3;

    /// The dreamDEX MarginBank (holds every perp position). A pool is accepted only if it reports this bank.
    address public immutable MARGIN_BANK;

    // ---- state --------------------------------------------------------------------------------------------------
    struct Stop {
        // slot 0
        address pool;          // armed pool; zero = nothing armed
        bool isLong;           // side of the position when it was armed (a close only ever goes the other way)
        uint16 slippageBps;
        uint8 failures;
        uint64 expiresAt;      // unix seconds
        // slot 1
        uint128 slPrice;       // 18 decimals, same unit as the pool's mark
        uint128 tpPrice;       // 0 = no take-profit
        // slot 2
        uint64 scheduleSubId;  // the pending one-shot Schedule (0 = none pending)
        uint64 tickSubId;      // the EpochTick heartbeat
        uint32 checksLeft;
        uint32 checks;         // how many times the chain has checked this stop
        uint64 lastCheckBlock;
        // slot 3
        uint128 lastMark;
        uint64 nextWakeMs;     // when the pending Schedule fires (unix milliseconds)
        uint32 intervalMs;
        uint32 armedAtBlock;
    }

    struct Last {
        address pool;
        uint40 endedAtBlock;
        uint32 checks;
        uint8 reason;
    }

    struct Layout {
        Stop stop;
        Last last;
    }

    struct SubscriptionData {
        bytes32[4] eventTopics;
        address origin;
        address caller;
        address emitter;
        address handlerContractAddress;
        bytes4 handlerFunctionSelector;
        uint64 priorityFeePerGas;
        uint64 maxFeePerGas;
        uint64 gasLimit;
        bool isGuaranteed;
        bool isCoalesced;
    }

    // ---- events and errors --------------------------------------------------------------------------------------
    event Armed(
        address indexed pool, bool isLong, uint256 slPrice, uint256 tpPrice, uint256 mark, uint16 slippageBps,
        uint32 maxChecks, uint64 expiresAt, uint32 intervalMs, uint64 scheduleSubId, uint64 tickSubId
    );
    event Fired(
        address indexed pool, uint8 kind, uint256 mark, uint256 trigger, uint256 quantity, uint256 remaining,
        uint128 orderId, uint32 checks
    );
    event CloseFailed(address indexed pool, uint256 mark, bytes4 reason, uint8 failures);
    event RescheduleFailed(address indexed pool, uint64 wakeMs);
    event Disarmed(address indexed pool, uint8 reason, uint32 checks, bool scheduleUnsubscribed, bool tickUnsubscribed);

    error NotSelf();
    error NotPrecompile();
    error ForeignSubscription();
    error AlreadyArmed();
    error NotArmed();
    error BadPool();
    error NoPosition();
    error NoMark();
    error BadLevels();
    error BadSlippage();
    error BadBudget();
    error BadExpiry();
    error BadInterval();
    error LowBalance();
    error SubscribeFailed();

    constructor(address marginBank) {
        if (marginBank == address(0)) revert BadPool();
        MARGIN_BANK = marginBank;
    }

    /// The account can still receive STT (faucet, refunds of dreamDEX stop fees, gas top-ups).
    receive() external payable {}

    modifier onlySelf() {
        // Under EIP-7702 a transaction the account sends to itself runs this code with msg.sender == address(this).
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    // ---- owner (the account itself) -----------------------------------------------------------------------------
    /// Arm a stop for the account's current position on `pool` and book the chain's wake-ups.
    /// @param slPrice stop-loss level (below the mark for a long, above for a short)
    /// @param tpPrice optional take-profit level (0 = none; above the mark for a long, below for a short)
    /// @param slippageBps how far from the checked mark the close may fill (1-500)
    /// @param maxChecks the stop disarms itself after this many checks (1-1,000,000)
    /// @param expiresAt the stop disarms itself at this time (unix seconds, at most 7 days ahead)
    /// @param intervalMs how often the chain wakes it (2,000-300,000 ms)
    function arm(
        address pool,
        uint128 slPrice,
        uint128 tpPrice,
        uint16 slippageBps,
        uint32 maxChecks,
        uint64 expiresAt,
        uint32 intervalMs
    ) external onlySelf returns (uint64 scheduleSubId, uint64 tickSubId) {
        Stop storage s = _layout().stop;
        if (s.pool != address(0)) revert AlreadyArmed();
        if (pool == address(0) || pool == PRECOMPILE || pool.code.length == 0) revert BadPool();
        if (IPerpPool(pool).marginBank() != MARGIN_BANK) revert BadPool();
        int128 size = _size(pool);
        if (size == 0) revert NoPosition();
        bool isLong = size > 0;
        (bool ok, uint256 mark) = _mark(pool);
        if (!ok) revert NoMark();
        if (slippageBps == 0 || slippageBps > MAX_SLIPPAGE_BPS) revert BadSlippage();
        (uint256 tick,,) = IPerpPool(pool).getOrderBookParameters();
        uint256 lim = _limitPrice(mark, isLong, slippageBps, tick);
        if (isLong ? lim >= mark : lim <= mark) revert BadSlippage(); // less than one tick of room: it could never fill
        if (isLong) {
            if (slPrice == 0 || slPrice >= mark || (tpPrice != 0 && tpPrice <= mark)) revert BadLevels();
        } else {
            if (slPrice <= mark || (tpPrice != 0 && tpPrice >= mark)) revert BadLevels();
        }
        if (maxChecks == 0 || maxChecks > MAX_CHECKS) revert BadBudget();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_DURATION) revert BadExpiry();
        if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) revert BadInterval();
        if (address(this).balance < MIN_OWNER_BALANCE) revert LowBalance();

        s.pool = pool;
        s.isLong = isLong;
        s.slippageBps = slippageBps;
        s.failures = 0;
        s.expiresAt = expiresAt;
        s.slPrice = slPrice;
        s.tpPrice = tpPrice;
        s.checksLeft = maxChecks;
        s.checks = 0;
        s.lastCheckBlock = 0;
        s.lastMark = uint128(mark);
        s.intervalMs = intervalMs;
        s.armedAtBlock = uint32(block.number);

        if (!_schedule(s)) revert SubscribeFailed();
        (bool sent, uint64 t) = _subscribe(EPOCH_TICK_TOPIC, bytes32(0));
        if (!sent) revert SubscribeFailed();
        s.tickSubId = t;
        scheduleSubId = s.scheduleSubId;
        tickSubId = t;
        emit Armed(pool, isLong, slPrice, tpPrice, mark, slippageBps, maxChecks, expiresAt, intervalMs, scheduleSubId, t);
    }

    /// Disarm the stop and remove its subscriptions.
    function disarm() external onlySelf {
        Stop storage s = _layout().stop;
        if (s.pool == address(0)) revert NotArmed();
        _end(s, END_OWNER);
    }

    // ---- the chain ----------------------------------------------------------------------------------------------
    /// Called by the Reactivity precompile on this stop's Schedule wake-up or on an epoch tick.
    function onEvent(address emitter, bytes32[] calldata eventTopics, bytes calldata) external {
        if (msg.sender != PRECOMPILE) revert NotPrecompile();
        // A reactive call runs with tx.origin == the subscription owner. Anyone may create a subscription that points
        // at this account; only the account's own subscriptions may spend its checks.
        if (tx.origin != address(this)) revert ForeignSubscription();
        Stop storage s = _layout().stop;
        if (s.pool == address(0)) return; // nothing armed: a late call from a subscription already removed
        if (emitter != PRECOMPILE || eventTopics.length == 0) return; // both wake-ups are system events
        bytes32 t0 = eventTopics[0];
        if (t0 == SCHEDULE_TOPIC) {
            // Topic 1 is the time the schedule fired (ms), at or after the time booked. Only a wake-up at or after
            // the booked time renews the schedule; an earlier one (left over from an older schedule) just checks.
            uint256 firedMs = eventTopics.length > 1 ? uint256(eventTopics[1]) : block.timestamp * 1000;
            if (s.scheduleSubId != 0 && firedMs >= s.nextWakeMs) _dropSchedule(s);
        } else if (t0 == EPOCH_TICK_TOPIC) {
            // Heartbeat: if the schedule is evidently dead (renewal failed, or a wake-up was lost), start it again.
            if (s.scheduleSubId != 0 && block.timestamp * 1000 > uint256(s.nextWakeMs) + 3 * uint256(s.intervalMs) + 10_000) {
                _dropSchedule(s);
            }
        } else {
            return;
        }
        // One check per block (a wake-up and a heartbeat can land together).
        if (s.lastCheckBlock != block.number) _check(s);
        if (s.pool != address(0) && s.scheduleSubId == 0 && !_schedule(s)) emit RescheduleFailed(s.pool, s.nextWakeMs);
    }

    // ---- views --------------------------------------------------------------------------------------------------
    function stopState() external view returns (Stop memory) {
        return _layout().stop;
    }

    function lastEnd() external view returns (Last memory) {
        return _layout().last;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == ON_EVENT_SELECTOR; // ERC-165, ISomniaEventHandler
    }

    // ---- internals ----------------------------------------------------------------------------------------------
    function _layout() private pure returns (Layout storage l) {
        bytes32 slot = STORAGE_SLOT;
        assembly {
            l.slot := slot
        }
    }

    function _check(Stop storage s) private {
        address pool = s.pool;
        if (block.timestamp >= s.expiresAt) {
            _end(s, END_EXPIRED);
            return;
        }
        uint32 left = s.checksLeft;
        if (left == 0) {
            _end(s, END_BUDGET);
            return;
        }
        unchecked {
            s.checksLeft = left - 1;
            s.checks += 1;
        }
        s.lastCheckBlock = uint64(block.number);
        (bool ok, uint256 mark) = _mark(pool);
        if (!ok) return;
        s.lastMark = uint128(mark);
        uint8 kind = _hit(s, mark);
        if (kind != 0) _close(s, pool, mark, kind);
    }

    function _size(address pool) private view returns (int128) {
        return IMarginBank(MARGIN_BANK).getPosition(address(this), pool).size;
    }

    /// The pool's mark, or (false, 0) when it is stale, zero, out of range or the read fails.
    function _mark(address pool) private view returns (bool, uint256) {
        try IPerpPool(pool).tryGetMarkPrice() returns (bool ok, uint256 price) {
            if (!ok || price == 0 || price > type(uint128).max) return (false, 0);
            return (true, price);
        } catch {
            return (false, 0);
        }
    }

    function _hit(Stop storage s, uint256 mark) private view returns (uint8) {
        uint256 sl = s.slPrice;
        uint256 tp = s.tpPrice;
        if (s.isLong) {
            if (mark <= sl) return KIND_STOP_LOSS;
            if (tp != 0 && mark >= tp) return KIND_TAKE_PROFIT;
        } else {
            if (mark >= sl) return KIND_STOP_LOSS;
            if (tp != 0 && mark <= tp) return KIND_TAKE_PROFIT;
        }
        return 0;
    }

    /// A sell (closing a long) accepts at least mark x (1 - bps), rounded UP to the tick; a buy (closing a short)
    /// pays at most mark x (1 + bps), rounded DOWN. Rounding always goes toward the safe side.
    function _limitPrice(uint256 mark, bool isLong, uint16 bps, uint256 tick) internal pure returns (uint256 p) {
        if (isLong) {
            p = (mark * (10_000 - bps) + 9_999) / 10_000; // ceil: never even 1 wei below the bound
            if (tick > 1) p = ((p + tick - 1) / tick) * tick;
        } else {
            p = (mark * (10_000 + bps)) / 10_000;
            if (tick > 1) p = (p / tick) * tick;
        }
    }

    function _close(Stop storage s, address pool, uint256 mark, uint8 kind) private {
        bool isLong = s.isLong;
        int128 size = _size(pool);
        if (size == 0 || (size > 0) != isLong) {
            _end(s, END_NO_POSITION);
            return;
        }
        uint256 abs = _abs(size);
        (uint256 tick, uint256 minQty, uint256 lot) = IPerpPool(pool).getOrderBookParameters();
        uint256 qty = lot > 1 ? abs - (abs % lot) : abs;
        if (qty == 0 || qty < minQty) {
            _end(s, END_DUST);
            return;
        }
        uint256 price = _limitPrice(mark, isLong, s.slippageBps, tick);
        uint256 trigger = kind == KIND_STOP_LOSS ? s.slPrice : s.tpPrice;
        try IPerpPool(pool).placeOrder(
            !isLong, USER_DATA, price, qty, uint64((block.timestamp + 60) * 1e9), ORDER_TYPE_IOC,
            SELF_MATCH_CANCEL_MAKER, address(0), 0
        ) returns (bool, uint128 orderId) {
            int128 rest = _size(pool);
            uint256 r = _abs(rest);
            emit Fired(pool, kind, mark, trigger, qty, r, orderId, s.checks);
            // A thin book can fill only part of it: then the stop stays armed and the next wake-up closes the rest.
            // It is done when nothing is left that the market would take (less than one lot or the minimum size).
            uint256 rq = lot > 1 ? r - (r % lot) : r;
            if (rest == 0 || (rest > 0) != isLong || rq == 0 || rq < minQty) _end(s, END_FIRED);
        } catch (bytes memory reason) {
            uint8 f = s.failures + 1;
            s.failures = f;
            emit CloseFailed(pool, mark, reason.length >= 4 ? bytes4(reason) : bytes4(0), f);
            if (f >= MAX_FAILURES) _end(s, END_FAILURES);
        }
    }

    /// Clear the stop first, then remove its subscriptions (failures are reported, not fatal: the key can always
    /// remove them directly at the precompile, and a removed stop ignores any late call).
    function _end(Stop storage s, uint8 reason) private {
        address pool = s.pool;
        uint64 e = s.scheduleSubId;
        uint64 t = s.tickSubId;
        uint32 checks = s.checks;
        delete _layout().stop;
        _layout().last = Last({pool: pool, endedAtBlock: uint40(block.number), checks: checks, reason: reason});
        bool ue = e == 0 || _unsubscribe(e); // 0: no schedule pending (the one that woke it is used up)
        bool ut = _unsubscribe(t);
        emit Disarmed(pool, reason, checks, ue, ut);
    }

    /// Forget the pending (or just used) schedule and remove it: on Somnia a fired one-shot stays listed until it is
    /// removed (observed on Tokyo testnet, 2026-10-29), so each wake-up removes the one that woke it (~27,000 gas).
    function _dropSchedule(Stop storage s) private {
        uint64 id = s.scheduleSubId;
        s.scheduleSubId = 0;
        _unsubscribe(id);
    }

    /// Book the next wake-up `intervalMs` from now. Returns false (state unchanged) if the precompile refuses.
    function _schedule(Stop storage s) private returns (bool) {
        uint64 at = uint64(block.timestamp) * 1000 + s.intervalMs;
        (bool ok, uint64 id) = _subscribe(SCHEDULE_TOPIC, bytes32(uint256(at)));
        if (!ok) return false;
        s.scheduleSubId = id;
        s.nextWakeMs = at;
        return true;
    }

    function _subscribe(bytes32 topic0, bytes32 topic1) private returns (bool, uint64) {
        if (address(this).balance < MIN_OWNER_BALANCE) return (false, 0);
        SubscriptionData memory d;
        d.eventTopics[0] = topic0;
        d.eventTopics[1] = topic1;
        d.emitter = PRECOMPILE;
        d.handlerContractAddress = address(this);
        d.handlerFunctionSelector = ON_EVENT_SELECTOR;
        d.priorityFeePerGas = PRIORITY_FEE_PER_GAS;
        d.maxFeePerGas = MAX_FEE_PER_GAS;
        d.gasLimit = HANDLER_GAS_LIMIT;
        (bool ok, bytes memory ret) = PRECOMPILE.call(abi.encodeWithSelector(SUBSCRIBE_SELECTOR, d));
        if (!ok || ret.length < 32) return (false, 0);
        uint256 id = abi.decode(ret, (uint256));
        if (id > type(uint64).max) return (false, 0);
        return (true, uint64(id));
    }

    function _unsubscribe(uint64 id) private returns (bool ok) {
        (ok,) = PRECOMPILE.call(abi.encodeWithSelector(UNSUBSCRIBE_SELECTOR, uint256(id)));
    }

    function _abs(int128 x) private pure returns (uint256) {
        return x >= 0 ? uint256(uint128(x)) : uint256(uint128(-x));
    }
}

interface IPerpPool {
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
    ) external payable returns (bool success, uint128 orderId);
    function tryGetMarkPrice() external view returns (bool ok, uint256 price);
    function getOrderBookParameters() external view returns (uint256 tickSize, uint256 minQuantity, uint256 lotSize);
    function marginBank() external view returns (address);
}

interface IMarginBank {
    struct Position {
        int128 size;
        uint128 avgEntryPrice;
        int256 entryFundingIndex;
        uint64 lastUpdatedTimestampNs;
    }

    function getPosition(address account, address perpPool) external view returns (Position memory);
}
