// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Solidity port of @openzeppelin/merkle-tree StandardMerkleTree (v1.0.x) for (bytes32, bytes32)
///      leaves: leaf = keccak256(bytes.concat(keccak256(abi.encode(a, b)))), leaves sorted ascending by
///      hash, complete binary tree in array form (leaves at the end, reversed), sorted-pair hashing.
///      Cross-checked against vectors produced by packages/shared/src/merkle.ts (hedgeAllowTree).
library StandardMerkle {
    function leaf(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, b))));
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @return tree array-form tree; tree[0] is the root.
    function build(bytes32[] memory leafHashes) internal pure returns (bytes32[] memory tree) {
        uint256 n = leafHashes.length;
        require(n > 0, "empty");
        bytes32[] memory sorted = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            sorted[i] = leafHashes[i];
        }
        for (uint256 i = 1; i < n; ++i) {
            bytes32 x = sorted[i];
            uint256 j = i;
            while (j > 0 && sorted[j - 1] > x) {
                sorted[j] = sorted[j - 1];
                --j;
            }
            sorted[j] = x;
        }
        tree = new bytes32[](2 * n - 1);
        for (uint256 i; i < n; ++i) {
            tree[tree.length - 1 - i] = sorted[i];
        }
        if (tree.length > n) {
            for (uint256 i = tree.length - 1 - n;; --i) {
                tree[i] = hashPair(tree[2 * i + 1], tree[2 * i + 2]);
                if (i == 0) break;
            }
        }
    }

    function proof(bytes32[] memory tree, bytes32 leafHash) internal pure returns (bytes32[] memory out) {
        uint256 n = (tree.length + 1) / 2;
        uint256 idx = type(uint256).max;
        for (uint256 i = n - 1; i < tree.length; ++i) {
            if (tree[i] == leafHash) {
                idx = i;
                break;
            }
        }
        require(idx != type(uint256).max, "leaf not in tree");
        bytes32[] memory tmp = new bytes32[](64);
        uint256 len;
        while (idx > 0) {
            uint256 sib = idx % 2 == 1 ? idx + 1 : idx - 1;
            tmp[len++] = tree[sib];
            idx = (idx - 1) / 2;
        }
        out = new bytes32[](len);
        for (uint256 i; i < len; ++i) {
            out[i] = tmp[i];
        }
    }
}
