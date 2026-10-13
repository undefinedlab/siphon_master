pragma circom 2.0.0;
include "../spend/split.circom";
component main {public [publicInputs]} = Split(32, 8);
