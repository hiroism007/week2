pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/poseidon.circom";


template HashLeftRight() {
    signal input left;
    signal input right;

    signal output hash;

    component poseidonHasher = Poseidon(2); // 2 means the number of inputs
    
    left ==> poseidonHasher.inputs[0];
    right ==> poseidonHasher.inputs[1];

    hash <== poseidonHasher.out;
}

template CheckRoot(n) { // compute the root of a MerkleTree of n Levels 
    signal input leaves[2**n];
    signal output root;

    // the number of total leaves
    var totalLeaves = 2 ** n;
    // the number of total hashers to hash leaves
    var numLeafHashers = totalLeaves / 2;
    // the number of HashLeftRight components to hash the output of the leaf hasher components
    var numIntermediateHashers = numLeafHashers - 1;

    // total number of hashers
    var numHashers = totalLeaves - 1;
    component hashers[numHashers];

    // initialize all hashers components
    var i;
    for (i=0; i < numHashers; i++) {
      hashers[i] = HashLeftRight();   
    }

    // set leaves to hashers
    for (i=0; i < numLeafHashers; i++){
        hashers[i].left <== leaves[i*2];
        hashers[i].right <== leaves[i*2+1];
    }

    // hash the hashers outputs
    var k = 0;
    for (i=numLeafHashers; i<numLeafHashers + numIntermediateHashers; i++) {
        hashers[i].left <== hashers[k*2].hash;
        hashers[i].right <== hashers[k*2+1].hash;
        k++;
    }

    // root should be the last intermediate hashers' hash output
    root <== hashers[numHashers-1].hash;
}

template MerkleTreeInclusionProof(n) {
    signal input leaf;
    signal input path_elements[n];
    signal input path_index[n]; // path index are 0's and 1's indicating whether the current element is on the left or right
    signal output root; // note that this is an OUTPUT signal

    // initialize components 
    component mux[n];
    component hashers[n];

    signal levelHashes[n + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < n; i++) {
        // Should be 0 or 1
        path_index[i] * (1 - path_index[i]) === 0;

        hashers[i] = HashLeftRight();
        mux[i] = MultiMux1(2);

        mux[i].c[0][0] <== levelHashes[i];
        mux[i].c[0][1] <== path_elements[i];

        mux[i].c[1][0] <== path_elements[i];
        mux[i].c[1][1] <== levelHashes[i];

        mux[i].s <== path_index[i];
        hashers[i].left <== mux[i].out[0];
        hashers[i].right <== mux[i].out[1];

        levelHashes[i + 1] <== hashers[i].hash;
    }

    root <== levelHashes[n];
}