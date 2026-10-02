"""Decryptor user ids: EVM folds case; Solana base58 must not."""
from decryptor_client import _norm_user


def test_evm_user_id_is_lowercased():
    assert _norm_user("0xAbCdEf0123456789") == "0xabcdef0123456789"


def test_solana_user_id_keeps_base58_case():
    pk = "C5kc6MhYMegqmypdVttRJ9JAj7JRfVMPg5jsFoHVg1JG"
    assert _norm_user(pk) == pk
    assert _norm_user(pk) != pk.lower()
