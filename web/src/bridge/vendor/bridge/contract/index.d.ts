import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime-0.20';

export type Withdrawal = { solanaRecipient: Uint8Array; amount: bigint };

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  mintFromSolana(context: __compactRuntime.CircuitContext<PS>,
                 lockNonce_0: bigint,
                 recipient_0: { is_left: boolean,
                                left: { bytes: Uint8Array },
                                right: { bytes: Uint8Array }
                              },
                 amount_0: bigint,
                 mintNonce_0: Uint8Array,
                 sig_0: { r: __compactRuntime.Curve25519Point, s: bigint }): Promise<__compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                                                                           color: Uint8Array,
                                                                                                                           value: bigint
                                                                                                                         }>>;
  lockForSolana(context: __compactRuntime.CircuitContext<PS>,
                coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint },
                solanaRecipient_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type ProvableCircuits<PS> = {
  mintFromSolana(context: __compactRuntime.CircuitContext<PS>,
                 lockNonce_0: bigint,
                 recipient_0: { is_left: boolean,
                                left: { bytes: Uint8Array },
                                right: { bytes: Uint8Array }
                              },
                 amount_0: bigint,
                 mintNonce_0: Uint8Array,
                 sig_0: { r: __compactRuntime.Curve25519Point, s: bigint }): Promise<__compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                                                                           color: Uint8Array,
                                                                                                                           value: bigint
                                                                                                                         }>>;
  lockForSolana(context: __compactRuntime.CircuitContext<PS>,
                coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint },
                solanaRecipient_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type PureCircuits = {
  domainSep(mint_0: Uint8Array): Uint8Array;
  tokenColor(mint_0: Uint8Array, bridge_0: { bytes: Uint8Array }): Uint8Array;
  mintDigest(bridge_0: { bytes: Uint8Array },
             network_0: Uint8Array,
             lockNonce_0: bigint,
             recipient_0: { is_left: boolean,
                            left: { bytes: Uint8Array },
                            right: { bytes: Uint8Array }
                          },
             amount_0: bigint): Uint8Array;
}

export type Circuits<PS> = {
  domainSep(context: __compactRuntime.CircuitContext<PS>, mint_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  tokenColor(context: __compactRuntime.CircuitContext<PS>,
             mint_0: Uint8Array,
             bridge_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  mintDigest(context: __compactRuntime.CircuitContext<PS>,
             bridge_0: { bytes: Uint8Array },
             network_0: Uint8Array,
             lockNonce_0: bigint,
             recipient_0: { is_left: boolean,
                            left: { bytes: Uint8Array },
                            right: { bytes: Uint8Array }
                          },
             amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  mintFromSolana(context: __compactRuntime.CircuitContext<PS>,
                 lockNonce_0: bigint,
                 recipient_0: { is_left: boolean,
                                left: { bytes: Uint8Array },
                                right: { bytes: Uint8Array }
                              },
                 amount_0: bigint,
                 mintNonce_0: Uint8Array,
                 sig_0: { r: __compactRuntime.Curve25519Point, s: bigint }): Promise<__compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                                                                           color: Uint8Array,
                                                                                                                           value: bigint
                                                                                                                         }>>;
  lockForSolana(context: __compactRuntime.CircuitContext<PS>,
                coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint },
                solanaRecipient_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
}

export type Ledger = {
  readonly operatorKey: __compactRuntime.Curve25519Point;
  readonly sourceMint: Uint8Array;
  readonly networkTag: Uint8Array;
  mintedLocks: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): bigint;
    [Symbol.iterator](): Iterator<[bigint, bigint]>
  };
  withdrawals: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): Withdrawal;
    [Symbol.iterator](): Iterator<[bigint, Withdrawal]>
  };
  readonly withdrawalNonce: bigint;
}

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               operator_0: __compactRuntime.Curve25519Point,
               mint_0: Uint8Array,
               network_0: Uint8Array): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
export declare const circuitSignatures: __compactRuntime.CircuitSignatures;
export declare const declaredInterfaces: __compactRuntime.DeclaredInterfaces;
