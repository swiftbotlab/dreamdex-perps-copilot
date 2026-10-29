// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Base} from "./Base.sol";
import {ExitGuard, IPerpPool, IMarginBank} from "../src/ExitGuard.sol";
import {MockPrecompile} from "./Mocks.sol";

interface IPerpPoolFor {
    function placeOrderFor(
        address owner,
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
}

interface VmFork {
    function mockCall(address callee, bytes calldata data, bytes calldata returnData) external;
    function clearMockedCalls() external;
}

/// Runs only on a fork of Somnia Tokyo testnet (`node fork-rpc-shim.mjs 18545 &` then
/// `forge test --match-path test/ExitGuardFork.t.sol --fork-url http://127.0.0.1:18545`): the real HYPE-PERP pool and
/// MarginBank, the demo account with the ExitGuard designator etched on it, and a stand-in for the Reactivity
/// precompile (which does not exist outside Somnia's own nodes). Only the mark read is mocked, to make it cross.
/// The RPC serves storage at "latest", so the fork's state can be inconsistent (an empty book, a price "in the future"):
/// a failure inside dreamDEX's own oracle or book code (LinkedListCorrupted, ZeroOrderIndex, an underflow in the price
/// adapter) is the fork, not ExitGuard; rerun it. On 2026-10-29 both tests passed in 3 of 6 runs with ExitGuard v1/v2
/// (same close path); the v3 runs that evening all failed in dreamDEX's code before reaching ExitGuard, and v3's path
/// was then shown live on chain instead (evidence/chain_fired_stop.json).
contract ExitGuardForkTest is Base {
    address constant PRECOMPILE = address(0x0100);
    address constant ACCT = 0x2A11e7388D1D2F9690f2636846d44b478f61bF08;   // demo account (not a Perps Arena account)
    address constant BOT_KEY = 0xDD5DDD125d6a9b3D4641e5BDB5456E5Ec098FB18; // its linked bot key (operator grant)
    address constant BANK = 0x478769E1177C0773c43A593DCCc4Ad15F15F1394;
    address constant HYPE = 0x63B47eD4A7DE0FdE659b0d82441dD74828b7297A;
    VmFork constant vmf = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    function _setup() internal returns (ExitGuard g, uint256 mark, uint256 tick, uint256 minQty) {
        ExitGuard impl = new ExitGuard(BANK);
        vm.etch(PRECOMPILE, type(MockPrecompile).runtimeCode);
        vm.etch(ACCT, abi.encodePacked(hex"ef0100", address(impl)));
        vm.deal(ACCT, 50 ether);
        g = ExitGuard(payable(ACCT));
        bool ok_;
        (ok_, mark) = IPerpPool(HYPE).tryGetMarkPrice();
        ok(ok_ && mark > 0, "live mark");
        (tick, minQty,) = IPerpPool(HYPE).getOrderBookParameters();
        eqA(IPerpPool(HYPE).marginBank(), BANK, "pool reports the bank");
    }

    function _open(bool viaBotKey, uint256 mark, uint256 tick, uint256 minQty) internal returns (int128 size) {
        uint256 cap = ((mark * 10_100) / 10_000 / tick) * tick; // buy IOC at most 1 % above the mark
        uint64 exp = uint64((block.timestamp + 60) * 1e9);
        if (viaBotKey) {
            vm.prank(BOT_KEY);
            IPerpPoolFor(HYPE).placeOrderFor(ACCT, true, 0, cap, minQty, exp, 2, 0, address(0), 0);
        } else {
            vm.prank(ACCT);
            IPerpPool(HYPE).placeOrder(true, 0, cap, minQty, exp, 2, 0, address(0), 0);
        }
        size = IMarginBank(BANK).getPosition(ACCT, HYPE).size;
    }

    /// The topics of the stop's booked Schedule wake-up (the system log the precompile matches).
    function _wake(ExitGuard g) internal view returns (bytes32[] memory t) {
        t = new bytes32[](2);
        t[0] = keccak256("Schedule(uint256)");
        t[1] = bytes32(uint256(g.stopState().nextWakeMs));
    }

    /// The linked bot key can still trade for the account after the account has code (the bot's own path).
    function test_fork_bot_key_still_trades_for_a_delegated_account() public {
        if (block.chainid != 50383) return;
        (, uint256 mark, uint256 tick, uint256 minQty) = _setup();
        int128 before = IMarginBank(BANK).getPosition(ACCT, HYPE).size;
        int128 size = _open(true, mark, tick, minQty);
        ok(size > before, "placeOrderFor by the bot key opened for the delegated account");
    }

    /// Full path on the real pool: open, arm, the mark crosses, the chain's call closes the whole position.
    function test_fork_stop_loss_closes_on_the_real_pool() public {
        if (block.chainid != 50383) return;
        (ExitGuard g, uint256 mark, uint256 tick, uint256 minQty) = _setup();
        int128 before = IMarginBank(BANK).getPosition(ACCT, HYPE).size;
        ok(before >= 0, "no HYPE short to start with");
        int128 size = _open(true, mark, tick, minQty); // adds to a live long if there is one (fork only)
        ok(size > before, "long open");
        uint128 sl = uint128(((mark * 9_980) / 10_000 / tick) * tick); // 0.2 % below
        vm.prank(ACCT);
        g.arm(HYPE, sl, 0, 50, 100, uint64(block.timestamp + 3_600), 5_000);
        // a quiet check first: nothing happens (explicit block numbers: via-IR may reuse one block.number read)
        uint256 bn = block.number;
        vm.roll(bn + 1);
        bytes32[] memory w = _wake(g); // read before the prank (a view call would use it up)
        vm.prank(PRECOMPILE, ACCT);
        g.onEvent(PRECOMPILE, w, "");
        ok(IMarginBank(BANK).getPosition(ACCT, HYPE).size == size, "no close above the stop");
        // the mark crosses the stop
        vmf.mockCall(HYPE, abi.encodeWithSelector(IPerpPool.tryGetMarkPrice.selector), abi.encode(true, uint256(sl) - tick));
        vm.roll(bn + 2);
        w = _wake(g);
        vm.prank(PRECOMPILE, ACCT);
        g.onEvent(PRECOMPILE, w, "");
        vmf.clearMockedCalls();
        ok(IMarginBank(BANK).getPosition(ACCT, HYPE).size == 0, "closed by the account itself on the real pool");
        eq(g.lastEnd().reason, 2, "ended as fired");
        // the bot key still works afterwards
        int128 again = _open(true, mark, tick, minQty);
        ok(again > 0, "bot key trades again after the stop");
    }
}
