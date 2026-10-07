// Night Market's client-proof verifier (AA 00062 task P3.5; questions Q3, option A).
// SPDX-License-Identifier: Apache-2.0
//
// The relay hands a customer's prover ONE k>=18 account call's proof request (interface I-62a: the
// ledger's key-less `/prove` body, `createProvingPayload(preimage, bindingInput)`), and gets a proof
// back. Before the ledger receives that proof (so before any fee proof, balancing, `bind`, offer post
// or submission), `check` decides whether the node will accept it:
//
//   1. the relay's own inputs are read and cross-checked: the proof request (the preimage and the
//      binding input the ledger fixed), the circuit, the PINNED verifier key (the key location's
//      `?vk=` must be its SHA-256) and the circuit's ZKIR;
//   2. the call's public inputs are rebuilt the way the ledger builds them
//      (`ContractCall::public_inputs`, midnight-ledger ledger/src/verify.rs): the binding input, the
//      communications commitment, then the field encoding of the call's public transcript, in which
//      each impact the circuit skipped is a `noop` of that many zeros (ledger/src/prove.rs inserts
//      them from the ZKIR's `check`, exactly as the proof server's `/check` reports them);
//   3. the proof is decoded as the ledger's WASM decodes a proving provider's answer
//      (ledger-wasm/src/tx.rs: a `Proof`, or a `ProofVersioned::V2`), versioned by the verifier key's
//      tag as the ledger does (`verifier-key[v7]` -> `ProofVersioned::V3`, ledger/src/prove.rs), and
//      verified by the ledger's own `ProofKind::proof_verify` with the `proof-verifying` feature ON
//      (the node's code path: `VerifierKey::verify(&PARAMS_VERIFIER, proof, public inputs)`).
//
// Everything is a pure function of its five byte inputs; nothing is fetched, logged or remembered.
// A rejection's reason is a fixed phrase: it never carries the request's bytes, which hold the
// call's private inputs.

use std::sync::Arc;

use base_crypto::hash::HashOutput;
use coin_structure::contract::ContractAddress;
use ledger::structure::{ContractCall, ProofKind, ProofMarker, ProofPreimageVersioned, ProofVersioned};
use ledger::verify::ProofVerificationMode;
use onchain_runtime::state::{ContractOperation, EntryPointBuf};
use serialize::{peek_tag, tagged_deserialize};
use sha2::{Digest, Sha256};
use storage::db::InMemoryDB;
use transient_crypto::curve::Fr;
use transient_crypto::proofs::{Proof, ProofPreimage, ProvingKeyMaterial, VerifierKey};
use wasm_bindgen::prelude::*;
use zkir_v3::{Instruction, IrSource};

/// The four k>=18 account circuits a client proves (I-62a).
pub const CLIENT_PROVEN_CIRCUITS: [&str; 4] = [
    "append_inbox_with_ed25519",
    "open_swap_shielded_with_ed25519",
    "withdraw_shielded_with_ed25519",
    "withdraw_unshielded_with_ed25519",
];

/// What this module is built from (logged by the relay at start).
pub const BUILD_INFO: &str = concat!(
    "nightmarket-client-proof-verifier ",
    env!("CARGO_PKG_VERSION"),
    "; midnight-ledger ledger-9.1.0.0-rc.3 (proof-verifying on); midnight-zkir zkir-3.1.0-rc.1"
);

const VERIFIER_KEY_TAG: &str = "verifier-key[v7]";
const IR_TAG: &str = "ir-source[v3-generic]";

