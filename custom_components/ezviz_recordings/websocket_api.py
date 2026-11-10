"""Websocket commands used by the recordings panel."""

from __future__ import annotations

import base64
from datetime import date, datetime
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError

from .const import DOMAIN
from .events import async_armed_periods
from .playback import RecordingCamera


def _camera(hass: HomeAssistant, entry_id: str) -> RecordingCamera:
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry is None or entry.domain != DOMAIN or not hasattr(entry, "runtime_data"):
        raise HomeAssistantError("unknown_camera")
    return entry.runtime_data


def _local_time(value: str) -> datetime:
    """Parse the camera-local wall-clock time sent by the panel."""
    try:
        return datetime.fromisoformat(value).replace(tzinfo=None)
    except ValueError as err:
        raise HomeAssistantError("invalid_time") from err


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register the panel commands."""
    websocket_api.async_register_command(hass, ws_cameras)
    websocket_api.async_register_command(hass, ws_play)
    websocket_api.async_register_command(hass, ws_stop)
    websocket_api.async_register_command(hass, ws_thumbnail)
    websocket_api.async_register_command(hass, ws_timeline)
    websocket_api.async_register_command(hass, ws_event_image)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/cameras"})
@callback
def ws_cameras(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """List the configured cameras."""
    cameras = [
        {"entry_id": entry.entry_id, "name": entry.runtime_data.name}
        for entry in hass.config_entries.async_loaded_entries(DOMAIN)
    ]
    cameras.sort(key=lambda cam: cam["name"].casefold())
    connection.send_result(msg["id"], {"cameras": cameras})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/play",
        vol.Required("entry_id"): str,
        vol.Required("start"): str,
        vol.Optional("format", default="hls"): vol.In(["hls", "mp4"]),
    }
)
@websocket_api.async_response
async def ws_play(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Start SD-card playback and return the HLS URL."""
    try:
        camera = _camera(hass, msg["entry_id"])
        start = _local_time(msg["start"])
        if msg["format"] == "mp4":
            token = camera.new_mp4_token(start)
            url = f"/api/{DOMAIN}/mp4/{msg['entry_id']}/{token}"
        else:
            url = await camera.async_play(start)
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "playback_failed", str(err))
        return
    connection.send_result(msg["id"], {"url": url, "format": msg["format"]})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/stop", vol.Required("entry_id"): str}
)
@websocket_api.async_response
async def ws_stop(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Stop playback."""
    try:
        await _camera(hass, msg["entry_id"]).async_stop()
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "stop_failed", str(err))
        return
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/thumbnail",
        vol.Required("entry_id"): str,
        vol.Required("at"): str,
    }
)
@websocket_api.async_response
async def ws_thumbnail(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Return a JPEG frame of the recording at the given time."""
    try:
        image = await _camera(hass, msg["entry_id"]).async_thumbnail(_local_time(msg["at"]))
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "thumbnail_failed", str(err))
        return
    connection.send_result(
        msg["id"], {"content_type": "image/jpeg", "data": base64.b64encode(image).decode()}
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/timeline",
        vol.Required("entry_id"): str,
        vol.Required("day"): str,
    }
)
@websocket_api.async_response
async def ws_timeline(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Detection events and alarm-armed periods of one camera-local day."""
    try:
        camera = _camera(hass, msg["entry_id"])
        day = date.fromisoformat(msg["day"])
    except (HomeAssistantError, ValueError) as err:
        connection.send_error(msg["id"], "timeline_failed", str(err))
        return
    events = await camera.events.async_day(day) if camera.events else []
    armed = await async_armed_periods(hass, camera.alarm_entity, day)
    connection.send_result(
        msg["id"],
        {"day": day.isoformat(), "events": events, "armed": armed, "has_events": camera.events is not None},
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/event_image",
        vol.Required("entry_id"): str,
        vol.Required("event_id"): str,
    }
)
@websocket_api.async_response
async def ws_event_image(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Decrypted snapshot of a detection event."""
    try:
        camera = _camera(hass, msg["entry_id"])
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "image_failed", str(err))
        return
    image = await camera.events.async_image(msg["event_id"]) if camera.events else None
    if image is None:
        connection.send_error(msg["id"], "image_failed", "not_available")
        return
    connection.send_result(msg["id"], {"content_type": "image/jpeg", "data": base64.b64encode(image).decode()})
