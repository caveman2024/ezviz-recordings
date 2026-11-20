"""Login refused, back-off and reauthentication of the EZVIZ cloud session.

Run inside a Home Assistant core checkout (its test fixtures), with this integration copied to
tests/testing_config/custom_components/ezviz_recordings.
"""

from __future__ import annotations

from pathlib import Path
import sys
from unittest.mock import MagicMock, patch

from pyezvizapi import EzvizAuthVerificationCode, PyEzvizError
from pyezvizapi.exceptions import InvalidURL
import pytest

from homeassistant.config_entries import SOURCE_REAUTH, ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType

from pytest_homeassistant.common import MockConfigEntry

sys.path.insert(0, str(Path(__file__).parents[2] / "testing_config"))

from custom_components.ezviz_recordings import cloud  # noqa: E402
from custom_components.ezviz_recordings.const import (  # noqa: E402
    CONF_CLOUD_PASSWORD,
    CONF_CLOUD_URL,
    CONF_CLOUD_USERNAME,
    CONF_SMS_CODE,
    DOMAIN,
    EU_URL,
)

USER = "someone@example.com"
TOKEN = {"session_id": "s", "rf_session_id": "r", "api_url": "apiieu.ezvizlife.com"}


@pytest.fixture(autouse=True)
def _custom(enable_custom_integrations: None) -> None:
    """Load the integration from testing_config/custom_components."""


@pytest.fixture(autouse=True)
def _no_setup():
    with patch("custom_components.ezviz_recordings.async_setup", return_value=True), patch(
        "custom_components.ezviz_recordings.async_setup_entry", return_value=True
    ):
        yield


def _entry(hass: HomeAssistant, name: str, loaded: bool = True) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN,
        title=name,
        unique_id=name,
        data={"name": name, "host": "192.0.2.1", "port": 554, "username": "admin", "password": "ABCDEF"},
        options={CONF_CLOUD_USERNAME: USER, CONF_CLOUD_PASSWORD: "old", CONF_CLOUD_URL: EU_URL},
    )
    entry.add_to_hass(hass)
    if loaded:
        entry.mock_state(hass, ConfigEntryState.LOADED)
    return entry


def _client(login_side_effect=None) -> MagicMock:
    client = MagicMock()
    client.login.side_effect = login_side_effect
    client.login.return_value = TOKEN
    return client


def _reauth_flows(hass: HomeAssistant) -> list:
    return hass.config_entries.flow.async_progress_by_handler(DOMAIN, match_context={"source": SOURCE_REAUTH})


@pytest.mark.parametrize(
    "error", [PyEzvizError("Incorrect Password."), EzvizAuthVerificationCode("MFA enabled"), PyEzvizError("The user is locked.")]
)
async def test_login_refused_stops_and_asks_reauth(hass: HomeAssistant, error: Exception) -> None:
    """After a refused login the account never logs in again and every camera of it asks for reauth."""
    _entry(hass, "one")
    _entry(hass, "two")
    client = _client(error)
    account = cloud.CloudAccount(hass, USER, "old", EU_URL)
    with patch.object(cloud, "EzvizClient", return_value=client):
        for _ in range(3):
            with pytest.raises(cloud.CloudAuthError):
                await account.async_call(lambda c: c.get_device_messages_list("X"))
    await hass.async_block_till_done()
    assert client.login.call_count == 1
    assert len(_reauth_flows(hass)) == 2


async def test_refused_relogin_inside_a_call(hass: HomeAssistant) -> None:
    """pyezvizapi logs in again by itself after a 401: a refusal there also stops the account."""
    _entry(hass, "one")
    client = _client()
    client.get_device_messages_list.side_effect = EzvizAuthVerificationCode("MFA enabled")
    account = cloud.CloudAccount(hass, USER, "old", EU_URL)
    with patch.object(cloud, "EzvizClient", return_value=client):
        with pytest.raises(cloud.CloudAuthError):
            await account.async_call(lambda c: c.get_device_messages_list("X"))
        with pytest.raises(cloud.CloudAuthError):
            await account.async_call(lambda c: c.get_device_messages_list("X"))
    await hass.async_block_till_done()
    assert client.get_device_messages_list.call_count == 1
    assert len(_reauth_flows(hass)) == 1


