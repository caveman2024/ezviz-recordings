"""EZVIZ Recordings: browse EZVIZ SD-card recordings from a Home Assistant panel."""

from __future__ import annotations

import hashlib
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform, CONF_HOST, CONF_NAME, CONF_PASSWORD, CONF_PORT, CONF_USERNAME
from homeassistant.core import HomeAssistant
import homeassistant.helpers.config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_ALARM_ENTITY,
    CONF_SERIAL,
    VERSION,
    DEFAULT_RTSP_PORT,
    DOMAIN,
    PANEL_COMPONENT,
    PANEL_ICON,
    PANEL_URL_PATH,
    STATIC_URL,
)

from .events import EventSource
from .playback import RecordingCamera
from .http_views import EventImageView, RecordingMp4View
from .poller import DetectionPoller
from .websocket_api import async_register_websocket_commands

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
PLATFORMS = [Platform.BINARY_SENSOR, Platform.EVENT]

type RecordingsConfigEntry = ConfigEntry[RecordingCamera]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the static files and the websocket API once."""
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "frontend"), cache_headers=False)]
    )
    async_register_websocket_commands(hass)
    hass.http.register_view(RecordingMp4View(hass))
    hass.http.register_view(EventImageView(hass))
    return True


async def async_setup_entry(hass: HomeAssistant, entry: RecordingsConfigEntry) -> bool:
    """Set up one camera."""
    entry.runtime_data = RecordingCamera(
        hass=hass,
        name=entry.data.get(CONF_NAME) or entry.title,
        host=entry.data[CONF_HOST],
        username=entry.data[CONF_USERNAME],
        password=entry.data[CONF_PASSWORD],
        port=entry.data.get(CONF_PORT, DEFAULT_RTSP_PORT),
        alarm_entity=entry.options.get(CONF_ALARM_ENTITY) or None,
    )
    serial = entry.options.get(CONF_SERIAL) or entry.data.get(CONF_SERIAL)
    if serial:
        entry.runtime_data.events = EventSource(hass, serial, entry.data[CONF_PASSWORD])
    await _async_register_panel(hass)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    if DOMAIN not in hass.data:
        hass.data[DOMAIN] = DetectionPoller(hass)
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


def _panel_fingerprint() -> str:
    data = (Path(__file__).parent / "frontend" / "ezviz-recordings-panel.js").read_bytes()
    return hashlib.sha256(data).hexdigest()[:12]


async def _async_register_panel(hass: HomeAssistant) -> None:
    """(Re)register the sidebar panel; the URL changes with the file so browsers never keep a stale copy."""
    fingerprint = await hass.async_add_executor_job(_panel_fingerprint)
    frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_COMPONENT,
        sidebar_title="EZVIZ",
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL}/ezviz-recordings-panel.js?v={VERSION}-{fingerprint}",
        require_admin=False,
        config={},
    )


async def _async_reload(hass: HomeAssistant, entry: RecordingsConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: RecordingsConfigEntry) -> bool:
    """Stop playback and remove the panel when the last camera goes away."""
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    await entry.runtime_data.async_stop()
    others = [
        e for e in hass.config_entries.async_loaded_entries(DOMAIN) if e.entry_id != entry.entry_id
    ]
    if not others:
        frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
        if (poller := hass.data.pop(DOMAIN, None)) is not None:
            poller.async_stop()
    return True
