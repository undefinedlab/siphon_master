/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/matching_engine.json`.
 */
export type MatchingEngine = {
    "address": "9YDjxNapUNiEMhgP8FfDJxBNEZvhvqven4LENF4gFG6y",
    "metadata": {
      "name": "matchingEngine",
      "version": "0.1.0",
      "spec": "0.1.0",
      "description": "Created with Arcium & Anchor"
    },
    "instructions": [
      {
        "name": "attestTee",
        "discriminator": [
          78,
          34,
          227,
          143,
          141,
          241,
          80,
          13
        ],
        "accounts": [
          {
            "name": "authority",
            "writable": true,
            "signer": true
          },
          {
            "name": "teeGovernance",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    116,
                    101,
                    101,
                    95,
                    103,
                    111,
                    118,
                    101,
                    114,
                    110,
                    97,
                    110,
                    99,
                    101
                  ]
                }
              ]
            }
          }
        ],
        "args": [
          {
            "name": "quoteDigest",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      },
      {
        "name": "deactivateTee",
        "discriminator": [
          202,
          37,
          163,
          222,
          47,
          67,
          37,
          90
        ],
        "accounts": [
          {
            "name": "authority",
            "writable": true,
            "signer": true
          },
          {
            "name": "teeGovernance",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    116,
                    101,
                    101,
                    95,
                    103,
                    111,
                    118,
                    101,
                    114,
                    110,
                    97,
                    110,
                    99,
                    101
                  ]
                }
              ]
            }
          }
        ],
        "args": []
      },
      {
        "name": "depositToLedger",
        "discriminator": [
          17,
          169,
          79,
          222,
          105,
          151,
          198,
          114
        ],
        "accounts": [
          {
            "name": "user",
            "writable": true,
            "signer": true
          },
          {
            "name": "signPdaAccount",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    65,
                    114,
                    99,
                    105,
                    117,
                    109,
                    83,
                    105,
                    103,
                    110,
                    101,
                    114,
                    65,
                    99,
                    99,
                    111,
                    117,
                    110,
                    116
                  ]
                }
              ]
            }
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "mempoolAccount",
            "writable": true
          },
          {
            "name": "executingPool",
            "writable": true
          },
          {
            "name": "computationAccount",
            "writable": true
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "clusterAccount",
            "writable": true
          },
          {
            "name": "poolAccount",
            "writable": true,
            "address": "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"
          },
          {
            "name": "clockAccount",
            "writable": true,
            "address": "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          },
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "vaultAuthority",
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    118,
                    97,
                    117,
                    108,
                    116,
                    95,
                    97,
                    117,
                    116,
                    104,
                    111,
                    114,
                    105,
                    116,
                    121
                  ]
                }
              ]
            }
          },
          {
            "name": "mint"
          },
          {
            "name": "vault",
            "writable": true
          },
          {
            "name": "userTokenAccount",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "account",
                  "path": "user"
                },
                {
                  "kind": "const",
                  "value": [
                    6,
                    221,
                    246,
                    225,
                    215,
                    101,
                    161,
                    147,
                    217,
                    203,
                    225,
                    70,
                    206,
                    235,
                    121,
                    172,
                    28,
                    180,
                    133,
                    237,
                    95,
                    91,
                    55,
                    145,
                    58,
                    140,
                    245,
                    133,
                    126,
                    255,
                    0,
                    169
                  ]
                },
                {
                  "kind": "account",
                  "path": "mint"
                }
              ],
              "program": {
                "kind": "const",
                "value": [
                  140,
                  151,
                  37,
                  143,
                  78,
                  36,
                  137,
                  241,
                  187,
                  61,
                  16,
                  41,
                  20,
                  142,
                  13,
                  131,
                  11,
                  90,
                  19,
                  153,
                  218,
                  255,
                  16,
                  132,
                  4,
                  142,
                  123,
                  216,
                  219,
                  233,
                  248,
                  89
                ]
              }
            }
          },
          {
            "name": "userLedger",
            "writable": true
          },
          {
            "name": "tokenProgram",
            "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          },
          {
            "name": "associatedTokenProgram",
            "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
          }
        ],
        "args": [
          {
            "name": "userEncPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "isBaseToken",
            "type": "bool"
          },
          {
            "name": "computationOffset",
            "type": "u64"
          }
        ]
      },
      {
        "name": "executeSettlement",
        "discriminator": [
          237,
          120,
          82,
          62,
          224,
          193,
          147,
          137
        ],
        "accounts": [
          {
            "name": "user",
            "writable": true,
            "signer": true,
            "address": "8wJE7H7svhpz1Jnzbne3YErWFVeWNWGRbAkDQ8xeixoY"
          },
          {
            "name": "signPdaAccount",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    65,
                    114,
                    99,
                    105,
                    117,
                    109,
                    83,
                    105,
                    103,
                    110,
                    101,
                    114,
                    65,
                    99,
                    99,
                    111,
                    117,
                    110,
                    116
                  ]
                }
              ]
            }
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "mempoolAccount",
            "writable": true
          },
          {
            "name": "executingPool",
            "writable": true
          },
          {
            "name": "computationAccount",
            "writable": true
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "clusterAccount",
            "writable": true
          },
          {
            "name": "poolAccount",
            "writable": true,
            "address": "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"
          },
          {
            "name": "clockAccount",
            "writable": true,
            "address": "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          },
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "buyerLedger",
            "writable": true
          },
          {
            "name": "sellerLedger",
            "writable": true
          }
        ],
        "args": [
          {
            "name": "user1EncPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "user2EncPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "baseQuantity",
            "type": "u64"
          },
          {
            "name": "executionPrice",
            "type": "u64"
          },
          {
            "name": "computationOffset",
            "type": "u64"
          }
        ]
      },
      {
        "name": "executeSettlementCallback",
        "discriminator": [
          155,
          21,
          85,
          44,
          87,
          244,
          230,
          40
        ],
        "accounts": [
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "computationAccount"
          },
          {
            "name": "clusterAccount"
          },
          {
            "name": "instructionsSysvar",
            "address": "Sysvar1nstructions1111111111111111111111111"
          },
          {
            "name": "user1Ledger",
            "writable": true
          },
          {
            "name": "user2Ledger",
            "writable": true
          }
        ],
        "args": [
          {
            "name": "output",
            "type": {
              "defined": {
                "name": "signedComputationOutputs",
                "generics": [
                  {
                    "kind": "type",
                    "type": {
                      "defined": {
                        "name": "executeSettlementOutput"
                      }
                    }
                  }
                ]
              }
            }
          }
        ]
      },
      {
        "name": "initExecuteSettlementCompDef",
        "discriminator": [
          51,
          244,
          88,
          43,
          178,
          36,
          82,
          182
        ],
        "accounts": [
          {
            "name": "payer",
            "writable": true,
            "signer": true
          },
          {
            "name": "mxeAccount",
            "writable": true
          },
          {
            "name": "compDefAccount",
            "writable": true
          },
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": []
      },
      {
        "name": "initSubmitOrderCheckCompDef",
        "discriminator": [
          121,
          45,
          189,
          174,
          58,
          249,
          60,
          238
        ],
        "accounts": [
          {
            "name": "payer",
            "writable": true,
            "signer": true
          },
          {
            "name": "mxeAccount",
            "writable": true
          },
          {
            "name": "compDefAccount",
            "writable": true
          },
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": []
      },
      {
        "name": "initUpdateLedgerDepositCompDef",
        "discriminator": [
          57,
          136,
          177,
          9,
          87,
          196,
          206,
          126
        ],
        "accounts": [
          {
            "name": "payer",
            "writable": true,
            "signer": true
          },
          {
            "name": "mxeAccount",
            "writable": true
          },
          {
            "name": "compDefAccount",
            "writable": true
          },
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": []
      },
      {
        "name": "initUpdateLedgerWithdrawVerifyCompDef",
        "discriminator": [
          67,
          14,
          44,
          223,
          70,
          174,
          82,
          8
        ],
        "accounts": [
          {
            "name": "payer",
            "writable": true,
            "signer": true
          },
          {
            "name": "mxeAccount",
            "writable": true
          },
          {
            "name": "compDefAccount",
            "writable": true
          },
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": []
      },
      {
        "name": "initUserLedgerCallback",
        "discriminator": [
          185,
          150,
          57,
          103,
          32,
          164,
          155,
          216
        ],
        "accounts": [
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "computationAccount"
          },
          {
            "name": "clusterAccount"
          },
          {
            "name": "instructionsSysvar",
            "address": "Sysvar1nstructions1111111111111111111111111"
          },
          {
            "name": "userLedger",
            "writable": true
          }
        ],
        "args": [
          {
            "name": "output",
            "type": {
              "defined": {
                "name": "signedComputationOutputs",
                "generics": [
                  {
                    "kind": "type",
                    "type": {
                      "defined": {
                        "name": "initUserLedgerOutput"
                      }
                    }
                  }
                ]
              }
            }
          }
        ]
      },
      {
        "name": "initUserLedgerCompDef",
        "discriminator": [
          149,
          50,
          120,
          138,
          179,
          115,
          196,
          182
        ],
        "accounts": [
          {
            "name": "payer",
            "writable": true,
            "signer": true
          },
          {
            "name": "mxeAccount",
            "writable": true
          },
          {
            "name": "compDefAccount",
            "writable": true
          },
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": []
      },
      {
        "name": "initialize",
        "discriminator": [
          175,
          175,
          109,
          31,
          13,
          152,
          155,
          237
        ],
        "accounts": [
          {
            "name": "authority",
            "writable": true,
            "signer": true
          },
          {
            "name": "globalState",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    103,
                    108,
                    111,
                    98,
                    97,
                    108,
                    95,
                    115,
                    116,
                    97,
                    116,
                    101
                  ]
                }
              ]
            }
          },
          {
            "name": "vaultAuthority",
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    118,
                    97,
                    117,
                    108,
                    116,
                    95,
                    97,
                    117,
                    116,
                    104,
                    111,
                    114,
                    105,
                    116,
                    121
                  ]
                }
              ]
            }
          },
          {
            "name": "baseMint"
          },
          {
            "name": "quoteMint"
          },
          {
            "name": "baseVault",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    118,
                    97,
                    117,
                    108,
                    116
                  ]
                },
                {
                  "kind": "account",
                  "path": "baseMint"
                }
              ]
            }
          },
          {
            "name": "quoteVault",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    118,
                    97,
                    117,
                    108,
                    116
                  ]
                },
                {
                  "kind": "account",
                  "path": "quoteMint"
                }
              ]
            }
          },
          {
            "name": "tokenProgram",
            "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": [
          {
            "name": "backendPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "type": "pubkey"
          }
        ]
      },
      {
        "name": "initializeUserLedger",
        "discriminator": [
          112,
          155,
          183,
          177,
          148,
          67,
          170,
          124
        ],
        "accounts": [
          {
            "name": "user",
            "writable": true,
            "signer": true
          },
          {
            "name": "signPdaAccount",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    65,
                    114,
                    99,
                    105,
                    117,
                    109,
                    83,
                    105,
                    103,
                    110,
                    101,
                    114,
                    65,
                    99,
                    99,
                    111,
                    117,
                    110,
                    116
                  ]
                }
              ]
            }
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "mempoolAccount",
            "writable": true
          },
          {
            "name": "executingPool",
            "writable": true
          },
          {
            "name": "computationAccount",
            "writable": true
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "clusterAccount",
            "writable": true
          },
          {
            "name": "poolAccount",
            "writable": true,
            "address": "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"
          },
          {
            "name": "clockAccount",
            "writable": true,
            "address": "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          },
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "userLedger",
            "writable": true
          }
        ],
        "args": [
          {
            "name": "userEncPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "userNonce",
            "type": "u128"
          },
          {
            "name": "computationOffset",
            "type": "u64"
          }
        ]
      },
      {
        "name": "processInitUserLedgerResult",
        "discriminator": [
          148,
          19,
          161,
          178,
          92,
          157,
          200,
          92
        ],
        "accounts": [
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "computationAccount"
          },
          {
            "name": "clusterAccount"
          },
          {
            "name": "instructionsSysvar",
            "address": "Sysvar1nstructions1111111111111111111111111"
          },
          {
            "name": "userLedger",
            "writable": true
          }
        ],
        "args": [
          {
            "name": "output",
            "type": {
              "defined": {
                "name": "signedComputationOutputs",
                "generics": [
                  {
                    "kind": "type",
                    "type": {
                      "defined": {
                        "name": "initUserLedgerOutput"
                      }
                    }
                  }
                ]
              }
            }
          }
        ]
      },
      {
        "name": "processSubmitOrderCheckResult",
        "discriminator": [
          167,
          81,
          235,
          248,
          182,
          203,
          174,
          250
        ],
        "accounts": [
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "computationAccount"
          },
          {
            "name": "clusterAccount"
          },
          {
            "name": "instructionsSysvar",
            "address": "Sysvar1nstructions1111111111111111111111111"
          },
          {
            "name": "userLedger",
            "writable": true
          },
          {
            "name": "orderAccount",
            "writable": true
          }
        ],
        "args": [
          {
            "name": "output",
            "type": {
              "defined": {
                "name": "signedComputationOutputs",
                "generics": [
                  {
                    "kind": "type",
                    "type": {
                      "defined": {
                        "name": "submitOrderCheckOutput"
                      }
                    }
                  }
                ]
              }
            }
          }
        ]
      },
      {
        "name": "receiveMatchResult",
        "discriminator": [
          235,
          197,
          43,
          225,
          251,
          123,
          87,
          238
        ],
        "accounts": [
          {
            "name": "relayer",
            "writable": true,
            "signer": true
          },
          {
            "name": "teeGovernance",
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    116,
                    101,
                    101,
                    95,
                    103,
                    111,
                    118,
                    101,
                    114,
                    110,
                    97,
                    110,
                    99,
                    101
                  ]
                }
              ]
            }
          },
          {
            "name": "matchRecord",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    109,
                    97,
                    116,
                    99,
                    104
                  ]
                },
                {
                  "kind": "arg",
                  "path": "matchId"
                }
              ]
            }
          },
          {
            "name": "instructionsSysvar",
            "address": "Sysvar1nstructions1111111111111111111111111"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": [
          {
            "name": "matchId",
            "type": "u64"
          },
          {
            "name": "buyerTicketId",
            "type": "u64"
          },
          {
            "name": "sellerTicketId",
            "type": "u64"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "executionPrice",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "u64"
          },
          {
            "name": "signature",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      },
      {
        "name": "registerTee",
        "discriminator": [
          60,
          216,
          220,
          191,
          160,
          5,
          153,
          133
        ],
        "accounts": [
          {
            "name": "authority",
            "writable": true,
            "signer": true
          },
          {
            "name": "teeGovernance",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    116,
                    101,
                    101,
                    95,
                    103,
                    111,
                    118,
                    101,
                    114,
                    110,
                    97,
                    110,
                    99,
                    101
                  ]
                }
              ]
            }
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": [
          {
            "name": "signingPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "composeHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "relayer",
            "type": "pubkey"
          },
          {
            "name": "maxAttestationStalenessSlots",
            "type": "u64"
          },
          {
            "name": "ticketTtlSeconds",
            "type": "i64"
          }
        ]
      },
      {
        "name": "submitOrderCheck",
        "discriminator": [
          67,
          45,
          148,
          21,
          193,
          203,
          84,
          15
        ],
        "accounts": [
          {
            "name": "user",
            "writable": true,
            "signer": true
          },
          {
            "name": "signPdaAccount",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    65,
                    114,
                    99,
                    105,
                    117,
                    109,
                    83,
                    105,
                    103,
                    110,
                    101,
                    114,
                    65,
                    99,
                    99,
                    111,
                    117,
                    110,
                    116
                  ]
                }
              ]
            }
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "mempoolAccount",
            "writable": true
          },
          {
            "name": "executingPool",
            "writable": true
          },
          {
            "name": "computationAccount",
            "writable": true
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "clusterAccount",
            "writable": true
          },
          {
            "name": "poolAccount",
            "writable": true,
            "address": "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"
          },
          {
            "name": "clockAccount",
            "writable": true,
            "address": "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          },
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "baseMint",
            "writable": true
          },
          {
            "name": "vault",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    118,
                    97,
                    117,
                    108,
                    116
                  ]
                },
                {
                  "kind": "account",
                  "path": "baseMint"
                }
              ]
            }
          },
          {
            "name": "orderAccount",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    111,
                    114,
                    100,
                    101,
                    114
                  ]
                },
                {
                  "kind": "arg",
                  "path": "orderId"
                }
              ]
            }
          },
          {
            "name": "orderTicket",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    111,
                    114,
                    100,
                    101,
                    114,
                    95,
                    116,
                    105,
                    99,
                    107,
                    101,
                    116
                  ]
                },
                {
                  "kind": "arg",
                  "path": "orderId"
                }
              ]
            }
          },
          {
            "name": "userLedger",
            "writable": true
          }
        ],
        "args": [
          {
            "name": "amount",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "userEncPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "orderType",
            "type": "u8"
          },
          {
            "name": "orderCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "computationOffset",
            "type": "u64"
          },
          {
            "name": "orderId",
            "type": "u64"
          },
          {
            "name": "orderNonce",
            "type": "u128"
          }
        ]
      },
      {
        "name": "submitOrderCheckCallback",
        "discriminator": [
          150,
          250,
          126,
          160,
          117,
          110,
          209,
          24
        ],
        "accounts": [
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "computationAccount"
          },
          {
            "name": "clusterAccount"
          },
          {
            "name": "instructionsSysvar",
            "address": "Sysvar1nstructions1111111111111111111111111"
          },
          {
            "name": "userLedger",
            "writable": true
          },
          {
            "name": "orderAccount",
            "writable": true
          }
        ],
        "args": [
          {
            "name": "output",
            "type": {
              "defined": {
                "name": "signedComputationOutputs",
                "generics": [
                  {
                    "kind": "type",
                    "type": {
                      "defined": {
                        "name": "submitOrderCheckOutput"
                      }
                    }
                  }
                ]
              }
            }
          }
        ]
      },
      {
        "name": "updateLedgerDepositCallback",
        "discriminator": [
          35,
          228,
          244,
          235,
          38,
          94,
          108,
          240
        ],
        "accounts": [
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "computationAccount"
          },
          {
            "name": "clusterAccount"
          },
          {
            "name": "instructionsSysvar",
            "address": "Sysvar1nstructions1111111111111111111111111"
          },
          {
            "name": "userLedger",
            "writable": true
          }
        ],
        "args": [
          {
            "name": "output",
            "type": {
              "defined": {
                "name": "signedComputationOutputs",
                "generics": [
                  {
                    "kind": "type",
                    "type": {
                      "defined": {
                        "name": "updateLedgerDepositOutput"
                      }
                    }
                  }
                ]
              }
            }
          }
        ]
      },
      {
        "name": "updateLedgerWithdrawVerifyCallback",
        "discriminator": [
          128,
          177,
          117,
          130,
          52,
          95,
          64,
          25
        ],
        "accounts": [
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "computationAccount"
          },
          {
            "name": "clusterAccount"
          },
          {
            "name": "instructionsSysvar",
            "address": "Sysvar1nstructions1111111111111111111111111"
          },
          {
            "name": "userLedger",
            "writable": true
          }
        ],
        "args": [
          {
            "name": "output",
            "type": {
              "defined": {
                "name": "signedComputationOutputs",
                "generics": [
                  {
                    "kind": "type",
                    "type": {
                      "defined": {
                        "name": "updateLedgerWithdrawVerifyOutput"
                      }
                    }
                  }
                ]
              }
            }
          }
        ]
      },
      {
        "name": "withdrawFromLedgerVerify",
        "discriminator": [
          82,
          69,
          58,
          132,
          175,
          213,
          224,
          20
        ],
        "accounts": [
          {
            "name": "user",
            "writable": true,
            "signer": true
          },
          {
            "name": "signPdaAccount",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    65,
                    114,
                    99,
                    105,
                    117,
                    109,
                    83,
                    105,
                    103,
                    110,
                    101,
                    114,
                    65,
                    99,
                    99,
                    111,
                    117,
                    110,
                    116
                  ]
                }
              ]
            }
          },
          {
            "name": "mxeAccount"
          },
          {
            "name": "mempoolAccount",
            "writable": true
          },
          {
            "name": "executingPool",
            "writable": true
          },
          {
            "name": "computationAccount",
            "writable": true
          },
          {
            "name": "compDefAccount"
          },
          {
            "name": "clusterAccount",
            "writable": true
          },
          {
            "name": "poolAccount",
            "writable": true,
            "address": "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"
          },
          {
            "name": "clockAccount",
            "writable": true,
            "address": "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          },
          {
            "name": "arciumProgram",
            "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
          },
          {
            "name": "vaultAuthority",
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    118,
                    97,
                    117,
                    108,
                    116,
                    95,
                    97,
                    117,
                    116,
                    104,
                    111,
                    114,
                    105,
                    116,
                    121
                  ]
                }
              ]
            }
          },
          {
            "name": "mint"
          },
          {
            "name": "vault",
            "writable": true
          },
          {
            "name": "userTokenAccount",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "account",
                  "path": "user"
                },
                {
                  "kind": "const",
                  "value": [
                    6,
                    221,
                    246,
                    225,
                    215,
                    101,
                    161,
                    147,
                    217,
                    203,
                    225,
                    70,
                    206,
                    235,
                    121,
                    172,
                    28,
                    180,
                    133,
                    237,
                    95,
                    91,
                    55,
                    145,
                    58,
                    140,
                    245,
                    133,
                    126,
                    255,
                    0,
                    169
                  ]
                },
                {
                  "kind": "account",
                  "path": "mint"
                }
              ],
              "program": {
                "kind": "const",
                "value": [
                  140,
                  151,
                  37,
                  143,
                  78,
                  36,
                  137,
                  241,
                  187,
                  61,
                  16,
                  41,
                  20,
                  142,
                  13,
                  131,
                  11,
                  90,
                  19,
                  153,
                  218,
                  255,
                  16,
                  132,
                  4,
                  142,
                  123,
                  216,
                  219,
                  233,
                  248,
                  89
                ]
              }
            }
          },
          {
            "name": "userLedger",
            "writable": true
          },
          {
            "name": "tokenProgram",
            "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          },
          {
            "name": "associatedTokenProgram",
            "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
          }
        ],
        "args": [
          {
            "name": "userEncPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "isBaseToken",
            "type": "bool"
          },
          {
            "name": "computationOffset",
            "type": "u64"
          }
        ]
      },
      {
        "name": "withdrawFromVault",
        "discriminator": [
          180,
          34,
          37,
          46,
          156,
          0,
          211,
          238
        ],
        "accounts": [
          {
            "name": "payer",
            "writable": true,
            "signer": true,
            "address": "8wJE7H7svhpz1Jnzbne3YErWFVeWNWGRbAkDQ8xeixoY"
          },
          {
            "name": "vaultAuthority",
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    118,
                    97,
                    117,
                    108,
                    116,
                    95,
                    97,
                    117,
                    116,
                    104,
                    111,
                    114,
                    105,
                    116,
                    121
                  ]
                }
              ]
            }
          },
          {
            "name": "mint"
          },
          {
            "name": "vault",
            "writable": true
          },
          {
            "name": "userTokenAccount",
            "writable": true
          },
          {
            "name": "tokenProgram",
            "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          }
        ],
        "args": [
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "user",
            "type": "pubkey"
          }
        ]
      }
    ],
    "accounts": [
      {
        "name": "arciumSignerAccount",
        "discriminator": [
          214,
          157,
          122,
          114,
          117,
          44,
          214,
          74
        ]
      },
      {
        "name": "clockAccount",
        "discriminator": [
          152,
          171,
          158,
          195,
          75,
          61,
          51,
          8
        ]
      },
      {
        "name": "cluster",
        "discriminator": [
          236,
          225,
          118,
          228,
          173,
          106,
          18,
          60
        ]
      },
      {
        "name": "computationDefinitionAccount",
        "discriminator": [
          245,
          176,
          217,
          221,
          253,
          104,
          172,
          200
        ]
      },
      {
        "name": "feePool",
        "discriminator": [
          172,
          38,
          77,
          146,
          148,
          5,
          51,
          242
        ]
      },
      {
        "name": "globalState",
        "discriminator": [
          163,
          46,
          74,
          168,
          216,
          123,
          133,
          98
        ]
      },
      {
        "name": "mxeAccount",
        "discriminator": [
          103,
          26,
          85,
          250,
          179,
          159,
          17,
          117
        ]
      },
      {
        "name": "matchRecord",
        "discriminator": [
          114,
          83,
          48,
          236,
          239,
          237,
          21,
          85
        ]
      },
      {
        "name": "orderAccount",
        "discriminator": [
          79,
          67,
          112,
          155,
          214,
          14,
          32,
          55
        ]
      },
      {
        "name": "orderTicket",
        "discriminator": [
          233,
          187,
          4,
          44,
          211,
          170,
          196,
          219
        ]
      },
      {
        "name": "teeGovernance",
        "discriminator": [
          171,
          103,
          92,
          185,
          117,
          134,
          250,
          236
        ]
      },
      {
        "name": "userPrivateLedger",
        "discriminator": [
          211,
          65,
          76,
          27,
          57,
          185,
          118,
          116
        ]
      }
    ],
    "events": [
      {
        "name": "orderSubmittedCheckFailedEvent",
        "discriminator": [
          94,
          34,
          150,
          39,
          252,
          39,
          88,
          140
        ]
      },
      {
        "name": "orderSubmittedCheckSuccessEvent",
        "discriminator": [
          206,
          223,
          85,
          205,
          78,
          18,
          238,
          224
        ]
      },
      {
        "name": "userLedgerDepositedEvent",
        "discriminator": [
          143,
          124,
          15,
          241,
          140,
          240,
          225,
          141
        ]
      },
      {
        "name": "userLedgerInitializedEvent",
        "discriminator": [
          253,
          25,
          128,
          78,
          35,
          32,
          141,
          48
        ]
      },
      {
        "name": "userLedgerWithdrawVerifiedFailedEvent",
        "discriminator": [
          84,
          203,
          20,
          116,
          29,
          133,
          4,
          28
        ]
      },
      {
        "name": "userLedgerWithdrawVerifiedSuccessEvent",
        "discriminator": [
          6,
          49,
          78,
          240,
          210,
          244,
          4,
          183
        ]
      },
      {
        "name": "withdrawEvent",
        "discriminator": [
          22,
          9,
          133,
          26,
          160,
          44,
          71,
          192
        ]
      }
    ],
    "errors": [
      {
        "code": 6000,
        "name": "abortedComputation",
        "msg": "The computation was aborted"
      },
      {
        "code": 6001,
        "name": "clusterNotSet",
        "msg": "Cluster not set"
      },
      {
        "code": 6002,
        "name": "orderIdOverflow",
        "msg": "Order ID overflow"
      },
      {
        "code": 6003,
        "name": "matchingTooFrequent",
        "msg": "Matching can only occur every 15 seconds"
      },
      {
        "code": 6004,
        "name": "insufficientBalance",
        "msg": "Insufficient balance"
      },
      {
        "code": 6005,
        "name": "overflow",
        "msg": "overflow"
      },
      {
        "code": 6006,
        "name": "alreadySettled",
        "msg": "Already settled"
      },
      {
        "code": 6007,
        "name": "unauthorizedSettlement",
        "msg": "Unauthorized settlement"
      },
      {
        "code": 6008,
        "name": "notApproved",
        "msg": "Not approved"
      },
      {
        "code": 6009,
        "name": "unauthorized",
        "msg": "unauthorized"
      },
      {
        "code": 6010,
        "name": "teeNotActive",
        "msg": "TEE is not active"
      },
      {
        "code": 6011,
        "name": "attestationStale",
        "msg": "Attestation is stale"
      },
      {
        "code": 6012,
        "name": "invalidTeeSignature",
        "msg": "Invalid TEE signature"
      }
    ],
    "types": [
      {
        "name": "activation",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "activationEpoch",
              "type": {
                "defined": {
                  "name": "epoch"
                }
              }
            },
            {
              "name": "deactivationEpoch",
              "type": {
                "defined": {
                  "name": "epoch"
                }
              }
            }
          ]
        }
      },
      {
        "name": "arciumSignerAccount",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "bn254g2blsPublicKey",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "array": [
                "u8",
                64
              ]
            }
          ]
        }
      },
      {
        "name": "circuitSource",
        "type": {
          "kind": "enum",
          "variants": [
            {
              "name": "local",
              "fields": [
                {
                  "defined": {
                    "name": "localCircuitSource"
                  }
                }
              ]
            },
            {
              "name": "onChain",
              "fields": [
                {
                  "defined": {
                    "name": "onChainCircuitSource"
                  }
                }
              ]
            },
            {
              "name": "offChain",
              "fields": [
                {
                  "defined": {
                    "name": "offChainCircuitSource"
                  }
                }
              ]
            }
          ]
        }
      },
      {
        "name": "clockAccount",
        "docs": [
          "An account storing the current network epoch"
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "startEpoch",
              "type": {
                "defined": {
                  "name": "epoch"
                }
              }
            },
            {
              "name": "currentEpoch",
              "type": {
                "defined": {
                  "name": "epoch"
                }
              }
            },
            {
              "name": "startEpochTimestamp",
              "type": {
                "defined": {
                  "name": "timestamp"
                }
              }
            },
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "cluster",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "tdInfo",
              "type": {
                "option": {
                  "defined": {
                    "name": "nodeMetadata"
                  }
                }
              }
            },
            {
              "name": "authority",
              "type": {
                "option": "pubkey"
              }
            },
            {
              "name": "clusterSize",
              "type": "u16"
            },
            {
              "name": "activation",
              "type": {
                "defined": {
                  "name": "activation"
                }
              }
            },
            {
              "name": "maxCapacity",
              "type": "u64"
            },
            {
              "name": "cuPrice",
              "type": "u64"
            },
            {
              "name": "cuPriceProposals",
              "type": {
                "array": [
                  "u64",
                  32
                ]
              }
            },
            {
              "name": "lastUpdatedEpoch",
              "type": {
                "defined": {
                  "name": "epoch"
                }
              }
            },
            {
              "name": "nodes",
              "type": {
                "vec": {
                  "defined": {
                    "name": "nodeRef"
                  }
                }
              }
            },
            {
              "name": "pendingNodes",
              "type": {
                "vec": "u32"
              }
            },
            {
              "name": "blsPublicKey",
              "type": {
                "defined": {
                  "name": "setUnset",
                  "generics": [
                    {
                      "kind": "type",
                      "type": {
                        "defined": {
                          "name": "bn254g2blsPublicKey"
                        }
                      }
                    }
                  ]
                }
              }
            },
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "computationDefinitionAccount",
        "docs": [
          "An account representing a [ComputationDefinition] in a MXE."
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "finalizationAuthority",
              "type": {
                "option": "pubkey"
              }
            },
            {
              "name": "cuAmount",
              "type": "u64"
            },
            {
              "name": "definition",
              "type": {
                "defined": {
                  "name": "computationDefinitionMeta"
                }
              }
            },
            {
              "name": "circuitSource",
              "type": {
                "defined": {
                  "name": "circuitSource"
                }
              }
            },
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "computationDefinitionMeta",
        "docs": [
          "A computation definition for execution in a MXE."
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "circuitLen",
              "type": "u32"
            },
            {
              "name": "signature",
              "type": {
                "defined": {
                  "name": "computationSignature"
                }
              }
            }
          ]
        }
      },
      {
        "name": "computationSignature",
        "docs": [
          "The signature of a computation defined in a [ComputationDefinition]."
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "parameters",
              "type": {
                "vec": {
                  "defined": {
                    "name": "parameter"
                  }
                }
              }
            },
            {
              "name": "outputs",
              "type": {
                "vec": {
                  "defined": {
                    "name": "output"
                  }
                }
              }
            }
          ]
        }
      },
      {
        "name": "epoch",
        "docs": [
          "The network epoch"
        ],
        "type": {
          "kind": "struct",
          "fields": [
            "u64"
          ]
        }
      },
      {
        "name": "executeSettlementOutput",
        "docs": [
          "The output of the callback instruction. Provided as a struct with ordered fields",
          "as anchor does not support tuples and tuple structs yet."
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "field0",
              "type": {
                "defined": {
                  "name": "executeSettlementOutputStruct0"
                }
              }
            }
          ]
        }
      },
      {
        "name": "executeSettlementOutputStruct0",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "field0",
              "type": {
                "defined": {
                  "name": "sharedEncryptedStruct",
                  "generics": [
                    {
                      "kind": "const",
                      "value": "4"
                    }
                  ]
                }
              }
            },
            {
              "name": "field1",
              "type": {
                "defined": {
                  "name": "sharedEncryptedStruct",
                  "generics": [
                    {
                      "kind": "const",
                      "value": "4"
                    }
                  ]
                }
              }
            }
          ]
        }
      },
      {
        "name": "feePool",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "globalState",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "authority",
              "type": "pubkey"
            },
            {
              "name": "backendPubkey",
              "type": {
                "array": [
                  "u8",
                  32
                ]
              }
            },
            {
              "name": "baseMint",
              "type": "pubkey"
            },
            {
              "name": "quoteMint",
              "type": "pubkey"
            },
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "initUserLedgerOutput",
        "docs": [
          "The output of the callback instruction. Provided as a struct with ordered fields",
          "as anchor does not support tuples and tuple structs yet."
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "field0",
              "type": {
                "defined": {
                  "name": "sharedEncryptedStruct",
                  "generics": [
                    {
                      "kind": "const",
                      "value": "4"
                    }
                  ]
                }
              }
            }
          ]
        }
      },
      {
        "name": "localCircuitSource",
        "type": {
          "kind": "enum",
          "variants": [
            {
              "name": "mxeKeygen"
            },
            {
              "name": "mxeKeyRecoveryInit"
            },
            {
              "name": "mxeKeyRecoveryFinalize"
            }
          ]
        }
      },
      {
        "name": "mxeAccount",
        "docs": [
          "A MPC Execution Environment."
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "cluster",
              "type": {
                "option": "u32"
              }
            },
            {
              "name": "keygenOffset",
              "type": "u64"
            },
            {
              "name": "keyRecoveryInitOffset",
              "type": "u64"
            },
            {
              "name": "mxeProgramId",
              "type": "pubkey"
            },
            {
              "name": "authority",
              "type": {
                "option": "pubkey"
              }
            },
            {
              "name": "utilityPubkeys",
              "type": {
                "defined": {
                  "name": "setUnset",
                  "generics": [
                    {
                      "kind": "type",
                      "type": {
                        "defined": {
                          "name": "utilityPubkeys"
                        }
                      }
                    }
                  ]
                }
              }
            },
            {
              "name": "fallbackClusters",
              "type": {
                "vec": "u32"
              }
            },
            {
              "name": "rejectedClusters",
              "type": {
                "vec": "u32"
              }
            },
            {
              "name": "computationDefinitions",
              "type": {
                "vec": "u32"
              }
            },
            {
              "name": "status",
              "type": {
                "defined": {
                  "name": "mxeStatus"
                }
              }
            },
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "matchRecord",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "matchId",
              "type": "u64"
            },
            {
              "name": "isSettled",
              "type": "bool"
            },
            {
              "name": "settlementTimestamp",
              "type": "i64"
            }
          ]
        }
      },
      {
        "name": "mxeStatus",
        "docs": [
          "The status of an MXE."
        ],
        "type": {
          "kind": "enum",
          "variants": [
            {
              "name": "active"
            },
            {
              "name": "recovery"
            }
          ]
        }
      },
      {
        "name": "nodeMetadata",
        "docs": [
          "location as [ISO 3166-1 alpha-2](https://www.iso.org/iso-3166-country-codes.html) country code"
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "ip",
              "type": {
                "array": [
                  "u8",
                  4
                ]
              }
            },
            {
              "name": "peerId",
              "type": {
                "array": [
                  "u8",
                  32
                ]
              }
            },
            {
              "name": "location",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "nodeRef",
        "docs": [
          "A reference to a node in the cluster.",
          "The offset is to derive the Node Account.",
          "The current_total_rewards is the total rewards the node has received so far in the current",
          "epoch."
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "offset",
              "type": "u32"
            },
            {
              "name": "currentTotalRewards",
              "type": "u64"
            },
            {
              "name": "vote",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "offChainCircuitSource",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "source",
              "type": "string"
            },
            {
              "name": "hash",
              "type": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          ]
        }
      },
      {
        "name": "onChainCircuitSource",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "isCompleted",
              "type": "bool"
            },
            {
              "name": "uploadAuth",
              "type": "pubkey"
            }
          ]
        }
      },
      {
        "name": "orderAccount",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "orderId",
              "type": "u64"
            },
            {
              "name": "user",
              "type": "pubkey"
            },
            {
              "name": "encryptedOrder",
              "type": {
                "array": [
                  {
                    "array": [
                      "u8",
                      32
                    ]
                  },
                  7
                ]
              }
            },
            {
              "name": "orderNonce",
              "type": "u128"
            },
            {
              "name": "timestamp",
              "type": "i64"
            },
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "orderSubmittedCheckFailedEvent",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "orderId",
              "type": "u64"
            },
            {
              "name": "user",
              "type": "pubkey"
            }
          ]
        }
      },
      {
        "name": "orderSubmittedCheckSuccessEvent",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "orderId",
              "type": "u64"
            },
            {
              "name": "user",
              "type": "pubkey"
            },
            {
              "name": "success",
              "type": "bool"
            },
            {
              "name": "timestamp",
              "type": "i64"
            },
            {
              "name": "orderNonce",
              "type": "u128"
            }
          ]
        }
      },
      {
        "name": "orderTicket",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "ticketId",
              "type": "u64"
            },
            {
              "name": "user",
              "type": "pubkey"
            },
            {
              "name": "userEncPubkey",
              "type": {
                "array": [
                  "u8",
                  32
                ]
              }
            },
            {
              "name": "createdAt",
              "type": "i64"
            },
            {
              "name": "status",
              "type": "u8"
            },
            {
              "name": "orderCommitment",
              "type": {
                "array": [
                  "u8",
                  32
                ]
              }
            },
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "output",
        "docs": [
          "An output of a computation.",
          "We currently don't support encrypted outputs yet since encrypted values are passed via",
          "data objects."
        ],
        "type": {
          "kind": "enum",
          "variants": [
            {
              "name": "plaintextBool"
            },
            {
              "name": "plaintextU8"
            },
            {
              "name": "plaintextU16"
            },
            {
              "name": "plaintextU32"
            },
            {
              "name": "plaintextU64"
            },
            {
              "name": "plaintextU128"
            },
            {
              "name": "ciphertext"
            },
            {
              "name": "arcisX25519Pubkey"
            },
            {
              "name": "plaintextFloat"
            },
            {
              "name": "plaintextPoint"
            },
            {
              "name": "plaintextI8"
            },
            {
              "name": "plaintextI16"
            },
            {
              "name": "plaintextI32"
            },
            {
              "name": "plaintextI64"
            },
            {
              "name": "plaintextI128"
            }
          ]
        }
      },
      {
        "name": "parameter",
        "docs": [
          "A parameter of a computation.",
          "We differentiate between plaintext and encrypted parameters and data objects.",
          "Plaintext parameters are directly provided as their value.",
          "Encrypted parameters are provided as an offchain reference to the data.",
          "Data objects are provided as a reference to the data object account."
        ],
        "type": {
          "kind": "enum",
          "variants": [
            {
              "name": "plaintextBool"
            },
            {
              "name": "plaintextU8"
            },
            {
              "name": "plaintextU16"
            },
            {
              "name": "plaintextU32"
            },
            {
              "name": "plaintextU64"
            },
            {
              "name": "plaintextU128"
            },
            {
              "name": "ciphertext"
            },
            {
              "name": "arcisX25519Pubkey"
            },
            {
              "name": "arcisSignature"
            },
            {
              "name": "plaintextFloat"
            },
            {
              "name": "plaintextI8"
            },
            {
              "name": "plaintextI16"
            },
            {
              "name": "plaintextI32"
            },
            {
              "name": "plaintextI64"
            },
            {
              "name": "plaintextI128"
            },
            {
              "name": "plaintextPoint"
            }
          ]
        }
      },
      {
        "name": "setUnset",
        "docs": [
          "Utility struct to store a value that needs to be set by a certain number of participants (keys",
          "in our case). Once all participants have set the value, the value is considered set and we only",
          "store it once."
        ],
        "generics": [
          {
            "kind": "type",
            "name": "t"
          }
        ],
        "type": {
          "kind": "enum",
          "variants": [
            {
              "name": "set",
              "fields": [
                {
                  "generic": "t"
                }
              ]
            },
            {
              "name": "unset",
              "fields": [
                {
                  "generic": "t"
                },
                {
                  "vec": "bool"
                }
              ]
            }
          ]
        }
      },
      {
        "name": "sharedEncryptedStruct",
        "generics": [
          {
            "kind": "const",
            "name": "len",
            "type": "usize"
          }
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "encryptionKey",
              "type": {
                "array": [
                  "u8",
                  32
                ]
              }
            },
            {
              "name": "nonce",
              "type": "u128"
            },
            {
              "name": "ciphertexts",
              "type": {
                "array": [
                  {
                    "array": [
                      "u8",
                      32
                    ]
                  },
                  {
                    "generic": "len"
                  }
                ]
              }
            }
          ]
        }
      },
      {
        "name": "signedComputationOutputs",
        "generics": [
          {
            "kind": "type",
            "name": "o"
          }
        ],
        "type": {
          "kind": "enum",
          "variants": [
            {
              "name": "success",
              "fields": [
                {
                  "generic": "o"
                },
                {
                  "array": [
                    "u8",
                    64
                  ]
                }
              ]
            },
            {
              "name": "failure"
            },
            {
              "name": "markerForIdlBuildDoNotUseThis",
              "fields": [
                {
                  "generic": "o"
                }
              ]
            }
          ]
        }
      },
      {
        "name": "submitOrderCheckOutput",
        "docs": [
          "The output of the callback instruction. Provided as a struct with ordered fields",
          "as anchor does not support tuples and tuple structs yet."
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "field0",
              "type": {
                "defined": {
                  "name": "submitOrderCheckOutputStruct0"
                }
              }
            }
          ]
        }
      },
      {
        "name": "submitOrderCheckOutputStruct0",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "field0",
              "type": "bool"
            },
            {
              "name": "field1",
              "type": {
                "defined": {
                  "name": "sharedEncryptedStruct",
                  "generics": [
                    {
                      "kind": "const",
                      "value": "4"
                    }
                  ]
                }
              }
            },
            {
              "name": "field2",
              "type": {
                "defined": {
                  "name": "sharedEncryptedStruct",
                  "generics": [
                    {
                      "kind": "const",
                      "value": "7"
                    }
                  ]
                }
              }
            }
          ]
        }
      },
      {
        "name": "teeGovernance",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "authority",
              "docs": [
                "Admin authority controlling TEE registration/attestation for MVP."
              ],
              "type": "pubkey"
            },
            {
              "name": "relayer",
              "docs": [
                "Whitelisted relayer allowed to submit `receive_match_result` (MVP)."
              ],
              "type": "pubkey"
            },
            {
              "name": "signingPubkey",
              "docs": [
                "TEE signing pubkey (ed25519, 32 bytes)."
              ],
              "type": {
                "array": [
                  "u8",
                  32
                ]
              }
            },
            {
              "name": "composeHash",
              "docs": [
                "compose-hash (RTMR3) pinned for this TEE application."
              ],
              "type": {
                "array": [
                  "u8",
                  32
                ]
              }
            },
            {
              "name": "epoch",
              "docs": [
                "Key-rotation epoch (reserved for later)."
              ],
              "type": "u64"
            },
            {
              "name": "lastAttestedSlot",
              "docs": [
                "Last on-chain slot when the TEE was successfully attested."
              ],
              "type": "u64"
            },
            {
              "name": "maxAttestationStalenessSlots",
              "docs": [
                "Max allowed staleness (in slots) for accepting match results."
              ],
              "type": "u64"
            },
            {
              "name": "ticketTtlSeconds",
              "docs": [
                "Default ticket TTL in seconds (reserved for OrderTicket implementation)."
              ],
              "type": "i64"
            },
            {
              "name": "isActive",
              "docs": [
                "Whether the TEE is active."
              ],
              "type": "bool"
            },
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "timestamp",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "timestamp",
              "type": "u64"
            }
          ]
        }
      },
      {
        "name": "updateLedgerDepositOutput",
        "docs": [
          "The output of the callback instruction. Provided as a struct with ordered fields",
          "as anchor does not support tuples and tuple structs yet."
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "field0",
              "type": {
                "defined": {
                  "name": "sharedEncryptedStruct",
                  "generics": [
                    {
                      "kind": "const",
                      "value": "4"
                    }
                  ]
                }
              }
            }
          ]
        }
      },
      {
        "name": "updateLedgerWithdrawVerifyOutput",
        "docs": [
          "The output of the callback instruction. Provided as a struct with ordered fields",
          "as anchor does not support tuples and tuple structs yet."
        ],
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "field0",
              "type": {
                "defined": {
                  "name": "updateLedgerWithdrawVerifyOutputStruct0"
                }
              }
            }
          ]
        }
      },
      {
        "name": "updateLedgerWithdrawVerifyOutputStruct0",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "field0",
              "type": {
                "defined": {
                  "name": "sharedEncryptedStruct",
                  "generics": [
                    {
                      "kind": "const",
                      "value": "4"
                    }
                  ]
                }
              }
            },
            {
              "name": "field1",
              "type": "bool"
            }
          ]
        }
      },
      {
        "name": "userLedgerDepositedEvent",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "user",
              "type": "pubkey"
            },
            {
              "name": "balanceNonce",
              "type": "u128"
            },
            {
              "name": "encryptedBalances",
              "type": {
                "array": [
                  {
                    "array": [
                      "u8",
                      32
                    ]
                  },
                  4
                ]
              }
            },
            {
              "name": "lastUpdate",
              "type": "i64"
            }
          ]
        }
      },
      {
        "name": "userLedgerInitializedEvent",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "user",
              "type": "pubkey"
            },
            {
              "name": "balanceNonce",
              "type": "u128"
            },
            {
              "name": "lastUpdate",
              "type": "i64"
            }
          ]
        }
      },
      {
        "name": "userLedgerWithdrawVerifiedFailedEvent",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "user",
              "type": "pubkey"
            }
          ]
        }
      },
      {
        "name": "userLedgerWithdrawVerifiedSuccessEvent",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "user",
              "type": "pubkey"
            },
            {
              "name": "balanceNonce",
              "type": "u128"
            },
            {
              "name": "encryptedBalances",
              "type": {
                "array": [
                  {
                    "array": [
                      "u8",
                      32
                    ]
                  },
                  4
                ]
              }
            },
            {
              "name": "lastUpdate",
              "type": "i64"
            }
          ]
        }
      },
      {
        "name": "userPrivateLedger",
        "serialization": "bytemuckunsafe",
        "repr": {
          "kind": "c",
          "packed": true
        },
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "owner",
              "type": "pubkey"
            },
            {
              "name": "encryptedBalances",
              "type": {
                "array": [
                  {
                    "array": [
                      "u8",
                      32
                    ]
                  },
                  4
                ]
              }
            },
            {
              "name": "balanceNonce",
              "type": "u128"
            },
            {
              "name": "lastUpdate",
              "type": "i64"
            },
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "utilityPubkeys",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "x25519Pubkey",
              "type": {
                "array": [
                  "u8",
                  32
                ]
              }
            },
            {
              "name": "ed25519VerifyingKey",
              "type": {
                "array": [
                  "u8",
                  32
                ]
              }
            },
            {
              "name": "elgamalPubkey",
              "type": {
                "array": [
                  "u8",
                  32
                ]
              }
            },
            {
              "name": "pubkeyValidityProof",
              "type": {
                "array": [
                  "u8",
                  64
                ]
              }
            }
          ]
        }
      },
      {
        "name": "withdrawEvent",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "user",
              "type": "pubkey"
            },
            {
              "name": "amount",
              "type": "u64"
            }
          ]
        }
      }
    ]
  };
  