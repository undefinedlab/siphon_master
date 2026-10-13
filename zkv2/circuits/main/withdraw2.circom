pragma circom 2.0.0;
include "../spend/withdrawal.circom";
component main {public [publicInputs]} = Withdrawal(32, 2);
