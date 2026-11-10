"""Config flow for EZVIZ Recordings."""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote

import voluptuous as vol

from homeassistant.components.ffmpeg import get_ffmpeg_manager
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_NAME, CONF_PASSWORD, CONF_PORT, CONF_USERNAME
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.selector import (
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .const import CONF_SERIAL, DEFAULT_RTSP_PORT, DEFAULT_USERNAME, DOMAIN

EZVIZ_DOMAIN = "ezviz"
PASSWORD_SELECTOR = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))


async def _can_connect(hass: HomeAssistant, host: str, port: int, username: str, password: str) -> bool:
    """Check that the camera answers RTSP with these credentials (live sub-stream)."""
    url = f"rtsp://{quote(username, safe='')}:{quote(password, safe='')}@{host}:{port}/Streaming/Channels/102"
    process = await asyncio.create_subprocess_exec(
        get_ffmpeg_manager(hass).binary, "-v", "error", "-rtsp_transport", "tcp", "-timeout", "8000000",
        "-i", url, "-t", "0.5", "-f", "null", "-",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        return await asyncio.wait_for(process.wait(), 20) == 0
    except TimeoutError:
        process.kill()
        await process.wait()
        return False


class EzvizRecordingsConfigFlow(ConfigFlow, domain=DOMAIN):
    """Add one camera per config entry."""

    VERSION = 1

    def __init__(self) -> None:
        self._import: dict[str, Any] = {}

    def _ezviz_cameras(self) -> dict[str, dict[str, Any]]:
        """Cameras configured in the official EZVIZ integration, keyed by serial."""
        devices = dr.async_get(self.hass)
        entities = er.async_get(self.hass)
        found: dict[str, dict[str, Any]] = {}
        for entry in self.hass.config_entries.async_entries(EZVIZ_DOMAIN):
            data = entry.data
            if CONF_PASSWORD not in data or CONF_USERNAME not in data:
                continue  # the cloud-account entry, not a camera
            serial = entry.title
            device = devices.async_get_device_by_identifier((EZVIZ_DOMAIN, serial), entry.entry_id)
            name = (device.name_by_user or device.name) if device else serial
            host = ""
            if device:
                for ent in er.async_entries_for_device(entities, device.id):
                    if ent.domain == "sensor" and ent.translation_key == "local_ip":
                        state = self.hass.states.get(ent.entity_id)
                        if state and state.state not in ("unknown", "unavailable"):
                            host = state.state
            found[serial] = {
                CONF_NAME: name,
                CONF_HOST: host,
                CONF_USERNAME: data[CONF_USERNAME],
                CONF_PASSWORD: data[CONF_PASSWORD],
            }
        return found

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Offer to reuse a camera from the EZVIZ integration, or manual setup."""
        if self._ezviz_cameras():
            return self.async_show_menu(step_id="user", menu_options=["pick_ezviz", "manual"])
        return await self.async_step_manual()

    async def async_step_pick_ezviz(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Pick one camera of the EZVIZ integration."""
        cameras = self._ezviz_cameras()
        if user_input is not None:
            self._import = {CONF_SERIAL: user_input[CONF_SERIAL], **cameras[user_input[CONF_SERIAL]]}
            return await self.async_step_confirm()
        options = [
            SelectOptionDict(value=serial, label=f"{cam[CONF_NAME]} ({serial})")
            for serial, cam in cameras.items()
        ]
        return self.async_show_form(
            step_id="pick_ezviz",
            data_schema=vol.Schema(
                {vol.Required(CONF_SERIAL): SelectSelector(SelectSelectorConfig(options=options))}
            ),
        )

    async def async_step_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Confirm name and address; the credentials come from the EZVIZ integration."""
        errors: dict[str, str] = {}
        cam = self._import
        if user_input is not None:
            await self.async_set_unique_id(cam[CONF_SERIAL])
            self._abort_if_unique_id_configured()
            data = {
                CONF_NAME: user_input[CONF_NAME],
                CONF_HOST: user_input[CONF_HOST],
                CONF_PORT: user_input[CONF_PORT],
                CONF_USERNAME: cam[CONF_USERNAME],
                CONF_PASSWORD: cam[CONF_PASSWORD],
                CONF_SERIAL: cam[CONF_SERIAL],
            }
            if await _can_connect(self.hass, data[CONF_HOST], data[CONF_PORT], data[CONF_USERNAME], data[CONF_PASSWORD]):
                return self.async_create_entry(title=data[CONF_NAME], data=data)
            errors["base"] = "cannot_connect"
        return self.async_show_form(
            step_id="confirm",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_NAME, default=cam[CONF_NAME]): str,
                    vol.Required(CONF_HOST, default=cam[CONF_HOST]): str,
                    vol.Required(CONF_PORT, default=DEFAULT_RTSP_PORT): int,
                }
            ),
            description_placeholders={"serial": cam[CONF_SERIAL]},
            errors=errors,
        )

    async def async_step_manual(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Manual setup: address and verification code."""
        errors: dict[str, str] = {}
        if user_input is not None:
            await self.async_set_unique_id(f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}")
            self._abort_if_unique_id_configured()
            if await _can_connect(
                self.hass, user_input[CONF_HOST], user_input[CONF_PORT],
                user_input[CONF_USERNAME], user_input[CONF_PASSWORD],
            ):
                return self.async_create_entry(title=user_input[CONF_NAME], data=user_input)
            errors["base"] = "cannot_connect"
        return self.async_show_form(
            step_id="manual",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_NAME): str,
                    vol.Required(CONF_HOST): str,
                    vol.Required(CONF_PORT, default=DEFAULT_RTSP_PORT): int,
                    vol.Required(CONF_USERNAME, default=DEFAULT_USERNAME): str,
                    vol.Required(CONF_PASSWORD): PASSWORD_SELECTOR,
                }
            ),
            errors=errors,
        )

    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Change address or verification code (e.g. after changing it in the EZVIZ app)."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            password = user_input.get(CONF_PASSWORD) or entry.data[CONF_PASSWORD]
            if await _can_connect(self.hass, user_input[CONF_HOST], user_input[CONF_PORT], user_input[CONF_USERNAME], password):
                return self.async_update_reload_and_abort(
                    entry, data_updates={**user_input, CONF_PASSWORD: password}
                )
            errors["base"] = "cannot_connect"
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_HOST, default=entry.data[CONF_HOST]): str,
                    vol.Required(CONF_PORT, default=entry.data.get(CONF_PORT, DEFAULT_RTSP_PORT)): int,
                    vol.Required(CONF_USERNAME, default=entry.data[CONF_USERNAME]): str,
                    vol.Optional(CONF_PASSWORD): PASSWORD_SELECTOR,
                }
            ),
            errors=errors,
        )
