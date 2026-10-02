from pathlib import Path


def test_production_compose_runs_chain_indexers_in_independent_schemas():
    compose = (Path(__file__).parents[2] / "docker-compose.prod.yml").read_text()

    assert "siphon-indexer-base:" in compose
    assert "siphon-indexer-sepolia:" in compose
    assert "siphon-indexer-sepolia-legacy:" in compose
    assert "INDEXER_SCOPE=base" in compose
    assert "INDEXER_SCOPE=sepolia" in compose
    assert "DATABASE_SCHEMA=feepool2_base_legacy" in compose
    assert "DATABASE_SCHEMA=feepool2_sepolia_current" in compose
    assert "DATABASE_SCHEMA=feepool2_sepolia_legacy" in compose
    assert "INDEXER_DB_URI_BASE=" in compose
    assert "INDEXER_DB_URI_SEPOLIA=" in compose
    assert "INDEXER_URL_BASE=http://siphon-indexer-base:42069" in compose
    assert "INDEXER_URL_SEPOLIA=http://siphon-indexer-sepolia:42069" in compose
    assert "INDEXER_URL=http://siphon-indexer:42069" not in compose
    assert "INDEX_BASE_MIXERS=0" in compose
    assert "INDEX_BASE_BRIDGES=0" in compose
    assert "0x5A41739d8b0Abe8526215E7CDFf91d1dac6Cd71b" in compose
    assert "0x71fF03a0214ac20B8AA55AdA8665F31F7142D437" in compose
    assert "0x2a9C7e0603611062C872FA58083Da4394aa8623a" in compose
    assert "0xE895a7ECbF7Ea9fb856CE685145B1C8fc97bBd28" in compose
    assert "0x9b71269665f38A63C76a99A2966AbC9a25c41741" not in compose
    assert "https://sepolia.drpc.org" not in compose
    assert compose.count('test: [ "CMD", "node", "scripts/indexer-health.mjs" ]') == 3


def test_production_proxy_keeps_current_and_legacy_provers_separate():
    root = Path(__file__).parents[2]
    compose = (root / "docker-compose.prod.yml").read_text()
    caddyfile = (root / "Caddyfile").read_text()

    assert "caddy:" in compose
    assert "./Caddyfile:/etc/caddy/Caddyfile:ro" in compose
    assert "proving-relayer-legacy:5010" in caddyfile
    assert "proving-relayer:5010" in caddyfile
    assert "handle_path /legacy-prove/*" in caddyfile
    assert caddyfile.index("handle_path /legacy-prove/*") < caddyfile.index("handle /prove*")


def test_gateway_image_contains_all_shared_validator_imports_and_pinned_server():
    root = Path(__file__).parents[2]
    compose = (root / "docker-compose.prod.yml").read_text()
    requirements = (root / "api-gateway" / "requirements.txt").read_text()

    assert "./trade-executor/address_validator.py:/app/address_validator.py:ro" in compose
    assert "./trade-executor/asp_membership.py:/app/asp_membership.py:ro" in compose
    assert "gunicorn==23.0.0" in requirements
    assert "redis:" in compose
    assert "REDIS_URL=redis://redis:6379/0" in compose
    assert "API_GATEWAY_REDIS_URL:-memory://" not in compose


def test_prover_image_is_reproducible_and_non_root():
    dockerfile = (
        Path(__file__).parents[2] / "proving-relayer" / "Dockerfile"
    ).read_text()
    requirements = (
        Path(__file__).parents[2] / "proving-relayer" / "requirements.txt"
    ).read_text()

    assert "81eddf1a536d26497b237c0b8a04fe90baf7e439" in dockerfile
    assert "git checkout --detach \"$RAPIDSNARK_COMMIT\"" in dockerfile
    assert "USER siphon-prover" in dockerfile
    assert "gunicorn==23.0.0" in requirements
    assert 'CMD ["gunicorn"' in dockerfile
