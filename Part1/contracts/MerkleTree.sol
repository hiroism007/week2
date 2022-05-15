//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import { PoseidonT3 } from "./Poseidon.sol"; //an existing library to perform Poseidon hash on solidity
import "./verifier.sol"; //inherits with the MerkleTreeInclusionProof verifier contract
import "hardhat/console.sol";

contract MerkleTree is Verifier {
    uint256[] public hashes; // the Merkle tree in flattened array form
    uint256 public index = 0; // the current index of the first unfilled leaf
    uint256 public root; // the current Merkle root

    // the number of leaves that this tree can contains
    uint8 public constant INITIAL_LEAVE_SIZE = 8;
    // the tree levels
    uint8 public constant INITIAL_LEVELS = 3;
    // the number of total hashers to hash leaves
    uint8 public constant numLeafHashers = INITIAL_LEAVE_SIZE / 2;
    // the number of HashLeftRight components to hash the output of the leaf hasher components
    uint8 public constant numIntermediateHashers = numLeafHashers - 1;
    // total number of hashers
    uint8 public constant numHashers = INITIAL_LEAVE_SIZE * 2 - 1;


    constructor() {        
        // initialize 8 leaves (3 levels) markle tree and fill zero.
        // fill 0-7 index hash of 15 hashes
        for (uint8 i = 0; i < INITIAL_LEAVE_SIZE; i++) {
            hashes.push(0);
        }

        // fill 8-11 index hash of 15 hashes
        uint8 l = 0;
        for (uint8 i = INITIAL_LEAVE_SIZE; i < INITIAL_LEAVE_SIZE + numLeafHashers; i ++) {
            hashes.push(PoseidonT3.poseidon([ hashes[l * 2],  hashes[l*2 + 1]]));
        }

        // fill 12-14 index hash of 15 hashes for intermediate hashes
        uint8 k = 0;
        for (uint8 i = INITIAL_LEAVE_SIZE + numLeafHashers; i < INITIAL_LEAVE_SIZE + numLeafHashers + numIntermediateHashers; i++) {
            hashes.push(PoseidonT3.poseidon([ hashes[i - (4  - k)],  hashes[i - (4 -k) + 1]]));
            k++;
        }

        root = hashes[numHashers-1];

        // for debugging
        // for (uint8 i =0; i < numHashers; i++) {
        //     console.log(hashes[i]);
        // }
    }

    function insertLeaf(uint256 hashedLeaf) public returns (uint256) {

        uint256 currentIndex = index;
        uint256 depth = uint256(INITIAL_LEVELS);
        require(currentIndex < uint256(2) ** depth, "Full Tree");

        // replace the existing 0 value to the hashedLeaf
        hashes[currentIndex] = hashedLeaf;

        // fill 4 of 15 hashes for leaf hashes
        uint8 l = 0;
        for (uint8 i = INITIAL_LEAVE_SIZE; i < INITIAL_LEAVE_SIZE + numLeafHashers; i ++) {
            hashes[i] = PoseidonT3.poseidon([ hashes[l * 2],  hashes[l*2 + 1]]);
        }

        // fill 3 fo 15 hashes for intermediate hashes
        uint8 k = 0;
        for (uint8 i = INITIAL_LEAVE_SIZE + numLeafHashers; i < INITIAL_LEAVE_SIZE + numLeafHashers + numIntermediateHashers; i++) {
            hashes[i] = PoseidonT3.poseidon([ hashes[i - (4  - k)],  hashes[i - (4 -k) + 1]]);
            k++;
        }

        root = hashes[numHashers-1];

        // updte root and index
        root = hashes[numHashers-1];
        index = index + 1;

        return index;
    }

    function verify(
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[1] memory input
        ) public view returns (bool) {
            // input is root, thus check if root is the same as input hash.
            // make sure that proof is valid, and the root is the same as input.
            return super.verifyProof(a,b, c, input) && input[0] == root;
    }
}
