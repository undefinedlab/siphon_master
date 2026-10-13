pragma circom 2.0.0;

// DOMAIN_* and program constants — must match test-vectors/domains.json + spend-core.

function DOMAIN_SMT_KEY() {
    return 1;
}
function DOMAIN_SMT_LEAF() {
    return 2;
}
function DOMAIN_PAYEE() {
    return 4;
}
function PROGRAM_VERSION() {
    return 4;
}
function PUBLIC_WIDTH() {
    return 25;
}
function MAX_INPUTS() {
    return 6;
}
function EMPTY_SMT_LEAF() {
    return 0;
}

function ACTION_WITHDRAW() {
    return 0;
}
function ACTION_MERGE() {
    return 1;
}
function ACTION_SWAP() {
    return 2;
}
function ACTION_SPLIT() {
    return 3;
}
function ACTION_RAGEQUIT() {
    return 4;
}
