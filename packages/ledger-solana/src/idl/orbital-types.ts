/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/orbital.json`.
 */
export type Orbital = {
  "address": "3sRnQvQFEDeZ7Mt5hTk2hghucfB1RvdAB1RMq17BSZBa",
  "metadata": {
    "name": "orbital",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "consume",
      "docs": [
        "Destroy goods in an owner's inventory."
      ],
      "discriminator": [
        65,
        178,
        141,
        13,
        95,
        57,
        76,
        154
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "owner",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "cargo",
          "type": {
            "vec": {
              "defined": {
                "name": "cargo"
              }
            }
          }
        }
      ]
    },
    {
      "name": "createCurrency",
      "docs": [
        "Creates the SPL mint for one planet currency (PDA mint, PDA authority, 0 decimals)."
      ],
      "discriminator": [
        148,
        249,
        90,
        34,
        172,
        92,
        48,
        196
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
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
          "name": "mint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "code"
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
          "name": "code",
          "type": {
            "array": [
              "u8",
              3
            ]
          }
        }
      ]
    },
    {
      "name": "createPlanet",
      "docs": [
        "Initialises a pre-allocated zero-copy ledger for one planet."
      ],
      "discriminator": [
        109,
        42,
        0,
        132,
        145,
        210,
        15,
        25
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "ledger",
          "docs": [
            "Pre-allocated by the client at full size (too big for a CPI-created account),",
            "owned by this program and still zeroed; `zero` checks exactly that."
          ],
          "writable": true
        }
      ],
      "args": [
        {
          "name": "planet",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "currency",
          "type": {
            "array": [
              "u8",
              3
            ]
          }
        }
      ]
    },
    {
      "name": "grant",
      "docs": [
        "Genesis: place starting goods in an owner's inventory on this planet."
      ],
      "discriminator": [
        145,
        189,
        68,
        153,
        161,
        231,
        76,
        107
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "owner",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "cargo",
          "type": {
            "vec": {
              "defined": {
                "name": "cargo"
              }
            }
          }
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "One-time setup: records the admin who may create currencies."
      ],
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
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
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
      "args": []
    },
    {
      "name": "issue",
      "docs": [
        "Genesis mint into a purse."
      ],
      "discriminator": [
        190,
        1,
        98,
        214,
        81,
        99,
        222,
        247
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mintAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
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
          "name": "mint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "code"
              }
            ]
          }
        },
        {
          "name": "purse",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  117,
                  114,
                  115,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "code"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "owner",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "code",
          "type": {
            "array": [
              "u8",
              3
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "openPurse",
      "docs": [
        "Opens an owner's purse (self-owned SPL token account) in one currency."
      ],
      "discriminator": [
        70,
        195,
        64,
        139,
        136,
        198,
        149,
        120
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "code"
              }
            ]
          }
        },
        {
          "name": "purse",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  117,
                  114,
                  115,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "code"
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
          "name": "owner",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "code",
          "type": {
            "array": [
              "u8",
              3
            ]
          }
        }
      ]
    },
    {
      "name": "produce",
      "docs": [
        "Consume inputs and create outputs in an owner's inventory."
      ],
      "discriminator": [
        240,
        243,
        185,
        55,
        195,
        151,
        136,
        205
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "owner",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "inputs",
          "type": {
            "vec": {
              "defined": {
                "name": "cargo"
              }
            }
          }
        },
        {
          "name": "outputs",
          "type": {
            "vec": {
              "defined": {
                "name": "cargo"
              }
            }
          }
        }
      ]
    },
    {
      "name": "transfer",
      "docs": [
        "Moves currency between two purses of the same currency."
      ],
      "discriminator": [
        163,
        52,
        200,
        231,
        140,
        3,
        69,
        186
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "fromPurse",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  117,
                  114,
                  115,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "fromOwner"
              },
              {
                "kind": "arg",
                "path": "code"
              }
            ]
          }
        },
        {
          "name": "toPurse",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  117,
                  114,
                  115,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "toOwner"
              },
              {
                "kind": "arg",
                "path": "code"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "fromOwner",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "toOwner",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "code",
          "type": {
            "array": [
              "u8",
              3
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "planetLedger",
      "discriminator": [
        161,
        22,
        222,
        6,
        183,
        153,
        163,
        181
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Only the admin can do this"
    },
    {
      "code": 6001,
      "name": "invalidCurrencyCode",
      "msg": "Currency code must be 3 ASCII capitals"
    },
    {
      "code": 6002,
      "name": "invalidAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6003,
      "name": "insufficientFunds",
      "msg": "Insufficient funds in purse"
    },
    {
      "code": 6004,
      "name": "insufficientInventory",
      "msg": "Insufficient inventory"
    },
    {
      "code": 6005,
      "name": "ledgerFull",
      "msg": "Planet ledger is full"
    },
    {
      "code": 6006,
      "name": "tooManyCargoLines",
      "msg": "Too many cargo lines"
    },
    {
      "code": 6007,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "cargo",
      "docs": [
        "One line of cargo in an instruction: `good` is sha256(goodId), computed client-side."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "good",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "qty",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "config",
      "docs": [
        "Singleton: who may create currencies and operate the ledger (the sim engine)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "inventorySlot",
      "docs": [
        "One inventory entry: how many units of `good` `owner` holds on this planet.",
        "Entries are never removed (a zero qty entry is reused), so `len` only grows."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "good",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "qty",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "planetLedger",
      "docs": [
        "All inventories on one planet, in one big account (zero-copy: no deserialization,",
        "so the 74 KB body costs nothing to load). Created by the client at full size and",
        "initialised by `create_planet`."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "planet",
            "docs": [
              "sha256(planetId)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "currency",
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                5
              ]
            }
          },
          {
            "name": "len",
            "type": "u64"
          },
          {
            "name": "slots",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "inventorySlot"
                  }
                },
                1024
              ]
            }
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "configSeed",
      "docs": [
        "Seed of the singleton Config account."
      ],
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "mintAuthoritySeed",
      "docs": [
        "Seed of the PDA that is the mint authority of every currency.",
        "It holds no data and no key exists for it: only this program can sign as it."
      ],
      "type": "bytes",
      "value": "[109, 105, 110, 116, 95, 97, 117, 116, 104, 111, 114, 105, 116, 121]"
    },
    {
      "name": "mintSeed",
      "docs": [
        "Seed prefix of each currency mint: [\"mint\", currency_code]."
      ],
      "type": "bytes",
      "value": "[109, 105, 110, 116]"
    },
    {
      "name": "purseSeed",
      "docs": [
        "Seed prefix of each purse (an SPL token account): [\"purse\", owner, currency_code]."
      ],
      "type": "bytes",
      "value": "[112, 117, 114, 115, 101]"
    }
  ]
};
