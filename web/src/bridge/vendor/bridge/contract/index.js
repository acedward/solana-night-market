import * as __compactRuntime from '@midnight-ntwrk/compact-runtime-0.20';
__compactRuntime.checkRuntimeVersion('0.20.0');

const _descriptor_0 = new __compactRuntime.CompactTypeBytes(32);

class _ContractAddress_0 {
  alignment() {
    return _descriptor_0.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.bytes);
  }
}

const _descriptor_1 = new _ContractAddress_0();

const _descriptor_2 = new __compactRuntime.CompactTypeUnsignedInteger(18446744073709551615n, 8);

class _Withdrawal_0 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_2.alignment());
  }
  fromValue(value_0) {
    return {
      solanaRecipient: _descriptor_0.fromValue(value_0),
      amount: _descriptor_2.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.solanaRecipient).concat(_descriptor_2.toValue(value_0.amount));
  }
}

const _descriptor_3 = new _Withdrawal_0();

const _descriptor_4 = new __compactRuntime.CompactTypeUnsignedInteger(65535n, 2);

const _descriptor_5 = new __compactRuntime.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);

class _ShieldedCoinInfo_0 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_5.alignment()));
  }
  fromValue(value_0) {
    return {
      nonce: _descriptor_0.fromValue(value_0),
      color: _descriptor_0.fromValue(value_0),
      value: _descriptor_5.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.nonce).concat(_descriptor_0.toValue(value_0.color).concat(_descriptor_5.toValue(value_0.value)));
  }
}

const _descriptor_6 = new _ShieldedCoinInfo_0();

const _descriptor_7 = __compactRuntime.CompactTypeBoolean;

class _ZswapCoinPublicKey_0 {
  alignment() {
    return _descriptor_0.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.bytes);
  }
}

const _descriptor_8 = new _ZswapCoinPublicKey_0();

class _Either_0 {
  alignment() {
    return _descriptor_7.alignment().concat(_descriptor_8.alignment().concat(_descriptor_1.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_7.fromValue(value_0),
      left: _descriptor_8.fromValue(value_0),
      right: _descriptor_1.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_7.toValue(value_0.is_left).concat(_descriptor_8.toValue(value_0.left).concat(_descriptor_1.toValue(value_0.right)));
  }
}

const _descriptor_9 = new _Either_0();

const _descriptor_10 = __compactRuntime.CompactTypeCurve25519Point;

const _descriptor_11 = __compactRuntime.CompactTypeCurve25519Scalar;

class _Ed25519Signature_0 {
  alignment() {
    return _descriptor_10.alignment().concat(_descriptor_11.alignment());
  }
  fromValue(value_0) {
    return {
      r: _descriptor_10.fromValue(value_0),
      s: _descriptor_11.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_10.toValue(value_0.r).concat(_descriptor_11.toValue(value_0.s));
  }
}

const _descriptor_12 = new _Ed25519Signature_0();

const _descriptor_13 = __compactRuntime.CompactTypeCurve25519Base;

const _descriptor_14 = new __compactRuntime.CompactTypeBytes(40);

class _tuple_0 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_14.alignment()));
  }
  fromValue(value_0) {
    return [
      _descriptor_0.fromValue(value_0),
      _descriptor_0.fromValue(value_0),
      _descriptor_14.fromValue(value_0)
    ]
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0[0]).concat(_descriptor_0.toValue(value_0[1]).concat(_descriptor_14.toValue(value_0[2])));
  }
}

const _descriptor_15 = new _tuple_0();

const _descriptor_16 = new __compactRuntime.CompactTypeBytes(64);

const _descriptor_17 = new __compactRuntime.CompactTypeVector(2, _descriptor_0);

class _tuple_1 {
  alignment() {
    return _descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_2.alignment().concat(_descriptor_7.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment().concat(_descriptor_2.alignment())))))));
  }
  fromValue(value_0) {
    return [
      _descriptor_0.fromValue(value_0),
      _descriptor_0.fromValue(value_0),
      _descriptor_0.fromValue(value_0),
      _descriptor_2.fromValue(value_0),
      _descriptor_7.fromValue(value_0),
      _descriptor_0.fromValue(value_0),
      _descriptor_0.fromValue(value_0),
      _descriptor_2.fromValue(value_0)
    ]
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0[0]).concat(_descriptor_0.toValue(value_0[1]).concat(_descriptor_0.toValue(value_0[2]).concat(_descriptor_2.toValue(value_0[3]).concat(_descriptor_7.toValue(value_0[4]).concat(_descriptor_0.toValue(value_0[5]).concat(_descriptor_0.toValue(value_0[6]).concat(_descriptor_2.toValue(value_0[7]))))))));
  }
}

const _descriptor_18 = new _tuple_1();

const _descriptor_19 = new __compactRuntime.CompactTypeBytes(21);

