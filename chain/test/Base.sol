// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// The few Foundry cheatcodes these tests use (no forge-std dependency).
interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function etch(address target, bytes calldata code) external;
    function prank(address msgSender) external;
    function prank(address msgSender, address txOrigin) external;
    function deal(address account, uint256 newBalance) external;
    function warp(uint256 newTimestamp) external;
    function roll(uint256 newHeight) external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function expectRevert() external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function load(address target, bytes32 slot) external view returns (bytes32);
    function assume(bool condition) external pure;
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function eq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert(string.concat(what, ": ", _u(a), " != ", _u(b)));
    }

    function eqA(address a, address b, string memory what) internal pure {
        if (a != b) revert(string.concat(what, ": address mismatch"));
    }

    function ok(bool c, string memory what) internal pure {
        if (!c) revert(what);
    }

    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi <= lo) return lo;
        return lo + (x % (hi - lo + 1));
    }

    function _u(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v != 0) {
            b = abi.encodePacked(bytes1(uint8(48 + (v % 10))), b);
            v /= 10;
        }
        return string(b);
    }
}
