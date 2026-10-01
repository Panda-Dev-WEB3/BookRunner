// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MockERC20} from "../../../src/mocks/MockERC20.sol";

/// @notice 6-dp token that calls back into a target on every transfer (reentrancy probe).
contract ReentrantToken is MockERC20 {
    address public hookTarget;
    bytes public hookData;
    bool internal _inHook;

    constructor() MockERC20("Hook USD", "hUSD", 6) {}

    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (hookTarget != address(0) && !_inHook && from != address(0) && to != address(0)) {
            _inHook = true;
            (bool ok, bytes memory ret) = hookTarget.call(hookData);
            _inHook = false;
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
