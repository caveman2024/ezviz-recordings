"""Config flow for EZVIZ Recordings."""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote

from pyezvizapi import EzvizAuthVerificationCode, PyEzvizError
import voluptuous as vol

from homeassistant.components.ffmpeg import get_ffmpeg_manager
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_HOST, CONF_NAME, CONF_PASSWORD, CONF_PORT, CONF_USERNAME
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.selector import (
    EntitySelector,
    EntitySelectorConfig,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .cloud import account_key, async_save_token, cloud_login
from .const import (
    CONF_ALARM_ENTITY,
    CONF_CLOUD_PASSWORD,
    CONF_CLOUD_URL,
    CONF_CLOUD_USERNAME,
    CONF_PEOPLE_ONLY,
    CONF_SERIAL,
    CONF_SMS_CODE,
    DEFAULT_RTSP_PORT,
    DEFAULT_USERNAME,
    DOMAIN,
    EU_URL,
    RUSSIA_URL,
)

EZVIZ_DOMAIN = "ezviz"
PASSWORD_SELECTOR = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))
CLOUD_FIELDS = (CONF_CLOUD_USERNAME, CONF_CLOUD_PASSWORD, CONF_CLOUD_URL)


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

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> EzvizRecordingsOptionsFlow:
        return EzvizRecordingsOptionsFlow()

    def __init__(self) -> None:
        self._import: dict[str, Any] = {}

    def _ezviz_cameras(self) -> dict[str, dict[str, Any]]:
        """Cameras known to the official EZVIZ integration, from the device registry (name and local IP only)."""
        devices = dr.async_get(self.hass)
        entities = er.async_get(self.hass)
        found: dict[str, dict[str, Any]] = {}
        for device in devices.devices.values():
            serial = next((ident[1] for ident in device.identifiers if ident[0] == EZVIZ_DOMAIN), None)
            if not serial or device.disabled:
                continue
            host = ""
            for ent in er.async_entries_for_device(entities, device.id):
                if ent.domain == "sensor" and ent.translation_key == "local_ip":
                    state = self.hass.states.get(ent.entity_id)
                    if state and state.state not in ("unknown", "unavailable"):
                        host = state.state
            if not host:
                continue  # not a camera on the local network
            found[str(serial)] = {CONF_NAME: device.name_by_user or device.name or str(serial), CONF_HOST: host}
        return found

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Offer to start from a camera of the EZVIZ integration, or manual setup."""
        if self._ezviz_cameras():
            return self.async_show_menu(step_id="user", menu_options=["pick_ezviz", "manual"])
        return await self.async_step_manual()

    async def async_step_pick_ezviz(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Pick one camera of the EZVIZ integration (only its name, serial and local IP are used)."""
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
        """Name and address are pre-filled; the user enters the verification code."""
        errors: dict[str, str] = {}
        cam = self._import
        if user_input is not None:
            await self.async_set_unique_id(cam[CONF_SERIAL])
            self._abort_if_unique_id_configured()
            data = {**user_input, CONF_SERIAL: cam[CONF_SERIAL]}
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
                    vol.Required(CONF_USERNAME, default=DEFAULT_USERNAME): str,
                    vol.Required(CONF_PASSWORD): PASSWORD_SELECTOR,
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