async def test_network_error_backs_off(hass: HomeAssistant) -> None:
    """Network errors pause the calls for a growing time instead of logging in on every poll."""
    _entry(hass, "one")
    client = _client(InvalidURL("no network"))
    account = cloud.CloudAccount(hass, USER, "old", EU_URL)
    now = [1000.0]
    with patch.object(cloud, "EzvizClient", return_value=client), patch.object(cloud.time, "monotonic", lambda: now[0]):
        with pytest.raises(cloud.CloudUnavailable):
            await account.async_call(lambda c: 1)
        now[0] += 29
        with pytest.raises(cloud.CloudUnavailable):
            await account.async_call(lambda c: 1)
        assert client.login.call_count == 1
        now[0] += 2  # first pause (30 s) over
        with pytest.raises(cloud.CloudUnavailable):
            await account.async_call(lambda c: 1)
        assert client.login.call_count == 2
        now[0] += 31  # second pause is 60 s
        with pytest.raises(cloud.CloudUnavailable):
            await account.async_call(lambda c: 1)
        assert client.login.call_count == 2
        now[0] += 30
        client.login.side_effect = None
        assert await account.async_call(lambda c: 42) == 42
        assert await account.async_call(lambda c: 43) == 43
    assert client.login.call_count == 3
    assert not _reauth_flows(hass)


async def test_api_error_renews_once_then_backs_off(hass: HomeAssistant) -> None:
    """A failing API call renews the session once; a second failure pauses the calls."""
    _entry(hass, "one")
    client = _client()
    client.get_device_messages_list.side_effect = PyEzvizError("Can't gather proper data")
    account = cloud.CloudAccount(hass, USER, "old", EU_URL)
    with patch.object(cloud, "EzvizClient", return_value=client):
        with pytest.raises(PyEzvizError):
            await account.async_call(lambda c: c.get_device_messages_list("X"))
        with pytest.raises(cloud.CloudUnavailable):
            await account.async_call(lambda c: c.get_device_messages_list("X"))
    assert client.login.call_count == 2
    assert client.get_device_messages_list.call_count == 2


async def test_reauth_updates_every_camera_of_the_account(hass: HomeAssistant) -> None:
    """The new password goes to all cameras of the account and their reauth requests close."""
    one = _entry(hass, "one", loaded=False)
    two = _entry(hass, "two", loaded=False)
    other = MockConfigEntry(domain=DOMAIN, unique_id="other", options={CONF_CLOUD_USERNAME: "other@example.com", CONF_CLOUD_PASSWORD: "x"})
    other.add_to_hass(hass)
    await two.start_reauth_flow(hass)
    result = await one.start_reauth_flow(hass)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "reauth_confirm"
    with patch("custom_components.ezviz_recordings.config_flow.cloud_login", return_value=TOKEN) as login:
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_CLOUD_PASSWORD: "new"})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    login.assert_called_once_with(USER, "new", EU_URL, None)
    assert one.options[CONF_CLOUD_PASSWORD] == "new"
    assert two.options[CONF_CLOUD_PASSWORD] == "new"
    assert other.options[CONF_CLOUD_PASSWORD] == "x"
    assert not _reauth_flows(hass)


async def test_reauth_with_verification_code(hass: HomeAssistant) -> None:
    """When EZVIZ asks for a code, the reauth asks for it and logs in with it."""
    one = _entry(hass, "one", loaded=False)
    result = await one.start_reauth_flow(hass)
    with patch(
        "custom_components.ezviz_recordings.config_flow.cloud_login",
        side_effect=[EzvizAuthVerificationCode("MFA"), PyEzvizError("The MFA code is invalid, please try again."), TOKEN],
    ) as login:
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_CLOUD_PASSWORD: "new"})
        assert result["type"] is FlowResultType.FORM
        assert result["step_id"] == "reauth_code"
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_SMS_CODE: "111111"})
        assert result["errors"] == {"base": "invalid_code"}
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_SMS_CODE: "123456"})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert login.call_args.args == (USER, "new", EU_URL, 123456)
    assert one.options[CONF_CLOUD_PASSWORD] == "new"


@pytest.mark.parametrize(
    ("error", "key"), [(PyEzvizError("Incorrect Password."), "invalid_auth"), (InvalidURL("no network"), "cloud_unreachable")]
)
async def test_reauth_errors(hass: HomeAssistant, error: Exception, key: str) -> None:
    one = _entry(hass, "one", loaded=False)
    result = await one.start_reauth_flow(hass)
    with patch("custom_components.ezviz_recordings.config_flow.cloud_login", side_effect=error):
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_CLOUD_PASSWORD: "new"})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": key}
    assert one.options[CONF_CLOUD_PASSWORD] == "old"
