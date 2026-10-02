"""Downstream client providers — FastAPI dependencies so handlers get typed adapters and tests can
override them with httpx.MockTransport. One client instance per process (httpx.Client pools)."""
from functools import lru_cache

from app.adapters.executor import ExecutorClient
from app.adapters.indexer import IndexerClient
from app.adapters.relayer import RelayerClient
from app.adapters.sanctions import SanctionsClient
from app.config import get_settings


@lru_cache
def _executor() -> ExecutorClient:
    s = get_settings()
    return ExecutorClient(base_url=s.executor_url, api_token=s.executor_api_token)


@lru_cache
def _relayer() -> RelayerClient:
    s = get_settings()
    return RelayerClient(base_url=s.relayer_url, api_token=s.executor_api_token)


@lru_cache
def _indexer() -> IndexerClient:
    s = get_settings()
    return IndexerClient(
        base_urls={8453: s.indexer_url_base, 11155111: s.indexer_url_sepolia}
    )


@lru_cache
def _sanctions() -> SanctionsClient:
    return SanctionsClient()


def get_executor_client() -> ExecutorClient:
    return _executor()


def get_relayer_client() -> RelayerClient:
    return _relayer()


def get_indexer_client() -> IndexerClient:
    return _indexer()


def get_sanctions_client() -> SanctionsClient:
    return _sanctions()
