// Native tests of the client-proof verifier over the AA 00062 P1.2 golden vectors
// (relay/test/fixtures/client-proof/: real requests and proofs the node accepted, plus fresh
// re-proofs). `cargo test --release` from relay/verifier; the relay's own tests check the built WASM.

use std::path::PathBuf;
use std::time::Instant;

use nightmarket_client_proof_verifier::{Rejection, check, decode_proof, statement, verify_against};

const OPEN_SWAP: &str = "open_swap_shielded_with_ed25519";
const WITHDRAW: &str = "withdraw_shielded_with_ed25519";

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/client-proof").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

struct Vector {
    circuit: &'static str,
    request: &'static str,
    proofs: [&'static str; 2],
}

const VECTORS: [Vector; 3] = [
    Vector {
        circuit: OPEN_SWAP,
        request: "open_swap_shielded_with_ed25519.maker.request.bin",
        proofs: ["open_swap_shielded_with_ed25519.maker.proof.bin", "open_swap_shielded_with_ed25519.maker.reproof.bin"],
    },
    Vector {
        circuit: OPEN_SWAP,
        request: "open_swap_shielded_with_ed25519.taker.request.bin",
        proofs: ["open_swap_shielded_with_ed25519.taker.proof.bin", "open_swap_shielded_with_ed25519.taker.reproof.bin"],
    },
    Vector {
        circuit: WITHDRAW,
        request: "withdraw_shielded_with_ed25519.request.bin",
        proofs: ["withdraw_shielded_with_ed25519.proof.bin", "withdraw_shielded_with_ed25519.reproof.bin"],
    },
];

fn keys(circuit: &str) -> (Vec<u8>, Vec<u8>) {
    (fixture(&format!("{circuit}.verifier")), fixture(&format!("{circuit}.bzkir")))
}

#[test]
fn golden_proofs_verify() {
    for v in &VECTORS {
        let (vk, ir) = keys(v.circuit);
        let request = fixture(v.request);
        let st = statement(v.circuit, &request, &vk, &ir).expect("statement");
        println!("{}: {} public inputs, {} skipped impacts", v.request, st.public_inputs.len(), st.skipped_impacts);
        for p in v.proofs {
            let proof = fixture(p);
            let t = Instant::now();
            let r = check(v.circuit, &request, &proof, &vk, &ir);
            println!("{p}: {:?} in {:?}", r, t.elapsed());
            assert_eq!(r, Ok(()), "{p}");
        }
    }
}

#[test]
fn a_flipped_byte_fails() {
    let (vk, ir) = keys(OPEN_SWAP);
    let request = fixture(VECTORS[0].request);
    let proof = fixture(VECTORS[0].proofs[0]);
    // Every 97th byte, the tag included, and the last byte.
    let mut positions: Vec<usize> = (0..proof.len()).step_by(97).collect();
    positions.push(proof.len() - 1);
    for i in positions {
        let mut bad = proof.clone();
        bad[i] ^= 0x01;
        match check(OPEN_SWAP, &request, &bad, &vk, &ir) {
            Err(Rejection::Proof(_)) => {}
            other => panic!("byte {i}: {other:?}"),
        }
    }
}

#[test]
fn a_truncated_or_extended_proof_fails() {
    let (vk, ir) = keys(OPEN_SWAP);
    let request = fixture(VECTORS[0].request);
    let proof = fixture(VECTORS[0].proofs[0]);
    let mut longer = proof.clone();
    longer.push(0);
    for bad in [&proof[..proof.len() - 1], &longer[..], &[][..]] {
        assert_eq!(check(OPEN_SWAP, &request, bad, &vk, &ir), Err(Rejection::Proof("the proof does not decode")));
    }
}

#[test]
fn another_circuits_proof_fails() {
    // The page returns a valid proof of ANOTHER circuit (an open_swap proof for a withdrawal's hand-off).
    let (vk, ir) = keys(WITHDRAW);
    let request = fixture(VECTORS[2].request);
    let proof = fixture(VECTORS[0].proofs[0]);
    assert_eq!(
        check(WITHDRAW, &request, &proof, &vk, &ir),
        Err(Rejection::Proof("the proof does not verify against the pinned verifier key"))
    );
}

#[test]
fn the_wrong_verifier_key_fails() {
    // The cryptographic check itself: the right statement, another circuit's verifier key.
    let (vk, ir) = keys(OPEN_SWAP);
    let request = fixture(VECTORS[0].request);
    let mut st = statement(OPEN_SWAP, &request, &vk, &ir).expect("statement");
    let (other_vk, other_ir) = keys(WITHDRAW);
    let other = statement(WITHDRAW, &fixture(VECTORS[2].request), &other_vk, &other_ir).expect("statement");
    st.verifier_key = other.verifier_key;
    let proof = decode_proof(&fixture(VECTORS[0].proofs[0])).expect("decode");
    assert_eq!(
        verify_against(OPEN_SWAP, st, proof),
        Err(Rejection::Proof("the proof does not verify against the pinned verifier key"))
    );
    // And as the relay would call it: the key location's `?vk=` names another key.
    assert_eq!(
        check(OPEN_SWAP, &request, &fixture(VECTORS[0].proofs[0]), &other_vk, &ir),
        Err(Rejection::Input("the verifier key is not the one the proof request names"))
    );
}

#[test]
fn a_public_input_mismatch_fails() {
    let (vk, ir) = keys(OPEN_SWAP);
    // The taker's (valid) proof against the maker's request: same circuit, another statement.
    assert_eq!(
        check(OPEN_SWAP, &fixture(VECTORS[0].request), &fixture(VECTORS[1].proofs[0]), &vk, &ir),
        Err(Rejection::Proof("the proof does not verify against the pinned verifier key"))
    );
    // One public input changed (the binding input, the commitment, and a transcript entry).
    let request = fixture(VECTORS[0].request);
    let proof = fixture(VECTORS[0].proofs[0]);
    let n = statement(OPEN_SWAP, &request, &vk, &ir).unwrap().public_inputs.len();
    for i in [0, 1, 2, n / 2, n - 1] {
        let mut st = statement(OPEN_SWAP, &request, &vk, &ir).unwrap();
        st.public_inputs[i] = st.public_inputs[i] + transient_crypto::curve::Fr::from(1u64);
        assert_eq!(
            verify_against(OPEN_SWAP, st, decode_proof(&proof).unwrap()),
            Err(Rejection::Proof("the proof does not verify against the pinned verifier key")),
            "public input {i}"
        );
    }
    // A changed binding input in the request (the ledger's TAIL: `01` + 32 bytes).
    let mut bad = request.clone();
    let last = bad.len() - 1;
    bad[last] ^= 0x01;
    match check(OPEN_SWAP, &bad, &proof, &vk, &ir) {
        Err(Rejection::Proof(_)) | Err(Rejection::Input(_)) => {}
        other => panic!("{other:?}"),
    }
}

#[test]
fn inconsistent_relay_inputs_are_input_errors() {
    let (vk, ir) = keys(OPEN_SWAP);
    let request = fixture(VECTORS[0].request);
    let proof = fixture(VECTORS[0].proofs[0]);
    assert_eq!(
        check(WITHDRAW, &request, &proof, &vk, &ir),
        Err(Rejection::Input("the proof request is for another circuit"))
    );
    assert_eq!(
        check("verify_device_with_ed25519", &request, &proof, &vk, &ir),
        Err(Rejection::Input("not a client-proven circuit"))
    );
    let (_, withdraw_ir) = keys(WITHDRAW);
    assert!(matches!(check(OPEN_SWAP, &request, &proof, &vk, &withdraw_ir), Err(Rejection::Input(_))));
    assert_eq!(
        check(OPEN_SWAP, &request[..request.len() - 1], &proof, &vk, &ir),
        Err(Rejection::Input("the proof request does not decode"))
    );
    assert_eq!(check(OPEN_SWAP, &request, &proof, &vk[..vk.len() - 1], &ir).is_err(), true);
}

#[test]
fn the_ledger_public_inputs_need_the_zkir() {
    // Why the verifier reads the circuit's ZKIR (AA 00062 questions Q8): the golden calls SKIP some of
    // the circuit's guarded impacts, which the ledger's transcript carries as `noop` zeros. Public
    // inputs built from the proof request alone ([binding input, commitment] ++ the transcript that
    // ran) do not verify.
    use ledger::structure::ProofPreimageVersioned;
    use serialize::tagged_deserialize;
    use transient_crypto::curve::Fr;
    use transient_crypto::proofs::ProvingKeyMaterial;
    for v in [&VECTORS[0], &VECTORS[2]] {
        let (vk, ir) = keys(v.circuit);
        let request = fixture(v.request);
        let mut st = statement(v.circuit, &request, &vk, &ir).unwrap();
        assert!(st.skipped_impacts > 0, "{}", v.request);
        let (ppi, _, binding): (ProofPreimageVersioned, Option<ProvingKeyMaterial>, Option<Fr>) =
            tagged_deserialize(&request[..]).unwrap();
        let ProofPreimageVersioned::V2(p) = ppi else { unreachable!() };
        let mut naive = vec![binding.unwrap(), p.communications_commitment.unwrap().0];
        naive.extend(p.public_transcript_inputs.iter().copied());
        assert_ne!(naive.len(), st.public_inputs.len());
        st.public_inputs = naive;
        assert_eq!(
            verify_against(v.circuit, st, decode_proof(&fixture(v.proofs[0])).unwrap()),
            Err(Rejection::Proof("the proof does not verify against the pinned verifier key"))
        );
    }
}
