use std::collections::HashMap;

use thiserror::Error;

use crate::constants::SMT_DEPTH;
use crate::poseidon::{hash2, Field, PoseidonError};

/// Empty SMT leaf — PROTOCOL §2.5 (`test-vectors/smt/empty-subtrees.json`).
pub fn empty_leaf() -> Field {
    Field::from(0u64)
}

#[derive(Debug, Clone)]
pub struct SmtPath {
    pub path_elements: Vec<Field>,
    pub path_indices: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum SmtError {
    #[error("smt path length mismatch")]
    PathLength,
    #[error("invalid path index (must be 0 or 1)")]
    InvalidIndex,
    #[error(transparent)]
    Poseidon(#[from] PoseidonError),
}

/// Path bits from `smtKey` MSB-first — PROTOCOL §2.5.
pub fn path_indices_from_key(key: Field) -> Vec<u8> {
    let s = key.to_string();
    let n = num_bigint::BigUint::parse_bytes(s.as_bytes(), 10).unwrap();
    let mut bits = Vec::with_capacity(SMT_DEPTH);
    for j in 0..SMT_DEPTH {
        let shift = 253 - j;
        let bit = (&n >> shift) & num_bigint::BigUint::from(1u8);
        bits.push(if bit == num_bigint::BigUint::from(0u8) {
            0
        } else {
            1
        });
    }
    bits
}

pub fn smt_key(label: Field, domain_smt_key: Field) -> Result<Field, PoseidonError> {
    crate::poseidon::smt_key_domain(label, domain_smt_key)
}

pub fn leaf_hash(label: Field, domain_smt_leaf: Field) -> Result<Field, PoseidonError> {
    crate::poseidon::leaf_hash_domain(label, domain_smt_leaf)
}

/// Verify inclusion: leaf at path equals `leaf`.
pub fn verify_inclusion(
    key: Field,
    root: Field,
    path: &SmtPath,
    leaf: Field,
) -> Result<bool, SmtError> {
    if path.path_elements.len() != SMT_DEPTH || path.path_indices.len() != SMT_DEPTH {
        return Err(SmtError::PathLength);
    }
    let expected = path_indices_from_key(key);
    for (i, &idx) in path.path_indices.iter().enumerate() {
        if idx != expected[i] {
            return Ok(false);
        }
    }
    let mut current = leaf;
    for i in 0..SMT_DEPTH {
        let idx = path.path_indices[i];
        if idx > 1 {
            return Err(SmtError::InvalidIndex);
        }
        let sibling = path.path_elements[i];
        current = if idx == 0 {
            hash2(current, sibling)?
        } else {
            hash2(sibling, current)?
        };
    }
    Ok(current == root)
}

/// Verify non-inclusion (F-5): Merkle path to `claimed_leaf` at `smtKey` bits, and
/// `claimed_leaf ≠ my_leaf_hash` where `my_leaf_hash = leafHash(label)`.
///
/// Depth stays 32. An occupant at the same 32-bit slot (birthday collision on key
/// prefix) cannot freeze an unrevoked label — only `leafHash(self)` fails.
pub fn verify_non_inclusion(
    key: Field,
    root: Field,
    path: &SmtPath,
    claimed_leaf: Field,
    my_leaf_hash: Field,
) -> Result<bool, SmtError> {
    if path.path_elements.len() != SMT_DEPTH || path.path_indices.len() != SMT_DEPTH {
        return Err(SmtError::PathLength);
    }
    if claimed_leaf == my_leaf_hash {
        return Ok(false);
    }
    let expected = path_indices_from_key(key);
    for (i, &idx) in path.path_indices.iter().enumerate() {
        if idx != expected[i] {
            return Ok(false);
        }
    }
    let mut current = claimed_leaf;
    for i in 0..SMT_DEPTH {
        let idx = path.path_indices[i];
        if idx > 1 {
            return Err(SmtError::InvalidIndex);
        }
        let sibling = path.path_elements[i];
        current = if idx == 0 {
            hash2(current, sibling)?
        } else {
            hash2(sibling, current)?
        };
    }
    Ok(current == root)
}

/// Non-inclusion path against an empty revocation tree (§2.5).
pub fn empty_tree_path_for_key(key: Field, empty_subtrees: &[Field]) -> SmtPath {
    debug_assert!(empty_subtrees.len() >= SMT_DEPTH);
    SmtPath {
        path_elements: empty_subtrees[..SMT_DEPTH].to_vec(),
        path_indices: path_indices_from_key(key),
    }
}

/// Compute root after inserting `label` into empty tree (tests / postman).
pub fn root_after_insert(
    label: Field,
    domain_smt_key: Field,
    domain_smt_leaf: Field,
    empty_subtrees: &[Field],
) -> Result<Field, SmtError> {
    let key = smt_key(label, domain_smt_key)?;
    let leaf = leaf_hash(label, domain_smt_leaf)?;
    let indices = path_indices_from_key(key);
    let mut current = leaf;
    for (level, &bit) in indices.iter().enumerate() {
        let empty_sibling = empty_subtrees[level];
        current = if bit == 0 {
            hash2(current, empty_sibling)?
        } else {
            hash2(empty_sibling, current)?
        };
    }
    Ok(current)
}

fn revoked_path_strings(
    revoked: &[Field],
    domain_key: Field,
) -> Result<Vec<String>, SmtError> {
    revoked
        .iter()
        .map(|&label| {
            let key = smt_key(label, domain_key)?;
            Ok(path_indices_from_key(key)
                .into_iter()
                .map(|b| char::from(b'0' + b))
                .collect::<String>())
        })
        .collect()
}

fn has_revoked_under(prefix: &str, paths: &[String]) -> bool {
    paths.iter().any(|p| p.starts_with(prefix))
}

fn get_node(
    prefix: &str,
    revoked: &[Field],
    paths: &[String],
    domain_leaf: Field,
    empty_subtrees: &[Field],
    cache: &mut HashMap<String, Field>,
) -> Result<Field, SmtError> {
    if let Some(v) = cache.get(prefix) {
        return Ok(*v);
    }

    if !has_revoked_under(prefix, paths) {
        let remaining = SMT_DEPTH.saturating_sub(prefix.len());
        let v = empty_subtrees[remaining];
        cache.insert(prefix.to_string(), v);
        return Ok(v);
    }

    if prefix.len() == SMT_DEPTH {
        for (i, path) in paths.iter().enumerate() {
            if path.as_str() == prefix {
                let lh = leaf_hash(revoked[i], domain_leaf)?;
                cache.insert(prefix.to_string(), lh);
                return Ok(lh);
            }
        }
        let v = empty_leaf();
        cache.insert(prefix.to_string(), v);
        return Ok(v);
    }

    let left = get_node(
        &format!("{prefix}0"),
        revoked,
        paths,
        domain_leaf,
        empty_subtrees,
        cache,
    )?;
    let right = get_node(
        &format!("{prefix}1"),
        revoked,
        paths,
        domain_leaf,
        empty_subtrees,
        cache,
    )?;
    let v = hash2(left, right)?;
    cache.insert(prefix.to_string(), v);
    Ok(v)
}

fn old_sibling_prefix(level: usize, bits: &[u8]) -> String {
    let prefix_len = SMT_DEPTH - level;
    let mut prefix = String::with_capacity(prefix_len);
    for i in 0..(prefix_len - 1) {
        prefix.push(char::from(b'0' + bits[i]));
    }
    prefix.push(char::from(b'0' + (1 - bits[prefix_len - 1])));
    prefix
}

fn path_elements_old_formula(
    bits: &[u8],
    revoked: &[Field],
    paths: &[String],
    domain_leaf: Field,
    empty_subtrees: &[Field],
    cache: &mut HashMap<String, Field>,
) -> Result<Vec<Field>, SmtError> {
    let mut path_elements = Vec::with_capacity(SMT_DEPTH);
    for level in 0..SMT_DEPTH {
        path_elements.push(get_node(
            &old_sibling_prefix(level, bits),
            revoked,
            paths,
            domain_leaf,
            empty_subtrees,
            cache,
        )?);
    }
    Ok(path_elements)
}

fn recompute_root_from_path(
    bits: &[u8],
    path_elements: &[Field],
    empty_leaf: Field,
) -> Result<Field, SmtError> {
    let mut current = empty_leaf;
    for i in 0..SMT_DEPTH {
        let sibling = path_elements[i];
        current = if bits[i] == 0 {
            hash2(current, sibling)?
        } else {
            hash2(sibling, current)?
        };
    }
    Ok(current)
}

/// Fallback when the old sibling prefix is non-empty at the wrong level: one
/// non-empty sibling `get_node(revokedPath[0..SMT_DEPTH-level])` at `level`.
fn path_elements_rpp_fallback(
    bits: &[u8],
    revoked_path: &str,
    root: Field,
    claimed_leaf: Field,
    revoked: &[Field],
    paths: &[String],
    domain_leaf: Field,
    empty_subtrees: &[Field],
    cache: &mut HashMap<String, Field>,
) -> Result<Option<Vec<Field>>, SmtError> {
    for level in (0..SMT_DEPTH).rev() {
        let prefix_len = SMT_DEPTH - level;
        let rp_prefix = &revoked_path[..prefix_len];
        let node = get_node(
            rp_prefix,
            revoked,
            paths,
            domain_leaf,
            empty_subtrees,
            cache,
        )?;
        if node == empty_subtrees[level] {
            continue;
        }
        let mut path_elements = empty_subtrees[..SMT_DEPTH].to_vec();
        path_elements[level] = node;
        if recompute_root_from_path(bits, &path_elements, claimed_leaf)? == root {
            return Ok(Some(path_elements));
        }
    }
    Ok(None)
}

fn path_elements_for_non_inclusion(
    bits: &[u8],
    claimed_leaf: Field,
    root: Field,
    revoked: &[Field],
    paths: &[String],
    domain_leaf: Field,
    empty_subtrees: &[Field],
    cache: &mut HashMap<String, Field>,
) -> Result<Vec<Field>, SmtError> {
    let old = path_elements_old_formula(
        bits,
        revoked,
        paths,
        domain_leaf,
        empty_subtrees,
        cache,
    )?;
    if recompute_root_from_path(bits, &old, claimed_leaf)? == root {
        return Ok(old);
    }
    for revoked_path in paths {
        if let Some(fallback) = path_elements_rpp_fallback(
            bits,
            revoked_path,
            root,
            claimed_leaf,
            revoked,
            paths,
            domain_leaf,
            empty_subtrees,
            cache,
        )? {
            // Fallback historically rebuilt empty-leaf paths; re-check with claimed leaf.
            if recompute_root_from_path(bits, &fallback, claimed_leaf)? == root {
                return Ok(fallback);
            }
        }
    }
    Ok(old)
}

/// True when `label` is a leaf of `revoked_root` under the sparse `get_node` model (§2.5).
pub fn verify_revoked_membership(
    label: Field,
    revoked_root: Field,
    domain_key: Field,
    domain_leaf: Field,
    empty_subtrees: &[Field],
) -> Result<bool, SmtError> {
    let key = smt_key(label, domain_key)?;
    let path_str: String = path_indices_from_key(key)
        .into_iter()
        .map(|b| char::from(b'0' + b))
        .collect();
    let paths = vec![path_str.clone()];
    let mut cache = HashMap::new();
    let root = get_node(
        "",
        &[label],
        &paths,
        domain_leaf,
        empty_subtrees,
        &mut cache,
    )?;
    if root != revoked_root {
        return Ok(false);
    }
    let leaf = leaf_hash(label, domain_leaf)?;
    let at_path = get_node(
        &path_str,
        &[label],
        &paths,
        domain_leaf,
        empty_subtrees,
        &mut cache,
    )?;
    Ok(at_path == leaf)
}

/// Root of revocation tree containing `revoked` labels (empty if `revoked` is empty).
pub fn revoked_tree_root(
    revoked: &[Field],
    domain_key: Field,
    domain_leaf: Field,
    empty_subtrees: &[Field],
) -> Result<Field, SmtError> {
    if revoked.is_empty() {
        return Ok(empty_subtrees[SMT_DEPTH]);
    }
    let paths = revoked_path_strings(revoked, domain_key)?;
    get_node(
        "",
        revoked,
        &paths,
        domain_leaf,
        empty_subtrees,
        &mut HashMap::new(),
    )
}

/// Inclusion witness for a single revoked `label` (merkle path over empty subtrees).
pub fn inclusion_path(
    label: Field,
    revoked: &[Field],
    domain_key: Field,
    domain_leaf: Field,
    empty_subtrees: &[Field],
) -> Result<(Field, SmtPath), SmtError> {
    if revoked.len() != 1 || revoked[0] != label {
        return Err(SmtError::PathLength);
    }
    let key = smt_key(label, domain_key)?;
    let bits = path_indices_from_key(key);
    let root = root_after_insert(label, domain_key, domain_leaf, empty_subtrees)?;
    let path_elements = empty_subtrees[..SMT_DEPTH].to_vec();
    Ok((
        root,
        SmtPath {
            path_elements,
            path_indices: bits,
        },
    ))
}

/// Non-inclusion witness for `target_label` against tree holding `revoked` labels.
/// Returns `(root, path, claimed_leaf)` where `claimed_leaf` is the actual slot value
/// (0 if empty, else `leafHash` of the occupant).
pub fn non_inclusion_path(
    target_label: Field,
    revoked: &[Field],
    domain_key: Field,
    domain_leaf: Field,
    empty_subtrees: &[Field],
) -> Result<(Field, SmtPath, Field), SmtError> {
    if revoked.is_empty() {
        let key = smt_key(target_label, domain_key)?;
        let root = empty_subtrees[SMT_DEPTH];
        let path = empty_tree_path_for_key(key, empty_subtrees);
        return Ok((root, path, empty_leaf()));
    }

    let paths = revoked_path_strings(revoked, domain_key)?;
    let mut cache = HashMap::new();
    let root = get_node(
        "",
        revoked,
        &paths,
        domain_leaf,
        empty_subtrees,
        &mut cache,
    )?;
    let key = smt_key(target_label, domain_key)?;
    let bits = path_indices_from_key(key);
    let path_str: String = bits
        .iter()
        .map(|b| char::from(b'0' + b))
        .collect();
    let claimed_leaf = get_node(
        &path_str,
        revoked,
        &paths,
        domain_leaf,
        empty_subtrees,
        &mut cache,
    )?;
    let path_elements = path_elements_for_non_inclusion(
        &bits,
        claimed_leaf,
        root,
        revoked,
        &paths,
        domain_leaf,
        empty_subtrees,
        &mut cache,
    )?;
    Ok((
        root,
        SmtPath {
            path_elements,
            path_indices: bits,
        },
        claimed_leaf,
    ))
}

pub fn load_domains() -> (Field, Field) {
    crate::domains::load_smt_domains()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poseidon::{build_empty_subtrees, field_from_str};

    fn domains() -> (Field, Field) {
        load_domains()
    }

    fn assert_non_incl(
        label: Field,
        root: Field,
        path: &SmtPath,
        claimed_leaf: Field,
        dk: Field,
        dl: Field,
    ) {
        let key = smt_key(label, dk).unwrap();
        let mine = leaf_hash(label, dl).unwrap();
        assert!(verify_non_inclusion(key, root, path, claimed_leaf, mine).unwrap());
    }

    #[test]
    fn non_inclusion_empty_tree() {
        let (dk, dl) = domains();
        let empty_subtrees = build_empty_subtrees(empty_leaf()).unwrap();
        let label = field_from_str("12345");
        let (root, path, leaf) =
            non_inclusion_path(label, &[], dk, dl, &empty_subtrees).unwrap();
        assert_eq!(root, empty_subtrees[32]);
        assert_eq!(leaf, empty_leaf());
        assert_non_incl(label, root, &path, leaf, dk, dl);
    }

    #[test]
    fn non_inclusion_with_one_revoked() {
        let (dk, dl) = domains();
        let empty_subtrees = build_empty_subtrees(empty_leaf()).unwrap();
        let revoked = field_from_str("99999");
        let other = field_from_str("12345");
        let root = revoked_tree_root(&[revoked], dk, dl, &empty_subtrees).unwrap();
        let (got_root, path, leaf) =
            non_inclusion_path(other, &[revoked], dk, dl, &empty_subtrees).unwrap();
        assert_eq!(got_root, root);
        assert_non_incl(other, root, &path, leaf, dk, dl);

        let (_, bad, bad_leaf) =
            non_inclusion_path(revoked, &[revoked], dk, dl, &empty_subtrees).unwrap();
        let key = smt_key(revoked, dk).unwrap();
        let mine = leaf_hash(revoked, dl).unwrap();
        assert!(!verify_non_inclusion(key, root, &bad, bad_leaf, mine).unwrap());
        assert_eq!(bad_leaf, mine);
    }

    #[test]
    fn non_inclusion_production_vault_labels() {
        let (dk, dl) = domains();
        let empty_subtrees = build_empty_subtrees(empty_leaf()).unwrap();
        let label0 = field_from_str(
            "14380079519688019277031450725831823190333177163580178759091941042751829941656",
        );
        let label1 = field_from_str(
            "10870101253866261104505014083877139144479499553122795132603697440274656639788",
        );
        let label2 = field_from_str(
            "11610282008282369086333223398201435022609899365037741478136847221655055305403",
        );
        let revoked = label1;
        let root = revoked_tree_root(&[revoked], dk, dl, &empty_subtrees).unwrap();

        for other in [label0, label2] {
            let (got_root, path, leaf) =
                non_inclusion_path(other, &[revoked], dk, dl, &empty_subtrees).unwrap();
            assert_eq!(got_root, root);
            assert_non_incl(other, root, &path, leaf, dk, dl);
        }

        let (_, bad, bad_leaf) =
            non_inclusion_path(revoked, &[revoked], dk, dl, &empty_subtrees).unwrap();
        let key = smt_key(revoked, dk).unwrap();
        let mine = leaf_hash(revoked, dl).unwrap();
        assert!(!verify_non_inclusion(key, root, &bad, bad_leaf, mine).unwrap());
    }

    /// F-5: foreign leaf occupying victim's 32-bit slot still allows non-inclusion.
    #[test]
    fn non_inclusion_survives_prefix_collision_occupant() {
        let (dk, dl) = domains();
        let empty_subtrees = build_empty_subtrees(empty_leaf()).unwrap();
        let victim = field_from_str("12345");
        let attacker = field_from_str("99999");
        let victim_key = smt_key(victim, dk).unwrap();
        let victim_bits = path_indices_from_key(victim_key);
        let attacker_leaf = leaf_hash(attacker, dl).unwrap();
        let victim_leaf = leaf_hash(victim, dl).unwrap();
        assert_ne!(attacker_leaf, victim_leaf);

        // Place attacker's leafHash at *victim's* path bits (simulated prefix collision).
        let mut root = attacker_leaf;
        let mut path_elements = Vec::with_capacity(SMT_DEPTH);
        for i in 0..SMT_DEPTH {
            let sibling = empty_subtrees[i];
            path_elements.push(sibling);
            root = if victim_bits[i] == 0 {
                hash2(root, sibling).unwrap()
            } else {
                hash2(sibling, root).unwrap()
            };
        }
        let path = SmtPath {
            path_elements,
            path_indices: victim_bits,
        };

        assert!(
            verify_non_inclusion(victim_key, root, &path, attacker_leaf, victim_leaf).unwrap(),
            "foreign occupant must not freeze unrevoked label"
        );
        assert!(
            !verify_non_inclusion(victim_key, root, &path, victim_leaf, victim_leaf).unwrap(),
            "self leafHash must still fail non-inclusion"
        );
    }

    #[test]
    fn revoked_inclusion_path() {
        let (dk, dl) = domains();
        let empty_subtrees = build_empty_subtrees(empty_leaf()).unwrap();
        let revoked = field_from_str("99999");
        let root = root_after_insert(revoked, dk, dl, &empty_subtrees).unwrap();
        let (_, path) =
            inclusion_path(revoked, &[revoked], dk, dl, &empty_subtrees).unwrap();
        let key = smt_key(revoked, dk).unwrap();
        let lh = leaf_hash(revoked, dl).unwrap();
        assert!(verify_inclusion(key, root, &path, lh).unwrap());
    }

    #[test]
    fn revoked_membership() {
        let (dk, dl) = domains();
        let empty_subtrees = build_empty_subtrees(empty_leaf()).unwrap();
        let revoked = field_from_str("99999");
        let root = revoked_tree_root(&[revoked], dk, dl, &empty_subtrees).unwrap();
        assert!(verify_revoked_membership(revoked, root, dk, dl, &empty_subtrees).unwrap());
        let other = field_from_str("12345");
        assert!(!verify_revoked_membership(other, root, dk, dl, &empty_subtrees).unwrap());
    }
}