class _CoinPreimage_0 {
  alignment() {
    return _descriptor_19.alignment().concat(_descriptor_6.alignment().concat(_descriptor_7.alignment().concat(_descriptor_0.alignment())));
  }
  fromValue(value_0) {
    return {
      domain_sep: _descriptor_19.fromValue(value_0),
      info: _descriptor_6.fromValue(value_0),
      dataType: _descriptor_7.fromValue(value_0),
      data: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_19.toValue(value_0.domain_sep).concat(_descriptor_6.toValue(value_0.info).concat(_descriptor_7.toValue(value_0.dataType).concat(_descriptor_0.toValue(value_0.data))));
  }
}

const _descriptor_20 = new _CoinPreimage_0();

class _Either_1 {
  alignment() {
    return _descriptor_7.alignment().concat(_descriptor_0.alignment().concat(_descriptor_0.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_7.fromValue(value_0),
      left: _descriptor_0.fromValue(value_0),
      right: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_7.toValue(value_0.is_left).concat(_descriptor_0.toValue(value_0.left).concat(_descriptor_0.toValue(value_0.right)));
  }
}

const _descriptor_21 = new _Either_1();

class _UserAddress_0 {
  alignment() {
    return _descriptor_0.alignment();
  }
  fromValue(value_0) {
    return {
      bytes: _descriptor_0.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_0.toValue(value_0.bytes);
  }
}

const _descriptor_22 = new _UserAddress_0();

class _Either_2 {
  alignment() {
    return _descriptor_7.alignment().concat(_descriptor_1.alignment().concat(_descriptor_22.alignment()));
  }
  fromValue(value_0) {
    return {
      is_left: _descriptor_7.fromValue(value_0),
      left: _descriptor_1.fromValue(value_0),
      right: _descriptor_22.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_7.toValue(value_0.is_left).concat(_descriptor_1.toValue(value_0.left).concat(_descriptor_22.toValue(value_0.right)));
  }
}

const _descriptor_23 = new _Either_2();

class _Maybe_0 {
  alignment() {
    return _descriptor_7.alignment().concat(_descriptor_23.alignment());
  }
  fromValue(value_0) {
    return {
      is_some: _descriptor_7.fromValue(value_0),
      value: _descriptor_23.fromValue(value_0)
    }
  }
  toValue(value_0) {
    return _descriptor_7.toValue(value_0.is_some).concat(_descriptor_23.toValue(value_0.value));
  }
}

const _descriptor_24 = new _Maybe_0();

const _descriptor_25 = new __compactRuntime.CompactTypeUnsignedInteger(255n, 1);

const _descriptor_26 = new __compactRuntime.CompactTypeUnsignedInteger(4294967295n, 4);

export class Contract {
  witnesses;
  constructor(...args_0) {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`Contract constructor: expected 1 argument, received ${args_0.length}`);
    }
    const witnesses_0 = args_0[0];
    if (typeof(witnesses_0) !== 'object') {
      throw new __compactRuntime.CompactError('first (witnesses) argument to Contract constructor is not an object');
    }
    this.witnesses = witnesses_0;
    this.circuits = {
      async domainSep(context, ...args_1) {
        return { result: pureCircuits.domainSep(...args_1), context };
      },
      async tokenColor(context, ...args_1) {
        return { result: pureCircuits.tokenColor(...args_1), context };
      },
      async mintDigest(context, ...args_1) {
        return { result: pureCircuits.mintDigest(...args_1), context };
      },
      mintFromSolana: async (...args_1) => {
        if (args_1.length !== 6) {
          throw new __compactRuntime.CompactError(`mintFromSolana: expected 6 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const lockNonce_0 = args_1[1];
        const recipient_0 = args_1[2];
        const amount_0 = args_1[3];
        const mintNonce_0 = args_1[4];
        const sig_0 = args_1[5];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('mintFromSolana',
                                     'argument 1 (as invoked from Typescript)',
                                     'bridge.compact line 73 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(typeof(lockNonce_0) === 'bigint' && lockNonce_0 >= 0n && lockNonce_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('mintFromSolana',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'bridge.compact line 73 char 1',
                                     'Uint<0..18446744073709551616>',
                                     lockNonce_0)
        }
        if (!(typeof(recipient_0) === 'object' && typeof(recipient_0.is_left) === 'boolean' && typeof(recipient_0.left) === 'object' && recipient_0.left.bytes.buffer instanceof ArrayBuffer && recipient_0.left.bytes.BYTES_PER_ELEMENT === 1 && recipient_0.left.bytes.length === 32 && typeof(recipient_0.right) === 'object' && recipient_0.right.bytes.buffer instanceof ArrayBuffer && recipient_0.right.bytes.BYTES_PER_ELEMENT === 1 && recipient_0.right.bytes.length === 32)) {
          __compactRuntime.typeError('mintFromSolana',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'bridge.compact line 73 char 1',
                                     'struct Either<is_left: Boolean, left: struct ZswapCoinPublicKey<bytes: Bytes<32>>, right: struct ContractAddress<bytes: Bytes<32>>>',
                                     recipient_0)
        }
        if (!(typeof(amount_0) === 'bigint' && amount_0 >= 0n && amount_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('mintFromSolana',
                                     'argument 3 (argument 4 as invoked from Typescript)',
                                     'bridge.compact line 73 char 1',
                                     'Uint<0..18446744073709551616>',
                                     amount_0)
        }
        if (!(mintNonce_0.buffer instanceof ArrayBuffer && mintNonce_0.BYTES_PER_ELEMENT === 1 && mintNonce_0.length === 32)) {
          __compactRuntime.typeError('mintFromSolana',
                                     'argument 4 (argument 5 as invoked from Typescript)',
                                     'bridge.compact line 73 char 1',
                                     'Bytes<32>',
                                     mintNonce_0)
        }
        if (!(typeof(sig_0) === 'object' && __compactRuntime.isValidCurve25519Point(sig_0.r) && typeof(sig_0.s) === 'bigint' && sig_0.s >= 0 && sig_0.s <= __compactRuntime.MAX_CURVE25519_SCALAR)) {
          __compactRuntime.typeError('mintFromSolana',
                                     'argument 5 (argument 6 as invoked from Typescript)',
                                     'bridge.compact line 73 char 1',
                                     'struct Ed25519Signature<r: Curve25519Point, s: Curve25519Scalar>',
                                     sig_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_2.toValue(lockNonce_0).concat(_descriptor_9.toValue(recipient_0).concat(_descriptor_2.toValue(amount_0).concat(_descriptor_0.toValue(mintNonce_0).concat(_descriptor_12.toValue(sig_0))))),
            alignment: _descriptor_2.alignment().concat(_descriptor_9.alignment().concat(_descriptor_2.alignment().concat(_descriptor_0.alignment().concat(_descriptor_12.alignment()))))
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._mintFromSolana_0(context,
                                                      partialProofData,
                                                      lockNonce_0,
                                                      recipient_0,
                                                      amount_0,
                                                      mintNonce_0,
                                                      sig_0);
        partialProofData.output = { value: _descriptor_6.toValue(result_0), alignment: _descriptor_6.alignment() };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      },
      lockForSolana: async (...args_1) => {
        if (args_1.length !== 3) {
          throw new __compactRuntime.CompactError(`lockForSolana: expected 3 arguments (as invoked from Typescript), received ${args_1.length}`);
        }
        const contextOrig_0 = args_1[0];
        const coin_0 = args_1[1];
        const solanaRecipient_0 = args_1[2];
        if (!(typeof(contextOrig_0) === 'object' && contextOrig_0.callContext.currentQueryContext != undefined)) {
          __compactRuntime.typeError('lockForSolana',
                                     'argument 1 (as invoked from Typescript)',
                                     'bridge.compact line 99 char 1',
                                     'CircuitContext',
                                     contextOrig_0)
        }
        if (!(typeof(coin_0) === 'object' && coin_0.nonce.buffer instanceof ArrayBuffer && coin_0.nonce.BYTES_PER_ELEMENT === 1 && coin_0.nonce.length === 32 && coin_0.color.buffer instanceof ArrayBuffer && coin_0.color.BYTES_PER_ELEMENT === 1 && coin_0.color.length === 32 && typeof(coin_0.value) === 'bigint' && coin_0.value >= 0n && coin_0.value <= 340282366920938463463374607431768211455n)) {
          __compactRuntime.typeError('lockForSolana',
                                     'argument 1 (argument 2 as invoked from Typescript)',
                                     'bridge.compact line 99 char 1',
                                     'struct ShieldedCoinInfo<nonce: Bytes<32>, color: Bytes<32>, value: Uint<0..340282366920938463463374607431768211456>>',
                                     coin_0)
        }
        if (!(solanaRecipient_0.buffer instanceof ArrayBuffer && solanaRecipient_0.BYTES_PER_ELEMENT === 1 && solanaRecipient_0.length === 32)) {
          __compactRuntime.typeError('lockForSolana',
                                     'argument 2 (argument 3 as invoked from Typescript)',
                                     'bridge.compact line 99 char 1',
                                     'Bytes<32>',
                                     solanaRecipient_0)
        }
        const context = __compactRuntime.copyCircuitContext(contextOrig_0);
        const partialProofData = {
          input: {
            value: _descriptor_6.toValue(coin_0).concat(_descriptor_0.toValue(solanaRecipient_0)),
            alignment: _descriptor_6.alignment().concat(_descriptor_0.alignment())
          },
          output: undefined,
          publicTranscript: [],
          privateTranscriptOutputs: []
        };
        const result_0 = await this._lockForSolana_0(context,
                                                     partialProofData,
                                                     coin_0,
                                                     solanaRecipient_0);
        partialProofData.output = { value: _descriptor_2.toValue(result_0), alignment: _descriptor_2.alignment() };
        __compactRuntime.finalizeCallProofData(context, partialProofData);
        return { result: result_0, context: context, gasCost: context.callContext.currentGasCost };
      }
    };
    this.impureCircuits = {
      mintFromSolana: this.circuits.mintFromSolana,
      lockForSolana: this.circuits.lockForSolana
    };
    this.provableCircuits = {
      mintFromSolana: this.circuits.mintFromSolana,
      lockForSolana: this.circuits.lockForSolana
    };
  }
  async initialState(...args_0) {
    if (args_0.length !== 4) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 4 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const constructorContext_0 = args_0[0];
    const operator_0 = args_0[1];
    const mint_0 = args_0[2];
    const network_0 = args_0[3];
    if (typeof(constructorContext_0) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'constructorContext' in argument 1 (as invoked from Typescript) to be an object`);
    }
    if (!('initialZswapLocalState' in constructorContext_0)) {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript)`);
    }
    if (typeof(constructorContext_0.initialZswapLocalState) !== 'object') {
      throw new __compactRuntime.CompactError(`Contract state constructor: expected 'initialZswapLocalState' in argument 1 (as invoked from Typescript) to be an object`);
    }
    if (!(__compactRuntime.isValidCurve25519Point(operator_0))) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 1 (argument 2 as invoked from Typescript)',
                                 'bridge.compact line 37 char 1',
                                 'Curve25519Point',
                                 operator_0)
    }
    if (!(mint_0.buffer instanceof ArrayBuffer && mint_0.BYTES_PER_ELEMENT === 1 && mint_0.length === 32)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 2 (argument 3 as invoked from Typescript)',
                                 'bridge.compact line 37 char 1',
                                 'Bytes<32>',
                                 mint_0)
    }
    if (!(network_0.buffer instanceof ArrayBuffer && network_0.BYTES_PER_ELEMENT === 1 && network_0.length === 32)) {
      __compactRuntime.typeError('Contract state constructor',
                                 'argument 3 (argument 4 as invoked from Typescript)',
                                 'bridge.compact line 37 char 1',
                                 'Bytes<32>',
                                 network_0)
    }
    const state_0 = new __compactRuntime.ContractState();
    let stateValue_0 = __compactRuntime.StateValue.newArray();
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    stateValue_0 = stateValue_0.arrayPush(__compactRuntime.StateValue.newNull());
    state_0.data = new __compactRuntime.ChargedState(stateValue_0);
    state_0.setOperation('mintFromSolana', new __compactRuntime.ContractOperation());
    state_0.setOperation('lockForSolana', new __compactRuntime.ContractOperation());
    const context = __compactRuntime.createCircuitContext({circuitId: 'constructor', contractAddress: __compactRuntime.dummyContractAddress(), coinPublicKeyOrZswapState: constructorContext_0.initialZswapLocalState.coinPublicKey, contractState: state_0.data, privateState: constructorContext_0.initialPrivateState});
    const partialProofData = {
      input: { value: [], alignment: [] },
      output: undefined,
      publicTranscript: [],
      privateTranscriptOutputs: []
    };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_25.toValue(0n),
                                                                                              alignment: _descriptor_25.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_10.toValue(({x: 0n, y: 1n})),
                                                                                              alignment: _descriptor_10.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_25.toValue(1n),
                                                                                              alignment: _descriptor_25.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new Uint8Array(32)),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_25.toValue(2n),
                                                                                              alignment: _descriptor_25.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(new Uint8Array(32)),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_25.toValue(3n),
                                                                                              alignment: _descriptor_25.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_25.toValue(4n),
                                                                                              alignment: _descriptor_25.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newMap(
                                                          new __compactRuntime.StateMap()
                                                        ).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_25.toValue(5n),
                                                                                              alignment: _descriptor_25.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(0n),
                                                                                              alignment: _descriptor_2.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_25.toValue(0n),
                                                                                              alignment: _descriptor_25.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_10.toValue(operator_0),
                                                                                              alignment: _descriptor_10.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_25.toValue(1n),
                                                                                              alignment: _descriptor_25.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(mint_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_25.toValue(2n),
                                                                                              alignment: _descriptor_25.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(network_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } }]);
    state_0.data = new __compactRuntime.ChargedState(context.callContext.currentQueryContext.state.state);
    return {
      currentContractState: state_0,
      currentPrivateState: context.callContext.currentPrivateState,
      currentZswapLocalState: context.callContext.currentZswapLocalState
    }
  }
  _right_0(value_0) {
    return { is_left: false, left: { bytes: new Uint8Array(32) }, right: value_0 };
  }
  _tokenType_0(domain_sep_0, contractAddress_0) {
    return this._persistentCommit_0([domain_sep_0, contractAddress_0.bytes],
                                    new Uint8Array([109, 105, 100, 110, 105, 103, 104, 116, 58, 100, 101, 114, 105, 118, 101, 95, 116, 111, 107, 101, 110, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  }
  async _mintShieldedToken_0(context,
                             partialProofData,
                             domain_sep_0,
                             value_0,
                             nonce_0,
                             recipient_0)
  {
    const coin_0 = { nonce: nonce_0,
                     color:
                       this._tokenType_0(domain_sep_0,
                                         _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                   partialProofData,
                                                                                                   [
                                                                                                    { dup: { n: 2 } },
                                                                                                    { idx: { cached: true,
                                                                                                             pushPath: false,
                                                                                                             path: [
                                                                                                                    { tag: 'value',
                                                                                                                      value: { value: _descriptor_25.toValue(0n),
                                                                                                                               alignment: _descriptor_25.alignment() } }] } },
                                                                                                    { popeq: { cached: true,
                                                                                                               result: undefined } }]).value)),
                     value: value_0 };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { swap: { n: 0 } },
                                       { idx: { cached: true,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_25.toValue(4n),
                                                                  alignment: _descriptor_25.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(domain_sep_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { dup: { n: 1 } },
                                       { dup: { n: 1 } },
                                       'member',
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(value_0),
                                                                                              alignment: _descriptor_2.alignment() }).encode() } },
                                       { swap: { n: 0 } },
                                       'neg',
                                       { branch: { skip: 4 } },
                                       { dup: { n: 2 } },
                                       { dup: { n: 2 } },
                                       { idx: { cached: true,
                                                pushPath: false,
                                                path: [ { tag: 'stack' }] } },
                                       'add',
                                       { ins: { cached: true, n: 2 } },
                                       { swap: { n: 0 } }]);
    this._createZswapOutput_0(context, partialProofData, coin_0, recipient_0);
    const cm_0 = this._coinCommitment_0(coin_0, recipient_0);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { swap: { n: 0 } },
                                       { idx: { cached: true,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_25.toValue(2n),
                                                                  alignment: _descriptor_25.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(cm_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newNull().encode() } },
                                       { ins: { cached: true, n: 2 } },
                                       { swap: { n: 0 } }]);
    if (!recipient_0.is_left
        &&
        this._equal_0(recipient_0.right.bytes,
                      _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                partialProofData,
                                                                                [
                                                                                 { dup: { n: 2 } },
                                                                                 { idx: { cached: true,
                                                                                          pushPath: false,
                                                                                          path: [
                                                                                                 { tag: 'value',
                                                                                                   value: { value: _descriptor_25.toValue(0n),
                                                                                                            alignment: _descriptor_25.alignment() } }] } },
                                                                                 { popeq: { cached: true,
                                                                                            result: undefined } }]).value).bytes))
    {
      __compactRuntime.queryLedgerState(context,
                                        partialProofData,
                                        [
                                         { swap: { n: 0 } },
                                         { idx: { cached: true,
                                                  pushPath: true,
                                                  path: [
                                                         { tag: 'value',
                                                           value: { value: _descriptor_25.toValue(1n),
                                                                    alignment: _descriptor_25.alignment() } }] } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(cm_0),
                                                                                                alignment: _descriptor_0.alignment() }).encode() } },
                                         { push: { storage: false,
                                                   value: __compactRuntime.StateValue.newNull().encode() } },
                                         { ins: { cached: true, n: 2 } },
                                         { swap: { n: 0 } }]);
    }
    return coin_0;
  }
  async _receiveShielded_0(context, partialProofData, coin_0) {
    const recipient_0 = this._right_0(_descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                partialProofData,
                                                                                                [
                                                                                                 { dup: { n: 2 } },
                                                                                                 { idx: { cached: true,
                                                                                                          pushPath: false,
                                                                                                          path: [
                                                                                                                 { tag: 'value',
                                                                                                                   value: { value: _descriptor_25.toValue(0n),
                                                                                                                            alignment: _descriptor_25.alignment() } }] } },
                                                                                                 { popeq: { cached: true,
                                                                                                            result: undefined } }]).value));
    this._createZswapOutput_0(context, partialProofData, coin_0, recipient_0);
    const tmp_0 = this._coinCommitment_0(coin_0, recipient_0);
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { swap: { n: 0 } },
                                       { idx: { cached: true,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_25.toValue(1n),
                                                                  alignment: _descriptor_25.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_0.toValue(tmp_0),
                                                                                              alignment: _descriptor_0.alignment() }).encode() } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newNull().encode() } },
                                       { ins: { cached: true, n: 2 } },
                                       { swap: { n: 0 } }]);
    return [];
  }
  _coinCommitment_0(coin_0, recipient_0) {
    return this._persistentHash_2({ domain_sep:
                                      new Uint8Array([109, 105, 100, 110, 105, 103, 104, 116, 58, 122, 115, 119, 97, 112, 45, 99, 99, 91, 118, 49, 93]),
                                    info: coin_0,
                                    dataType: recipient_0.is_left,
                                    data:
                                      recipient_0.is_left ?
                                      recipient_0.left.bytes :
                                      recipient_0.right.bytes });
  }
  _curve25519BaseIsOdd_0(x_0) {
    const b_0 = Array.from(__compactRuntime.convertBigintToBytes(32,
                                                                 x_0,
                                                                 '<standard library>'),
                           BigInt)[0];
    const b6_0 = b_0 >= 128n ?
                 (__compactRuntime.assert(b_0 >= 128n,
                                          'result of subtraction would be negative'),
                  b_0 - 128n)
                 :
                 b_0;
    const b5_0 = b6_0 >= 64n ?
                 (__compactRuntime.assert(b6_0 >= 64n,
                                          'result of subtraction would be negative'),
                  b6_0 - 64n)
                 :
                 b6_0;
    const b4_0 = b5_0 >= 32n ?
                 (__compactRuntime.assert(b5_0 >= 32n,
                                          'result of subtraction would be negative'),
                  b5_0 - 32n)
                 :
                 b5_0;
    const b3_0 = b4_0 >= 16n ?
                 (__compactRuntime.assert(b4_0 >= 16n,
                                          'result of subtraction would be negative'),
                  b4_0 - 16n)
                 :
                 b4_0;
    const b2_0 = b3_0 >= 8n ?
                 (__compactRuntime.assert(b3_0 >= 8n,
                                          'result of subtraction would be negative'),
                  b3_0 - 8n)
                 :
                 b3_0;
    const b1_0 = b2_0 >= 4n ?
                 (__compactRuntime.assert(b2_0 >= 4n,
                                          'result of subtraction would be negative'),
                  b2_0 - 4n)
                 :
                 b2_0;
    return (b1_0 >= 2n ?
            (__compactRuntime.assert(b1_0 >= 2n,
                                     'result of subtraction would be negative'),
             b1_0 - 2n)
            :
            b1_0)
           ===
           1n;
  }
  _ed25519Encode_0(p_0) {
    const y_0 = Array.from(__compactRuntime.convertBigintToBytes(32,
                                                                 this._curve25519PointY_0(p_0),
                                                                 '<standard library>'),
                           BigInt);
    const sign_0 = this._curve25519BaseIsOdd_0(this._curve25519PointX_0(p_0)) ?
                   128n :
                   0n;
    return Uint8Array.from([y_0[0],
                            y_0[1],
                            y_0[2],
                            y_0[3],
                            y_0[4],
                            y_0[5],
                            y_0[6],
                            y_0[7],
                            y_0[8],
                            y_0[9],
                            y_0[10],
                            y_0[11],
                            y_0[12],
                            y_0[13],
                            y_0[14],
                            y_0[15],
                            y_0[16],
                            y_0[17],
                            y_0[18],
                            y_0[19],
                            y_0[20],
                            y_0[21],
                            y_0[22],
                            y_0[23],
                            y_0[24],
                            y_0[25],
                            y_0[26],
                            y_0[27],
                            y_0[28],
                            y_0[29],
                            y_0[30],
                            ((t1) => {
                              if (t1 > 255n) {
                                throw new __compactRuntime.CompactError('<standard library>: cast from Field or Uint value to smaller Uint value failed: ' + t1 + ' is greater than 255');
                              }
                              return t1;
                            })(y_0[31] + sign_0)],
                           Number);
  }
  _ed25519Verify_0(msg_0, sig_0, pk_0) {
    __compactRuntime.assert(!this._equal_1(__compactRuntime.convertBigintToBytes(32,
                                                                                 this._curve25519PointX_0(pk_0),
                                                                                 '<standard library>'),
                                           new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
                            'Curve25519Point identity is not a permitted ed25519Verify verification key');
    const __compact_pattern_tmp1_0 = sig_0;
    const r_0 = __compact_pattern_tmp1_0.r;
    const s_0 = __compact_pattern_tmp1_0.s;
    const k_0 = __compactRuntime.convertBytesToField(7237005577332262213973186563042994240857116359379907606001950938285454250988n,
                                                     64,
                                                     this._sha512_0([this._ed25519Encode_0(r_0),
                                                                     this._ed25519Encode_0(pk_0),
                                                                     msg_0]),
                                                     'Curve25519Scalar',
                                                     '<standard library>');
    return this._equal_2(this._ecMulGenerator_0(s_0),
                         this._ecAdd_0(r_0, this._ecMul_0(pk_0, k_0)));
  }
  _persistentHash_0(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_17, value_0);
    return result_0;
  }
  _persistentHash_1(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_18, value_0);
    return result_0;
  }
  _persistentHash_2(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_20, value_0);
    return result_0;
  }
  _persistentCommit_0(value_0, rand_0) {
    const result_0 = __compactRuntime.persistentCommit(_descriptor_17,
                                                       value_0,
                                                       rand_0);
    return result_0;
  }
  _createZswapOutput_0(context, partialProofData, coin_0, recipient_0) {
    const result_0 = __compactRuntime.createZswapOutput(context,
                                                        coin_0,
                                                        recipient_0);
    partialProofData.privateTranscriptOutputs.push({
      value: [],
      alignment: []
    });
    return result_0;
  }
  _sha512_0(value_0) {
    const result_0 = __compactRuntime.sha512(_descriptor_15, value_0);
    return result_0;
  }
  _curve25519PointX_0(pt_0) {
    const result_0 = __compactRuntime.curve25519PointX(pt_0);
    return result_0;
  }
  _curve25519PointY_0(pt_0) {
    const result_0 = __compactRuntime.curve25519PointY(pt_0);
    return result_0;
  }
  _ecAdd_0(a_0, b_0) {
    const result_0 = __compactRuntime.curve25519Add(a_0, b_0);
    return result_0;
  }
  _ecMul_0(a_0, b_0) {
    const result_0 = __compactRuntime.curve25519Mul(a_0, b_0);
    return result_0;
  }
  _ecMulGenerator_0(b_0) {
    const result_0 = __compactRuntime.curve25519MulGenerator(b_0);
    return result_0;
  }
  _domainSep_0(mint_0) {
    return this._persistentHash_0([new Uint8Array([101, 102, 102, 101, 99, 116, 115, 116, 114, 101, 97, 109, 58, 98, 114, 105, 100, 103, 101, 58, 115, 111, 108, 58, 118, 49, 0, 0, 0, 0, 0, 0]),
                                   mint_0]);
  }
  _tokenColor_0(mint_0, bridge_0) {
    return this._tokenType_0(this._domainSep_0(mint_0), bridge_0);
  }
  _mintDigest_0(bridge_0, network_0, lockNonce_0, recipient_0, amount_0) {
    return this._persistentHash_1([new Uint8Array([101, 102, 102, 101, 99, 116, 115, 116, 114, 101, 97, 109, 58, 98, 114, 105, 100, 103, 101, 58, 109, 105, 110, 116, 58, 118, 49, 0, 0, 0, 0, 0]),
                                   bridge_0.bytes,
                                   network_0,
                                   lockNonce_0,
                                   recipient_0.is_left,
                                   recipient_0.left.bytes,
                                   recipient_0.right.bytes,
                                   amount_0]);
  }
  async _mintFromSolana_0(context,
                          partialProofData,
                          lockNonce_0,
                          recipient_0,
                          amount_0,
                          mintNonce_0,
                          sig_0)
  {
    const c_0 = Array.from(this._mintDigest_0(_descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                        partialProofData,
                                                                                                        [
                                                                                                         { dup: { n: 2 } },
                                                                                                         { idx: { cached: true,
                                                                                                                  pushPath: false,
                                                                                                                  path: [
                                                                                                                         { tag: 'value',
                                                                                                                           value: { value: _descriptor_25.toValue(0n),
                                                                                                                                    alignment: _descriptor_25.alignment() } }] } },
                                                                                                         { popeq: { cached: true,
                                                                                                                    result: undefined } }]).value),
                                              _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                        partialProofData,
                                                                                                        [
                                                                                                         { dup: { n: 0 } },
                                                                                                         { idx: { cached: false,
                                                                                                                  pushPath: false,
                                                                                                                  path: [
                                                                                                                         { tag: 'value',
                                                                                                                           value: { value: _descriptor_25.toValue(2n),
                                                                                                                                    alignment: _descriptor_25.alignment() } }] } },
                                                                                                         { popeq: { cached: false,
                                                                                                                    result: undefined } }]).value),
                                              lockNonce_0,
                                              recipient_0,
                                              amount_0),
                           BigInt);
    const msg_0 = Uint8Array.from([83n,
                                   77n,
                                   66n,
                                   82n,
                                   68n,
                                   71n,
                                   49n,
                                   58n,
                                   c_0[0],
                                   c_0[1],
                                   c_0[2],
                                   c_0[3],
                                   c_0[4],
                                   c_0[5],
                                   c_0[6],
                                   c_0[7],
                                   c_0[8],
                                   c_0[9],
                                   c_0[10],
                                   c_0[11],
                                   c_0[12],
                                   c_0[13],
                                   c_0[14],
                                   c_0[15],
                                   c_0[16],
                                   c_0[17],
                                   c_0[18],
                                   c_0[19],
                                   c_0[20],
                                   c_0[21],
                                   c_0[22],
                                   c_0[23],
                                   c_0[24],
                                   c_0[25],
                                   c_0[26],
                                   c_0[27],
                                   c_0[28],
                                   c_0[29],
                                   c_0[30],
                                   c_0[31]],
                                  Number);
    __compactRuntime.assert(!this._equal_3(__compactRuntime.convertBigintToBytes(32,
                                                                                 this._curve25519PointX_0(sig_0.r),
                                                                                 'bridge.compact line 89 char 11'),
                                           new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
                            'R is the identity');
    __compactRuntime.assert(this._ed25519Verify_0(msg_0,
                                                  sig_0,
                                                  _descriptor_10.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                             partialProofData,
                                                                                                             [
                                                                                                              { dup: { n: 0 } },
                                                                                                              { idx: { cached: false,
                                                                                                                       pushPath: false,
                                                                                                                       path: [
                                                                                                                              { tag: 'value',
                                                                                                                                value: { value: _descriptor_25.toValue(0n),
                                                                                                                                         alignment: _descriptor_25.alignment() } }] } },
                                                                                                              { popeq: { cached: false,
                                                                                                                         result: undefined } }]).value)),
                            'bad signature');
    const n_0 = lockNonce_0;
    const v_0 = amount_0;
    __compactRuntime.assert(v_0 > 0n, 'zero amount');
    __compactRuntime.assert(!_descriptor_7.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                       partialProofData,
                                                                                       [
                                                                                        { dup: { n: 0 } },
                                                                                        { idx: { cached: false,
                                                                                                 pushPath: false,
                                                                                                 path: [
                                                                                                        { tag: 'value',
                                                                                                          value: { value: _descriptor_25.toValue(3n),
                                                                                                                   alignment: _descriptor_25.alignment() } }] } },
                                                                                        { push: { storage: false,
                                                                                                  value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(n_0),
                                                                                                                                               alignment: _descriptor_2.alignment() }).encode() } },
                                                                                        'member',
                                                                                        { popeq: { cached: true,
                                                                                                   result: undefined } }]).value),
                            'lock already minted');
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_25.toValue(3n),
                                                                  alignment: _descriptor_25.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(n_0),
                                                                                              alignment: _descriptor_2.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(v_0),
                                                                                              alignment: _descriptor_2.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    return await this._mintShieldedToken_0(context,
                                           partialProofData,
                                           this._domainSep_0(_descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                       partialProofData,
                                                                                                                       [
                                                                                                                        { dup: { n: 0 } },
                                                                                                                        { idx: { cached: false,
                                                                                                                                 pushPath: false,
                                                                                                                                 path: [
                                                                                                                                        { tag: 'value',
                                                                                                                                          value: { value: _descriptor_25.toValue(1n),
                                                                                                                                                   alignment: _descriptor_25.alignment() } }] } },
                                                                                                                        { popeq: { cached: false,
                                                                                                                                   result: undefined } }]).value)),
                                           v_0,
                                           mintNonce_0,
                                           recipient_0);
  }
  async _lockForSolana_0(context, partialProofData, coin_0, solanaRecipient_0) {
    const c_0 = coin_0;
    __compactRuntime.assert(this._equal_4(c_0.color,
                                          this._tokenType_0(this._domainSep_0(_descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                                        partialProofData,
                                                                                                                                        [
                                                                                                                                         { dup: { n: 0 } },
                                                                                                                                         { idx: { cached: false,
                                                                                                                                                  pushPath: false,
                                                                                                                                                  path: [
                                                                                                                                                         { tag: 'value',
                                                                                                                                                           value: { value: _descriptor_25.toValue(1n),
                                                                                                                                                                    alignment: _descriptor_25.alignment() } }] } },
                                                                                                                                         { popeq: { cached: false,
                                                                                                                                                    result: undefined } }]).value)),
                                                            _descriptor_1.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                                                      partialProofData,
                                                                                                                      [
                                                                                                                       { dup: { n: 2 } },
                                                                                                                       { idx: { cached: true,
                                                                                                                                pushPath: false,
                                                                                                                                path: [
                                                                                                                                       { tag: 'value',
                                                                                                                                         value: { value: _descriptor_25.toValue(0n),
                                                                                                                                                  alignment: _descriptor_25.alignment() } }] } },
                                                                                                                       { popeq: { cached: true,
                                                                                                                                  result: undefined } }]).value))),
                            'not the bridge colour');
    let t_0;
    __compactRuntime.assert((t_0 = c_0.value, t_0 > 0n), 'zero amount');
    let t_1;
    __compactRuntime.assert((t_1 = c_0.value, t_1 <= 18446744073709551615n),
                            'amount exceeds Uint<64>');
    await this._receiveShielded_0(context, partialProofData, c_0);
    const id_0 = _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                           partialProofData,
                                                                           [
                                                                            { dup: { n: 0 } },
                                                                            { idx: { cached: false,
                                                                                     pushPath: false,
                                                                                     path: [
                                                                                            { tag: 'value',
                                                                                              value: { value: _descriptor_25.toValue(5n),
                                                                                                       alignment: _descriptor_25.alignment() } }] } },
                                                                            { popeq: { cached: true,
                                                                                       result: undefined } }]).value);
    const tmp_0 = { solanaRecipient: solanaRecipient_0,
                    amount:
                      ((t1) => {
                        if (t1 > 18446744073709551615n) {
                          throw new __compactRuntime.CompactError('bridge.compact line 108 char 91: cast from Field or Uint value to smaller Uint value failed: ' + t1 + ' is greater than 18446744073709551615');
                        }
                        return t1;
                      })(c_0.value) };
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_25.toValue(4n),
                                                                  alignment: _descriptor_25.alignment() } }] } },
                                       { push: { storage: false,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(id_0),
                                                                                              alignment: _descriptor_2.alignment() }).encode() } },
                                       { push: { storage: true,
                                                 value: __compactRuntime.StateValue.newCell({ value: _descriptor_3.toValue(tmp_0),
                                                                                              alignment: _descriptor_3.alignment() }).encode() } },
                                       { ins: { cached: false, n: 1 } },
                                       { ins: { cached: true, n: 1 } }]);
    const tmp_1 = 1n;
    __compactRuntime.queryLedgerState(context,
                                      partialProofData,
                                      [
                                       { idx: { cached: false,
                                                pushPath: true,
                                                path: [
                                                       { tag: 'value',
                                                         value: { value: _descriptor_25.toValue(5n),
                                                                  alignment: _descriptor_25.alignment() } }] } },
                                       { addi: { immediate: parseInt(__compactRuntime.valueToBigInt(
                                                              { value: _descriptor_4.toValue(tmp_1),
                                                                alignment: _descriptor_4.alignment() }
                                                                .value
                                                            )) } },
                                       { ins: { cached: true, n: 1 } }]);
    return id_0;
  }
  _equal_0(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_1(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_2(x0, y0) {
    if (x0.x != y0.x || x0.y != y0.y) {
      return false;
    }
    return true;
  }
  _equal_3(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
  _equal_4(x0, y0) {
    if (!x0.every((x, i) => y0[i] === x)) { return false; }
    return true;
  }
}
export function ledger(stateOrChargedState) {
  const state = stateOrChargedState instanceof __compactRuntime.StateValue ? stateOrChargedState : stateOrChargedState.state;
  const chargedState = stateOrChargedState instanceof __compactRuntime.StateValue ? new __compactRuntime.ChargedState(stateOrChargedState) : stateOrChargedState;
  const context = {
    callContext: { currentQueryContext: new __compactRuntime.QueryContext(chargedState, __compactRuntime.dummyContractAddress()), currentGasCost: __compactRuntime.emptyRunningCost() },
    costModel: __compactRuntime.CostModel.initialCostModel()
  };
  const partialProofData = {
    input: { value: [], alignment: [] },
    output: undefined,
    publicTranscript: [],
    privateTranscriptOutputs: []
  };
  return {
    get operatorKey() {
      return _descriptor_10.fromValue(__compactRuntime.queryLedgerState(context,
                                                                        partialProofData,
                                                                        [
                                                                         { dup: { n: 0 } },
                                                                         { idx: { cached: false,
                                                                                  pushPath: false,
                                                                                  path: [
                                                                                         { tag: 'value',
                                                                                           value: { value: _descriptor_25.toValue(0n),
                                                                                                    alignment: _descriptor_25.alignment() } }] } },
                                                                         { popeq: { cached: false,
                                                                                    result: undefined } }]).value);
    },
    get sourceMint() {
      return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_25.toValue(1n),
                                                                                                   alignment: _descriptor_25.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    get networkTag() {
      return _descriptor_0.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_25.toValue(2n),
                                                                                                   alignment: _descriptor_25.alignment() } }] } },
                                                                        { popeq: { cached: false,
                                                                                   result: undefined } }]).value);
    },
    mintedLocks: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_7.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_25.toValue(3n),
                                                                                                     alignment: _descriptor_25.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(0n),
                                                                                                                                 alignment: _descriptor_2.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_25.toValue(3n),
                                                                                                     alignment: _descriptor_25.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(typeof(key_0) === 'bigint' && key_0 >= 0n && key_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'bridge.compact line 32 char 1',
                                     'Uint<0..18446744073709551616>',
                                     key_0)
        }
        return _descriptor_7.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_25.toValue(3n),
                                                                                                     alignment: _descriptor_25.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(key_0),
                                                                                                                                 alignment: _descriptor_2.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(typeof(key_0) === 'bigint' && key_0 >= 0n && key_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'bridge.compact line 32 char 1',
                                     'Uint<0..18446744073709551616>',
                                     key_0)
        }
        return _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_25.toValue(3n),
                                                                                                     alignment: _descriptor_25.alignment() } }] } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_2.toValue(key_0),
                                                                                                     alignment: _descriptor_2.alignment() } }] } },
                                                                          { popeq: { cached: false,
                                                                                     result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[3];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_2.fromValue(key.value),      _descriptor_2.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    withdrawals: {
      isEmpty(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`isEmpty: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_7.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_25.toValue(4n),
                                                                                                     alignment: _descriptor_25.alignment() } }] } },
                                                                          'size',
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(0n),
                                                                                                                                 alignment: _descriptor_2.alignment() }).encode() } },
                                                                          'eq',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      size(...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`size: expected 0 arguments, received ${args_0.length}`);
        }
        return _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_25.toValue(4n),
                                                                                                     alignment: _descriptor_25.alignment() } }] } },
                                                                          'size',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      member(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`member: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(typeof(key_0) === 'bigint' && key_0 >= 0n && key_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('member',
                                     'argument 1',
                                     'bridge.compact line 34 char 1',
                                     'Uint<0..18446744073709551616>',
                                     key_0)
        }
        return _descriptor_7.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_25.toValue(4n),
                                                                                                     alignment: _descriptor_25.alignment() } }] } },
                                                                          { push: { storage: false,
                                                                                    value: __compactRuntime.StateValue.newCell({ value: _descriptor_2.toValue(key_0),
                                                                                                                                 alignment: _descriptor_2.alignment() }).encode() } },
                                                                          'member',
                                                                          { popeq: { cached: true,
                                                                                     result: undefined } }]).value);
      },
      lookup(...args_0) {
        if (args_0.length !== 1) {
          throw new __compactRuntime.CompactError(`lookup: expected 1 argument, received ${args_0.length}`);
        }
        const key_0 = args_0[0];
        if (!(typeof(key_0) === 'bigint' && key_0 >= 0n && key_0 <= 18446744073709551615n)) {
          __compactRuntime.typeError('lookup',
                                     'argument 1',
                                     'bridge.compact line 34 char 1',
                                     'Uint<0..18446744073709551616>',
                                     key_0)
        }
        return _descriptor_3.fromValue(__compactRuntime.queryLedgerState(context,
                                                                         partialProofData,
                                                                         [
                                                                          { dup: { n: 0 } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_25.toValue(4n),
                                                                                                     alignment: _descriptor_25.alignment() } }] } },
                                                                          { idx: { cached: false,
                                                                                   pushPath: false,
                                                                                   path: [
                                                                                          { tag: 'value',
                                                                                            value: { value: _descriptor_2.toValue(key_0),
                                                                                                     alignment: _descriptor_2.alignment() } }] } },
                                                                          { popeq: { cached: false,
                                                                                     result: undefined } }]).value);
      },
      [Symbol.iterator](...args_0) {
        if (args_0.length !== 0) {
          throw new __compactRuntime.CompactError(`iter: expected 0 arguments, received ${args_0.length}`);
        }
        const self_0 = state.asArray()[4];
        return self_0.asMap().keys().map(  (key) => {    const value = self_0.asMap().get(key).asCell();    return [      _descriptor_2.fromValue(key.value),      _descriptor_3.fromValue(value.value)    ];  })[Symbol.iterator]();
      }
    },
    get withdrawalNonce() {
      return _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                       partialProofData,
                                                                       [
                                                                        { dup: { n: 0 } },
                                                                        { idx: { cached: false,
                                                                                 pushPath: false,
                                                                                 path: [
                                                                                        { tag: 'value',
                                                                                          value: { value: _descriptor_25.toValue(5n),
                                                                                                   alignment: _descriptor_25.alignment() } }] } },
                                                                        { popeq: { cached: true,
                                                                                   result: undefined } }]).value);
    }
  };
}
const _emptyContext = {
  callContext: { currentQueryContext: new __compactRuntime.QueryContext(new __compactRuntime.ContractState().data, __compactRuntime.dummyContractAddress()), currentGasCost: __compactRuntime.emptyRunningCost() }
};
const _dummyContract = new Contract({ });
export const pureCircuits = {
  domainSep: (...args_0) => {
    if (args_0.length !== 1) {
      throw new __compactRuntime.CompactError(`domainSep: expected 1 argument (as invoked from Typescript), received ${args_0.length}`);
    }
    const mint_0 = args_0[0];
    if (!(mint_0.buffer instanceof ArrayBuffer && mint_0.BYTES_PER_ELEMENT === 1 && mint_0.length === 32)) {
      __compactRuntime.typeError('domainSep',
                                 'argument 1',
                                 'bridge.compact line 44 char 1',
                                 'Bytes<32>',
                                 mint_0)
    }
    return _dummyContract._domainSep_0(mint_0);
  },
  tokenColor: (...args_0) => {
    if (args_0.length !== 2) {
      throw new __compactRuntime.CompactError(`tokenColor: expected 2 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const mint_0 = args_0[0];
    const bridge_0 = args_0[1];
    if (!(mint_0.buffer instanceof ArrayBuffer && mint_0.BYTES_PER_ELEMENT === 1 && mint_0.length === 32)) {
      __compactRuntime.typeError('tokenColor',
                                 'argument 1',
                                 'bridge.compact line 49 char 1',
                                 'Bytes<32>',
                                 mint_0)
    }
    if (!(typeof(bridge_0) === 'object' && bridge_0.bytes.buffer instanceof ArrayBuffer && bridge_0.bytes.BYTES_PER_ELEMENT === 1 && bridge_0.bytes.length === 32)) {
      __compactRuntime.typeError('tokenColor',
                                 'argument 2',
                                 'bridge.compact line 49 char 1',
                                 'struct ContractAddress<bytes: Bytes<32>>',
                                 bridge_0)
    }
    return _dummyContract._tokenColor_0(mint_0, bridge_0);
  },
  mintDigest: (...args_0) => {
    if (args_0.length !== 5) {
      throw new __compactRuntime.CompactError(`mintDigest: expected 5 arguments (as invoked from Typescript), received ${args_0.length}`);
    }
    const bridge_0 = args_0[0];
    const network_0 = args_0[1];
    const lockNonce_0 = args_0[2];
    const recipient_0 = args_0[3];
    const amount_0 = args_0[4];
    if (!(typeof(bridge_0) === 'object' && bridge_0.bytes.buffer instanceof ArrayBuffer && bridge_0.bytes.BYTES_PER_ELEMENT === 1 && bridge_0.bytes.length === 32)) {
      __compactRuntime.typeError('mintDigest',
                                 'argument 1',
                                 'bridge.compact line 54 char 1',
                                 'struct ContractAddress<bytes: Bytes<32>>',
                                 bridge_0)
    }
    if (!(network_0.buffer instanceof ArrayBuffer && network_0.BYTES_PER_ELEMENT === 1 && network_0.length === 32)) {
      __compactRuntime.typeError('mintDigest',
                                 'argument 2',
                                 'bridge.compact line 54 char 1',
                                 'Bytes<32>',
                                 network_0)
    }
    if (!(typeof(lockNonce_0) === 'bigint' && lockNonce_0 >= 0n && lockNonce_0 <= 18446744073709551615n)) {
      __compactRuntime.typeError('mintDigest',
                                 'argument 3',
                                 'bridge.compact line 54 char 1',
                                 'Uint<0..18446744073709551616>',
                                 lockNonce_0)
    }
    if (!(typeof(recipient_0) === 'object' && typeof(recipient_0.is_left) === 'boolean' && typeof(recipient_0.left) === 'object' && recipient_0.left.bytes.buffer instanceof ArrayBuffer && recipient_0.left.bytes.BYTES_PER_ELEMENT === 1 && recipient_0.left.bytes.length === 32 && typeof(recipient_0.right) === 'object' && recipient_0.right.bytes.buffer instanceof ArrayBuffer && recipient_0.right.bytes.BYTES_PER_ELEMENT === 1 && recipient_0.right.bytes.length === 32)) {
      __compactRuntime.typeError('mintDigest',
                                 'argument 4',
                                 'bridge.compact line 54 char 1',
                                 'struct Either<is_left: Boolean, left: struct ZswapCoinPublicKey<bytes: Bytes<32>>, right: struct ContractAddress<bytes: Bytes<32>>>',
                                 recipient_0)
    }
    if (!(typeof(amount_0) === 'bigint' && amount_0 >= 0n && amount_0 <= 18446744073709551615n)) {
      __compactRuntime.typeError('mintDigest',
                                 'argument 5',
                                 'bridge.compact line 54 char 1',
                                 'Uint<0..18446744073709551616>',
                                 amount_0)
    }
    return _dummyContract._mintDigest_0(bridge_0,
                                        network_0,
                                        lockNonce_0,
                                        recipient_0,
                                        amount_0);
  }
};
export const expectedVk = {
  'lockForSolana': 'b54ed1f6aff46df16f9e3e132c3e4d5e3e7c3d51fd731049f5421f4848e3967f',
  'mintFromSolana': '5f4fa8ace0ea0e47685532f67fcfbd460d826877b877b6dbfbf33bd7dd7e80f9',
};