/// Why a proof was not accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// The client's proof: it does not decode, or it does not verify. The requester's failure.
    Proof(&'static str),
    /// The relay's own inputs (the proof request, the circuit, the verifier key, the ZKIR) are
    /// unreadable or do not belong together. Never the requester's failure.
    Input(&'static str),
}

/// The relay's inputs, read and cross-checked: everything except the client's proof.
pub struct Statement {
    /// The call's public inputs, as the ledger computes them.
    pub public_inputs: Vec<Fr>,
    pub verifier_key: VerifierKey,
    pub address: ContractAddress,
    pub communication_commitment: Fr,
    /// The ZKIR's skipped impacts (`Some(n)`), for diagnostics and tests.
    pub skipped_impacts: usize,
}

/// Step 1 and 2: the public inputs the node will check the proof against.
pub fn statement(circuit: &str, proof_request: &[u8], verifier_key: &[u8], ir: &[u8]) -> Result<Statement, Rejection> {
    if !CLIENT_PROVEN_CIRCUITS.contains(&circuit) {
        return Err(Rejection::Input("not a client-proven circuit"));
    }

    // The proof request: what the proof server's `/prove` reads (proof-server endpoints.rs `prove`).
    let (ppi, key_material, binding_input): (ProofPreimageVersioned, Option<ProvingKeyMaterial>, Option<Fr>) =
        tagged_deserialize(proof_request).map_err(|_| Rejection::Input("the proof request does not decode"))?;
    if key_material.is_some() {
        return Err(Rejection::Input("the proof request carries key material"));
    }
    let binding_input = binding_input.ok_or(Rejection::Input("the proof request has no binding input"))?;
    let preimage: Arc<ProofPreimage> = match ppi {
        ProofPreimageVersioned::V2(p) => p,
        #[allow(unreachable_patterns)]
        _ => return Err(Rejection::Input("unsupported proof preimage version")),
    };
    let mut preimage = (*preimage).clone();
    preimage.binding_input = binding_input;

    // The key location names this circuit and this verifier key.
    let address = key_location_address(&preimage.key_location.0, circuit, verifier_key)?;

    // The pinned verifier key.
    let tag = peek_tag(&mut std::io::Cursor::new(verifier_key))
        .map_err(|_| Rejection::Input("the verifier key does not decode"))?;
    if tag != VERIFIER_KEY_TAG {
        return Err(Rejection::Input("unsupported verifier key version"));
    }
    let vk: VerifierKey =
        tagged_deserialize(verifier_key).map_err(|_| Rejection::Input("the verifier key does not decode"))?;
    vk.init().map_err(|_| Rejection::Input("the verifier key does not decode"))?;

    // The circuit's ZKIR, and which of its impacts this call skipped.
    let tag = peek_tag(&mut std::io::Cursor::new(ir)).map_err(|_| Rejection::Input("the ZKIR does not decode"))?;
    if tag != IR_TAG {
        return Err(Rejection::Input("unsupported ZKIR version"));
    }
    let ir: IrSource = tagged_deserialize(ir).map_err(|_| Rejection::Input("the ZKIR does not decode"))?;
    if !ir.do_communications_commitment {
        return Err(Rejection::Input("the ZKIR has no communications commitment"));
    }
    let pi_skips = preimage
        .check(&ir)
        .map_err(|_| Rejection::Input("the proof request does not satisfy the circuit's ZKIR"))?;

    let (communication_commitment, _randomness) = preimage
        .communications_commitment
        .ok_or(Rejection::Input("the proof request has no communications commitment"))?;
    let (public_inputs, skipped_impacts) = ledger_public_inputs(&preimage, &ir, &pi_skips, binding_input, communication_commitment)?;
    Ok(Statement { public_inputs, verifier_key: vk, address, communication_commitment, skipped_impacts })
}

/// `ContractCall::public_inputs(binding_commitment)` (midnight-ledger ledger/src/verify.rs) for the
/// call this preimage proves: `[binding input, communication commitment]`, then each transcript op's
/// field encoding. The preimage's `public_transcript_inputs` is the field encoding of the ops that ran
/// (ledger/src/construct.rs `construct_proof`); the ledger then inserts a `noop { n }` (field encoding:
/// `n` zeros, onchain-vm ops.rs) for every impact the circuit skipped (ledger/src/prove.rs, from
/// `check`'s `pi_skips`, one entry per `impact` instruction in program order, ZKIR being straight-line).
fn ledger_public_inputs(
    preimage: &ProofPreimage,
    ir: &IrSource,
    pi_skips: &[Option<usize>],
    binding_input: Fr,
    communication_commitment: Fr,
) -> Result<(Vec<Fr>, usize), Rejection> {
    let impacts: Vec<usize> = ir
        .instructions
        .iter()
        .filter_map(|i| match i {
            Instruction::Impact { inputs, .. } => Some(inputs.len()),
            _ => None,
        })
        .collect();
    if impacts.len() != pi_skips.len() {
        return Err(Rejection::Input("the ZKIR's impacts do not match its check"));
    }
    let transcript = &preimage.public_transcript_inputs;
    let mut out = Vec::with_capacity(2 + transcript.len() + impacts.iter().sum::<usize>());
    out.push(binding_input);
    out.push(communication_commitment);
    let mut next = 0usize;
    let mut skipped = 0usize;
    for (count, skip) in impacts.iter().zip(pi_skips) {
        match skip {
            None => {
                let end = next + count;
                if end > transcript.len() {
                    return Err(Rejection::Input("the public transcript is shorter than the circuit's impacts"));
                }
                out.extend_from_slice(&transcript[next..end]);
                next = end;
            }
            Some(n) => {
                if n != count {
                    return Err(Rejection::Input("a skipped impact's size does not match the ZKIR"));
                }
                out.extend(std::iter::repeat_n(Fr::from(0u64), *n));
                skipped += 1;
            }
        }
    }
    if next != transcript.len() {
        return Err(Rejection::Input("the public transcript is longer than the circuit's impacts"));
    }
    Ok((out, skipped))
}

/// `contract:<address hex>/<circuit>?vk=<sha256 of the .verifier, hex>` (midnight-js's contract key
/// location): its circuit must be `circuit` and its `?vk=` the SHA-256 of `verifier_key`.
fn key_location_address(location: &str, circuit: &str, verifier_key: &[u8]) -> Result<ContractAddress, Rejection> {
    let bad = Rejection::Input("the proof request's key location is not a contract circuit's");
    let rest = location.strip_prefix("contract:").ok_or(bad)?;
    let (address, rest) = rest.split_once('/').ok_or(bad)?;
    let (named_circuit, vk_hash) = rest.split_once("?vk=").ok_or(bad)?;
    if named_circuit != circuit {
        return Err(Rejection::Input("the proof request is for another circuit"));
    }
    let digest = hex::encode(Sha256::digest(verifier_key));
    if !vk_hash.eq_ignore_ascii_case(&digest) {
        return Err(Rejection::Input("the verifier key is not the one the proof request names"));
    }
    let bytes: [u8; 32] = hex::decode(address).ok().and_then(|b| b.try_into().ok()).ok_or(bad)?;
    Ok(ContractAddress(HashOutput(bytes)))
}

/// The client's proof, decoded as the ledger's WASM decodes a proving provider's answer
/// (ledger-wasm/src/tx.rs): a tagged `Proof`, or a tagged `ProofVersioned::V2` (what the proof server
/// 9.0.0-rc.8 returns). Every byte must be consumed.
pub fn decode_proof(proof: &[u8]) -> Result<Proof, Rejection> {
    tagged_deserialize::<Proof>(proof).or_else(|_| match tagged_deserialize::<ProofVersioned>(proof) {
        Ok(ProofVersioned::V2(p)) => Ok(p),
        _ => Err(Rejection::Proof("the proof does not decode")),
    })
}

/// Step 3: the ledger's own verification of `proof` against the statement (proof-verifying ON).
pub fn verify_against(circuit: &str, statement: Statement, proof: Proof) -> Result<(), Rejection> {
    // The ledger versions the provider's proof by the verifier key's tag: v7 -> V3 (ledger/src/prove.rs).
    let proof = ProofVersioned::V3(proof);
    let op = ContractOperation::new(Some(statement.verifier_key), None);
    // `proof_verify` reads the call only to name it in an error.
    let call: ContractCall<ProofMarker, InMemoryDB> = ContractCall {
        address: statement.address,
        entry_point: EntryPointBuf(circuit.as_bytes().to_vec()),
        guaranteed_transcript: None,
        fallible_transcript: None,
        communication_commitment: statement.communication_commitment,
        proof: proof.clone(),
    };
    <ProofMarker as ProofKind<InMemoryDB>>::proof_verify(
        &op,
        &proof,
        statement.public_inputs,
        &call,
        ProofVerificationMode::Real,
    )
    .map_err(|_| Rejection::Proof("the proof does not verify against the pinned verifier key"))
}

/// The whole check: `Ok(())` when the node will accept `proof` for this call.
pub fn check(circuit: &str, proof_request: &[u8], proof: &[u8], verifier_key: &[u8], ir: &[u8]) -> Result<(), Rejection> {
    let statement = statement(circuit, proof_request, verifier_key, ir)?;
    let proof = decode_proof(proof)?;
    verify_against(circuit, statement, proof)
}

/// JavaScript: `verifyClientProof(circuit, proofRequest, proof, verifierKey, ir)` returns `undefined`
/// when the proof verifies, or the reason it does not (the client's proof: the requester's failure);
/// it THROWS when the relay's own inputs are unreadable or do not belong together.
#[wasm_bindgen(js_name = verifyClientProof)]
pub fn verify_client_proof(
    circuit: &str,
    proof_request: &[u8],
    proof: &[u8],
    verifier_key: &[u8],
    ir: &[u8],
) -> Result<Option<String>, JsError> {
    match check(circuit, proof_request, proof, verifier_key, ir) {
        Ok(()) => Ok(None),
        Err(Rejection::Proof(reason)) => Ok(Some(reason.to_string())),
        Err(Rejection::Input(reason)) => Err(JsError::new(reason)),
    }
}

/// JavaScript: what this module is built from.
#[wasm_bindgen(js_name = verifierBuildInfo)]
pub fn verifier_build_info() -> String {
    BUILD_INFO.to_string()
}

/// JavaScript: parse the embedded verifier parameters now (the first check would otherwise pay it).
#[wasm_bindgen(js_name = warmUp)]
pub fn warm_up() {
    lazy_static::initialize(&transient_crypto::proofs::PARAMS_VERIFIER);
}