class EzvizRecordingsOptionsFlow(OptionsFlow):
    """Alarm entity, serial and the EZVIZ cloud account used to read detection events."""

    def __init__(self) -> None:
        self._pending: dict[str, Any] = {}

    def _known_password(self, username: str) -> str | None:
        """Password already stored for this account, in this camera or in another one of this integration."""
        key = account_key(username)
        for entry in (self.config_entry, *self.hass.config_entries.async_entries(DOMAIN)):
            if account_key(entry.options.get(CONF_CLOUD_USERNAME)) == key and entry.options.get(CONF_CLOUD_PASSWORD):
                return str(entry.options[CONF_CLOUD_PASSWORD])
        return None

    async def _async_try_login(self, sms_code: int | None = None) -> tuple[str | None, str | None]:
        """Log in with the pending account; return (error, None) or (None, api_url)."""
        data = self._pending
        try:
            token = await self.hass.async_add_executor_job(
                cloud_login, data[CONF_CLOUD_USERNAME], data[CONF_CLOUD_PASSWORD], data[CONF_CLOUD_URL], sms_code
            )
        except EzvizAuthVerificationCode:
            return "mfa_required", None
        except PyEzvizError:
            return "invalid_auth", None
        except Exception:  # noqa: BLE001 - network errors (requests/urllib3)
            return "cloud_unreachable", None
        await async_save_token(self.hass, data[CONF_CLOUD_USERNAME], token)
        return None, str(token.get("api_url") or data[CONF_CLOUD_URL])

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        options: dict[str, Any] = dict(self.config_entry.options)
        if user_input is not None:
            username = (user_input.get(CONF_CLOUD_USERNAME) or "").strip()
            data = {k: v for k, v in user_input.items() if k not in CLOUD_FIELDS}
            if not username:
                return self.async_create_entry(data=data)  # no cloud account: SD card only, no events
            password = user_input.get(CONF_CLOUD_PASSWORD) or self._known_password(username)
            if not password:
                errors[CONF_CLOUD_PASSWORD] = "password_required"
            else:
                self._pending = {
                    **data,
                    CONF_CLOUD_USERNAME: username,
                    CONF_CLOUD_PASSWORD: password,
                    CONF_CLOUD_URL: (user_input.get(CONF_CLOUD_URL) or EU_URL).strip(),
                }
                error, url = await self._async_try_login()
                if error == "mfa_required":
                    return await self.async_step_cloud_code()
                if error is None:
                    return self.async_create_entry(data={**self._pending, CONF_CLOUD_URL: url})
                errors["base"] = error
            options.update({k: v for k, v in user_input.items() if k != CONF_CLOUD_PASSWORD})
        serial = options.get(CONF_SERIAL) or self.config_entry.data.get(CONF_SERIAL, "")
        schema: dict[Any, Any] = {
            vol.Optional(
                CONF_ALARM_ENTITY,
                description={"suggested_value": options.get(CONF_ALARM_ENTITY)},
            ): EntitySelector(EntitySelectorConfig(domain="alarm_control_panel")),
            vol.Optional(CONF_SERIAL, description={"suggested_value": serial}): str,
            vol.Optional(CONF_PEOPLE_ONLY, default=options.get(CONF_PEOPLE_ONLY, False)): bool,
            vol.Optional(
                CONF_CLOUD_USERNAME, description={"suggested_value": options.get(CONF_CLOUD_USERNAME)}
            ): TextSelector(TextSelectorConfig(type=TextSelectorType.EMAIL, autocomplete="username")),
            vol.Optional(CONF_CLOUD_PASSWORD): PASSWORD_SELECTOR,
            vol.Optional(CONF_CLOUD_URL, default=options.get(CONF_CLOUD_URL) or EU_URL): SelectSelector(
                SelectSelectorConfig(options=[EU_URL, RUSSIA_URL], custom_value=True)
            ),
        }
        return self.async_show_form(step_id="init", data_schema=vol.Schema(schema), errors=errors)

    async def async_step_cloud_code(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """The account asked for a verification code (sent by SMS or e-mail)."""
        errors: dict[str, str] = {}
        if user_input is not None:
            code = str(user_input[CONF_SMS_CODE]).strip()
            if not code.isdigit():
                errors["base"] = "invalid_code"
            else:
                error, url = await self._async_try_login(int(code))
                if error is None:
                    return self.async_create_entry(data={**self._pending, CONF_CLOUD_URL: url})
                errors["base"] = "invalid_code" if error in ("mfa_required", "invalid_auth") else error
        return self.async_show_form(
            step_id="cloud_code",
            data_schema=vol.Schema({vol.Required(CONF_SMS_CODE): str}),
            errors=errors,
        )
