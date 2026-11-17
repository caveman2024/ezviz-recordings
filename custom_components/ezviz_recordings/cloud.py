"""Our own EZVIZ cloud session, used for the detection event list and the event snapshots.

The user enters the EZVIZ account in the options of a camera; cameras with the same account share
one session. The session token is kept in our own storage, so a restart refreshes it instead of
logging in again (accounts with a verification code are asked for it only once, in the options).
Nothing here touches the official EZVIZ integration.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import hashlib
import logging
from typing import Any, TypeVar

from pyezvizapi import EzvizClient

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import CLOUD_TIMEOUT, DOMAIN

_LOGGER = logging.getLogger(__name__)
_T = TypeVar("_T")

DATA_ACCOUNTS = f"{DOMAIN}_cloud_accounts"
TOKEN_STORE_VERSION = 1


def account_key(username: Any) -> str:
    return str(username or "").strip().lower()


def _token_store(hass: HomeAssistant, username: str) -> Store[dict[str, Any]]:
    digest = hashlib.sha256(account_key(username).encode()).hexdigest()[:16]
    return Store(hass, TOKEN_STORE_VERSION, f"{DOMAIN}.cloud.{digest}", private=True)


async def async_save_token(hass: HomeAssistant, username: str, token: dict[str, Any]) -> None:
    await _token_store(hass, username).async_save(dict(token))


def cloud_login(username: str, password: str, url: str, sms_code: int | None = None) -> dict[str, Any]:
    """Log in (executor) and return the session token; its "api_url" is the account's region.

    Raises pyezvizapi's EzvizAuthVerificationCode when the account asks for an SMS/e-mail code,
    PyEzvizError for wrong credentials and HTTPError/requests errors for network problems.
    """
    client = EzvizClient(username, password, url, CLOUD_TIMEOUT)
    try:
        return dict(client.login(sms_code=sms_code))
    finally:
        client.close_session()


class CloudAccount:
    """One EZVIZ account; the session is opened on first use and renewed after an error."""

    def __init__(self, hass: HomeAssistant, username: str, password: str, url: str) -> None:
        self.hass = hass
        self.username = username
        self._password = password
        self._url = url
        self._client: EzvizClient | None = None
        self._lock = asyncio.Lock()
        self._store = _token_store(hass, username)

    def same_login(self, password: str, url: str) -> bool:
        return self._password == password and self._url == url

    async def _async_open(self) -> EzvizClient:
        saved = await self._store.async_load()
        token = saved if saved and saved.get("api_url") else None

        def _open() -> tuple[EzvizClient, dict[str, Any]]:
            client = EzvizClient(self.username, self._password, (token or {}).get("api_url") or self._url, CLOUD_TIMEOUT, token=token)
            return client, dict(client.login())

        client, new_token = await self.hass.async_add_executor_job(_open)
        if new_token != token:
            await self._store.async_save(new_token)
        return client

    async def async_call(self, func: Callable[[EzvizClient], _T]) -> _T:
        """Run func(client) in the executor; on failure renew the session once and retry."""
        for attempt in (1, 2):
            async with self._lock:
                if self._client is None:
                    self._client = await self._async_open()
                client = self._client
            try:
                return await self.hass.async_add_executor_job(func, client)
            except Exception:
                if attempt == 2:
                    raise
                _LOGGER.debug("EZVIZ cloud call failed, renewing the session")
                async with self._lock:
                    if self._client is client:
                        self._client = None
                        await self.hass.async_add_executor_job(client.close_session)
        raise RuntimeError("unreachable")

    async def async_close(self) -> None:
        async with self._lock:
            if self._client is not None:
                await self.hass.async_add_executor_job(self._client.close_session)
                self._client = None


def async_get_account(hass: HomeAssistant, username: str, password: str, url: str) -> CloudAccount:
    """Shared account object for this login (replaced when the password or region changes)."""
    accounts: dict[str, CloudAccount] = hass.data.setdefault(DATA_ACCOUNTS, {})
    key = account_key(username)
    account = accounts.get(key)
    if account is None or not account.same_login(password, url):
        account = accounts[key] = CloudAccount(hass, username.strip(), password, url)
    return account


async def async_release_unused(hass: HomeAssistant, in_use: set[str]) -> None:
    """Close the sessions no loaded camera uses any more."""
    accounts: dict[str, CloudAccount] = hass.data.get(DATA_ACCOUNTS, {})
    for key in [k for k in accounts if k not in in_use]:
        await accounts.pop(key).async_close()
