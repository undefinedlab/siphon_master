/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/per_matching.json`.
 */
export type PerMatching = {
    "address": "4SN5QyVNRCjR3KsbAc9e5xVAoK6JHwrTsB1yGy7WFF7b",
    "metadata": {
      "name": "perMatching",
      "version": "0.1.0",
      "spec": "0.1.0",
      "description": "PER-based private matching engine"
    },
    "instructions": [
      {
        "name": "addUserOrder",
        "docs": [
          "Writes private order details into an already permissioned+delegated user_order PDA."
        ],
        "discriminator": [
          73,
          78,
          152,
          118,
          110,
          178,
          233,
          148
        ],
        "accounts": [
          {
            "name": "userOrder",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    117,
                    115,
                    101,
                    114,
                    95,
                    111,
                    114,
                    100,
                    101,
                    114
                  ]
                },
                {
                  "kind": "arg",
                  "path": "market"
                },
                {
                  "kind": "account",
                  "path": "user"
                },
                {
                  "kind": "arg",
                  "path": "ticketId"
                }
              ]
            }
          },
          {
            "name": "user",
            "writable": true,
            "signer": true
          }
        ],
        "args": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "ticketId",
            "type": "u64"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "salt",
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
        "name": "clearOrderbook",
        "discriminator": [
          29,
          198,
          61,
          21,
          17,
          7,
          177,
          47
        ],
        "accounts": [
          {
            "name": "orderbook",
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
                    98,
                    111,
                    111,
                    107
                  ]
                },
                {
                  "kind": "arg",
                  "path": "market"
                }
              ]
            }
          },
          {
            "name": "relayer",
            "signer": true
          }
        ],
        "args": [
          {
            "name": "market",
            "type": "pubkey"
          }
        ]
      },
      {
        "name": "createOrderbook",
        "discriminator": [
          103,
          86,
          215,
          172,
          216,
          255,
          114,
          218
        ],
        "accounts": [
          {
            "name": "orderbook",
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
                    98,
                    111,
                    111,
                    107
                  ]
                },
                {
                  "kind": "arg",
                  "path": "market"
                }
              ]
            }
          },
          {
            "name": "relayer",
            "writable": true,
            "signer": true
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": [
          {
            "name": "market",
            "type": "pubkey"
          }
        ]
      },
      {
        "name": "createPermission",
        "discriminator": [
          190,
          182,
          26,
          164,
          156,
          221,
          8,
          0
        ],
        "accounts": [
          {
            "name": "permissionedAccount"
          },
          {
            "name": "permission",
            "writable": true
          },
          {
            "name": "payer",
            "writable": true,
            "signer": true
          },
          {
            "name": "permissionProgram",
            "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": [
          {
            "name": "accountType",
            "type": {
              "defined": {
                "name": "accountType"
              }
            }
          },
          {
            "name": "members",
            "type": {
              "option": {
                "vec": {
                  "defined": {
                    "name": "member"
                  }
                }
              }
            }
          }
        ]
      },
      {
        "name": "delegatePda",
        "discriminator": [
          248,
          217,
          193,
          46,
          124,
          191,
          64,
          135
        ],
        "accounts": [
          {
            "name": "bufferPda",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    98,
                    117,
                    102,
                    102,
                    101,
                    114
                  ]
                },
                {
                  "kind": "account",
                  "path": "pda"
                }
              ],
              "program": {
                "kind": "const",
                "value": [
                  51,
                  18,
                  105,
                  108,
                  253,
                  32,
                  237,
                  238,
                  43,
                  164,
                  195,
                  7,
                  238,
                  105,
                  241,
                  223,
                  227,
                  160,
                  215,
                  87,
                  2,
                  210,
                  124,
                  113,
                  3,
                  94,
                  46,
                  38,
                  211,
                  68,
                  207,
                  182
                ]
              }
            }
          },
          {
            "name": "delegationRecordPda",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    100,
                    101,
                    108,
                    101,
                    103,
                    97,
                    116,
                    105,
                    111,
                    110
                  ]
                },
                {
                  "kind": "account",
                  "path": "pda"
                }
              ],
              "program": {
                "kind": "account",
                "path": "delegationProgram"
              }
            }
          },
          {
            "name": "delegationMetadataPda",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    100,
                    101,
                    108,
                    101,
                    103,
                    97,
                    116,
                    105,
                    111,
                    110,
                    45,
                    109,
                    101,
                    116,
                    97,
                    100,
                    97,
                    116,
                    97
                  ]
                },
                {
                  "kind": "account",
                  "path": "pda"
                }
              ],
              "program": {
                "kind": "account",
                "path": "delegationProgram"
              }
            }
          },
          {
            "name": "pda",
            "writable": true
          },
          {
            "name": "payer",
            "signer": true
          },
          {
            "name": "validator",
            "optional": true
          },
          {
            "name": "ownerProgram",
            "address": "4SN5QyVNRCjR3KsbAc9e5xVAoK6JHwrTsB1yGy7WFF7b"
          },
          {
            "name": "delegationProgram",
            "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": [
          {
            "name": "accountType",
            "type": {
              "defined": {
                "name": "accountType"
              }
            }
          }
        ]
      },
      {
        "name": "initStubOrderTicket",
        "docs": [
          "Test-only helper: create an OrderTicket-like account on L1 with only commitment."
        ],
        "discriminator": [
          84,
          201,
          169,
          58,
          5,
          187,
          219,
          139
        ],
        "accounts": [
          {
            "name": "orderTicket",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    115,
                    116,
                    117,
                    98,
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
                  "path": "ticketId"
                }
              ]
            }
          },
          {
            "name": "payer",
            "writable": true,
            "signer": true
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": [
          {
            "name": "ticketId",
            "type": "u64"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "orderCommitment",
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
        "name": "initUserOrder",
        "docs": [
          "Creates the user_order PDA *without* placing private order details on L1.",
          "The user later submits `add_user_order` via the tokenized TEE endpoint."
        ],
        "discriminator": [
          129,
          56,
          246,
          188,
          55,
          178,
          142,
          113
        ],
        "accounts": [
          {
            "name": "userOrder",
            "writable": true,
            "pda": {
              "seeds": [
                {
                  "kind": "const",
                  "value": [
                    117,
                    115,
                    101,
                    114,
                    95,
                    111,
                    114,
                    100,
                    101,
                    114
                  ]
                },
                {
                  "kind": "arg",
                  "path": "market"
                },
                {
                  "kind": "account",
                  "path": "user"
                },
                {
                  "kind": "arg",
                  "path": "ticketId"
                }
              ]
            }
          },
          {
            "name": "user",
            "writable": true,
            "signer": true
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "ticketId",
            "type": "u64"
          }
        ]
      },
      {
        "name": "prepareMatchedOrder",
        "discriminator": [
          219,
          125,
          229,
          83,
          173,
          122,
          165,
          12
        ],
        "accounts": [
          {
            "name": "matchedOrder",
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
                    104,
                    101,
                    100,
                    95,
                    111,
                    114,
                    100,
                    101,
                    114
                  ]
                },
                {
                  "kind": "arg",
                  "path": "market"
                },
                {
                  "kind": "arg",
                  "path": "matchId"
                }
              ]
            }
          },
          {
            "name": "relayer",
            "writable": true,
            "signer": true
          },
          {
            "name": "systemProgram",
            "address": "11111111111111111111111111111111"
          }
        ],
        "args": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "matchId",
            "type": "u64"
          }
        ]
      },
      {
        "name": "processUndelegation",
        "discriminator": [
          196,
          28,
          41,
          206,
          48,
          37,
          51,
          167
        ],
        "accounts": [
          {
            "name": "baseAccount",
            "writable": true
          },
          {
            "name": "buffer"
          },
          {
            "name": "payer",
            "writable": true
          },
          {
            "name": "systemProgram"
          }
        ],
        "args": [
          {
            "name": "accountSeeds",
            "type": {
              "vec": "bytes"
            }
          }
        ]
      },
      {
        "name": "recordUserOrder",
        "discriminator": [
          133,
          140,
          155,
          46,
          130,
          208,
          8,
          70
        ],
        "accounts": [
          {
            "name": "orderbook",
            "writable": true
          },
          {
            "name": "userOrder",
            "writable": true
          },
          {
            "name": "relayer",
            "signer": true
          },
          {
            "name": "orderTicket"
          }
        ],
        "args": [
          {
            "name": "ticketId",
            "type": "u64"
          }
        ]
      },
      {
        "name": "triggerMatching",
        "discriminator": [
          24,
          36,
          231,
          231,
          134,
          27,
          5,
          95
        ],
        "accounts": [
          {
            "name": "orderbook",
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
                    98,
                    111,
                    111,
                    107
                  ]
                },
                {
                  "kind": "arg",
                  "path": "market"
                }
              ]
            }
          },
          {
            "name": "matchedOrder",
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
                    104,
                    101,
                    100,
                    95,
                    111,
                    114,
                    100,
                    101,
                    114
                  ]
                },
                {
                  "kind": "arg",
                  "path": "market"
                },
                {
                  "kind": "arg",
                  "path": "matchId"
                }
              ]
            }
          },
          {
            "name": "relayer",
            "writable": true,
            "signer": true
          },
          {
            "name": "permissionMatchedOrder",
            "writable": true
          },
          {
            "name": "permissionProgram",
            "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
          },
          {
            "name": "magicProgram",
            "address": "Magic11111111111111111111111111111111111111"
          },
          {
            "name": "magicContext",
            "writable": true,
            "address": "MagicContext1111111111111111111111111111111"
          }
        ],
        "args": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "matchId",
            "type": "u64"
          },
          {
            "name": "maxMatches",
            "type": "u8"
          }
        ]
      }
    ],
    "accounts": [
      {
        "name": "l1OrderTicket",
        "discriminator": [
          223,
          253,
          4,
          153,
          186,
          184,
          18,
          51
        ]
      },
      {
        "name": "matchedOrder",
        "discriminator": [
          52,
          93,
          240,
          68,
          80,
          25,
          161,
          241
        ]
      },
      {
        "name": "orderbookState",
        "discriminator": [
          150,
          112,
          63,
          68,
          126,
          10,
          73,
          129
        ]
      },
      {
        "name": "userOrder",
        "discriminator": [
          25,
          180,
          32,
          86,
          234,
          56,
          109,
          0
        ]
      }
    ],
    "events": [
      {
        "name": "matchRoundPublishedEvent",
        "discriminator": [
          28,
          96,
          103,
          144,
          247,
          124,
          219,
          9
        ]
      },
      {
        "name": "userOrderCreatedEvent",
        "discriminator": [
          13,
          74,
          66,
          191,
          219,
          105,
          76,
          253
        ]
      },
      {
        "name": "userOrderRecordedEvent",
        "discriminator": [
          221,
          231,
          1,
          158,
          123,
          115,
          67,
          24
        ]
      }
    ],
    "errors": [
      {
        "code": 6000,
        "name": "invalidPda",
        "msg": "Invalid PDA for the given seeds."
      },
      {
        "code": 6001,
        "name": "ticketMismatch",
        "msg": "Order ticket does not match request."
      },
      {
        "code": 6002,
        "name": "userMismatch",
        "msg": "Order ticket user mismatch."
      },
      {
        "code": 6003,
        "name": "ticketNotPending",
        "msg": "Order ticket not pending."
      },
      {
        "code": 6004,
        "name": "commitmentMismatch",
        "msg": "Order commitment mismatch."
      },
      {
        "code": 6005,
        "name": "orderbookFull",
        "msg": "Orderbook capacity reached."
      },
      {
        "code": 6006,
        "name": "unauthorizedRelayer",
        "msg": "Relayer is not authorized for this orderbook."
      },
      {
        "code": 6007,
        "name": "marketMismatch",
        "msg": "Market mismatch."
      },
      {
        "code": 6008,
        "name": "userOrderNotPending",
        "msg": "User order is not pending."
      },
      {
        "code": 6009,
        "name": "userOrderAlreadyFilled",
        "msg": "User order already filled."
      },
      {
        "code": 6010,
        "name": "userOrderNotFilled",
        "msg": "User order details missing."
      },
      {
        "code": 6011,
        "name": "invalidOrder",
        "msg": "Invalid order."
      },
      {
        "code": 6012,
        "name": "matchIdMismatch",
        "msg": "Match id mismatch."
      },
      {
        "code": 6013,
        "name": "tooManyMatches",
        "msg": "max_matches exceeds MAX_MATCHES_PER_TRIGGER."
      },
      {
        "code": 6014,
        "name": "noMatches",
        "msg": "No matches available."
      }
    ],
    "types": [
      {
        "name": "accountType",
        "type": {
          "kind": "enum",
          "variants": [
            {
              "name": "orderbook",
              "fields": [
                {
                  "name": "market",
                  "type": "pubkey"
                }
              ]
            },
            {
              "name": "userOrder",
              "fields": [
                {
                  "name": "market",
                  "type": "pubkey"
                },
                {
                  "name": "user",
                  "type": "pubkey"
                },
                {
                  "name": "ticketId",
                  "type": "u64"
                }
              ]
            },
            {
              "name": "matchedOrder",
              "fields": [
                {
                  "name": "market",
                  "type": "pubkey"
                },
                {
                  "name": "matchId",
                  "type": "u64"
                }
              ]
            },
            {
              "name": "stubTicket",
              "fields": [
                {
                  "name": "ticketId",
                  "type": "u64"
                }
              ]
            }
          ]
        }
      },
      {
        "name": "l1OrderTicket",
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
        "name": "matchEntry",
        "type": {
          "kind": "struct",
          "fields": [
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
              "type": "i64"
            }
          ]
        }
      },
      {
        "name": "matchRoundPublishedEvent",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "market",
              "type": "pubkey"
            },
            {
              "name": "matchId",
              "type": "u64"
            },
            {
              "name": "matchCount",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "matchedOrder",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "market",
              "type": "pubkey"
            },
            {
              "name": "matchId",
              "type": "u64"
            },
            {
              "name": "matches",
              "type": {
                "vec": {
                  "defined": {
                    "name": "matchEntry"
                  }
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
        "name": "member",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "flags",
              "type": "u8"
            },
            {
              "name": "pubkey",
              "type": "pubkey"
            }
          ]
        }
      },
      {
        "name": "orderEntry",
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
              "name": "side",
              "type": "u8"
            },
            {
              "name": "amount",
              "type": "u64"
            },
            {
              "name": "remaining",
              "type": "u64"
            },
            {
              "name": "price",
              "type": "u64"
            },
            {
              "name": "timestamp",
              "type": "i64"
            },
            {
              "name": "active",
              "type": "bool"
            }
          ]
        }
      },
      {
        "name": "orderbookState",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "market",
              "type": "pubkey"
            },
            {
              "name": "relayer",
              "type": "pubkey"
            },
            {
              "name": "bids",
              "type": {
                "vec": {
                  "defined": {
                    "name": "orderEntry"
                  }
                }
              }
            },
            {
              "name": "asks",
              "type": {
                "vec": {
                  "defined": {
                    "name": "orderEntry"
                  }
                }
              }
            },
            {
              "name": "lastMatchId",
              "type": "u64"
            },
            {
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "userOrder",
        "type": {
          "kind": "struct",
          "fields": [
            {
              "name": "market",
              "type": "pubkey"
            },
            {
              "name": "ticketId",
              "type": "u64"
            },
            {
              "name": "user",
              "type": "pubkey"
            },
            {
              "name": "side",
              "type": "u8"
            },
            {
              "name": "amount",
              "type": "u64"
            },
            {
              "name": "price",
              "type": "u64"
            },
            {
              "name": "salt",
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
              "name": "bump",
              "type": "u8"
            }
          ]
        }
      },
      {
        "name": "userOrderCreatedEvent",
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
            }
          ]
        }
      },
      {
        "name": "userOrderRecordedEvent",
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
            }
          ]
        }
      }
    ]
  };
  