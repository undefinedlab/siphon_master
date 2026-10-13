use crate::commitment::commitment;
use crate::constants::MAX_SPLIT_OUTPUTS;
use crate::poseidon::{hash2, Field, PoseidonError};

/// Depth-3 binary Poseidon tree over eight leaves in order — PROTOCOL §4.4.
pub fn split_root(out_commitments: &[Field]) -> Result<Field, PoseidonError> {
    assert_eq!(out_commitments.len(), MAX_SPLIT_OUTPUTS);
    let mut level = out_commitments.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            next.push(hash2(pair[0], pair[1])?);
        }
        level = next;
    }
    Ok(level[0])
}

/// Build slice commitments with zero-padding rule from §4.4 (D1: shared assetId).
pub fn slice_commitments(
    out_label: Field,
    asset_id: Field,
    values: &[Field],
    nullifiers: &[Field],
    secrets: &[Field],
) -> Result<Vec<Field>, PoseidonError> {
    assert_eq!(values.len(), MAX_SPLIT_OUTPUTS);
    assert_eq!(nullifiers.len(), MAX_SPLIT_OUTPUTS);
    assert_eq!(secrets.len(), MAX_SPLIT_OUTPUTS);
    let mut out = Vec::with_capacity(MAX_SPLIT_OUTPUTS);
    for i in 0..MAX_SPLIT_OUTPUTS {
        if values[i] == Field::from(0u64) {
            out.push(Field::from(0u64));
        } else {
            out.push(commitment(
                values[i],
                out_label,
                asset_id,
                nullifiers[i],
                secrets[i],
            )?);
        }
    }
    Ok(out)
}