export const circuitSignatures = {
  'domainSep': {pure: true, provable: false, argumentTypes: [{tag: 'Bytes', length: 32}], resultType: {tag: 'Bytes', length: 32}},
  'tokenColor': {pure: true, provable: false, argumentTypes: [{tag: 'Bytes', length: 32}, {tag: 'Struct', name: 'ContractAddress', elements: [{name: 'bytes', type: {tag: 'Bytes', length: 32}}]}], resultType: {tag: 'Bytes', length: 32}},
  'mintDigest': {pure: true, provable: false, argumentTypes: [{tag: 'Struct', name: 'ContractAddress', elements: [{name: 'bytes', type: {tag: 'Bytes', length: 32}}]}, {tag: 'Bytes', length: 32}, {tag: 'Uint', maxval: '18446744073709551615'}, {tag: 'Struct', name: 'Either', elements: [{name: 'is_left', type: {tag: 'Boolean'}}, {name: 'left', type: {tag: 'Struct', name: 'ZswapCoinPublicKey', elements: [{name: 'bytes', type: {tag: 'Bytes', length: 32}}]}}, {name: 'right', type: {tag: 'Struct', name: 'ContractAddress', elements: [{name: 'bytes', type: {tag: 'Bytes', length: 32}}]}}]}, {tag: 'Uint', maxval: '18446744073709551615'}], resultType: {tag: 'Bytes', length: 32}},
  'mintFromSolana': {pure: false, provable: true, argumentTypes: [{tag: 'Uint', maxval: '18446744073709551615'}, {tag: 'Struct', name: 'Either', elements: [{name: 'is_left', type: {tag: 'Boolean'}}, {name: 'left', type: {tag: 'Struct', name: 'ZswapCoinPublicKey', elements: [{name: 'bytes', type: {tag: 'Bytes', length: 32}}]}}, {name: 'right', type: {tag: 'Struct', name: 'ContractAddress', elements: [{name: 'bytes', type: {tag: 'Bytes', length: 32}}]}}]}, {tag: 'Uint', maxval: '18446744073709551615'}, {tag: 'Bytes', length: 32}, {tag: 'Struct', name: 'Ed25519Signature', elements: [{name: 'r', type: {tag: 'Curve25519Point'}}, {name: 's', type: {tag: 'Curve25519Scalar'}}]}], resultType: {tag: 'Struct', name: 'ShieldedCoinInfo', elements: [{name: 'nonce', type: {tag: 'Bytes', length: 32}}, {name: 'color', type: {tag: 'Bytes', length: 32}}, {name: 'value', type: {tag: 'Uint', maxval: '340282366920938463463374607431768211455'}}]}},
  'lockForSolana': {pure: false, provable: true, argumentTypes: [{tag: 'Struct', name: 'ShieldedCoinInfo', elements: [{name: 'nonce', type: {tag: 'Bytes', length: 32}}, {name: 'color', type: {tag: 'Bytes', length: 32}}, {name: 'value', type: {tag: 'Uint', maxval: '340282366920938463463374607431768211455'}}]}, {tag: 'Bytes', length: 32}], resultType: {tag: 'Uint', maxval: '18446744073709551615'}},
};

export const declaredInterfaces = {};

//# sourceMappingURL=index.js.map
