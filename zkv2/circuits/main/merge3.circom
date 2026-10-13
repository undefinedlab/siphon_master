pragma circom 2.0.0;
include "../spend/merge.circom";
component main {public [publicInputs]} = Merge(32, 3);
