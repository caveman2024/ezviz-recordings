"""Services that save a detection to files, for example to copy it off-site.

* ``save_event_image``: the snapshot the camera took for a detection (as soon as the cloud has it).
* ``save_clip``: a piece of the SD-card recording. It waits until the requested end has been
  recorded, then copies it at real-time speed (the camera does not fast forward), so a 40 s clip
  is ready about 45 s after its end.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
import logging
import os
from pathlib import Path

import voluptuous as vol

from homeassistant.components.ffmpeg import get_ffmpeg_manager
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
import homeassistant.helpers.config_validation as cv
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .playback import RecordingCamera, camera_time

_LOGGER = logging.getLogger(__name__)

ATTR_CAMERA = "camera"
ATTR_ENTRY_ID = "entry_id"
ATTR_EVENT_ID = "event_id"
ATTR_START = "start"
ATTR_DURATION = "duration"
ATTR_FILENAME = "filename"

SERVICE_SAVE_CLIP = "save_clip"
SERVICE_SAVE_EVENT_IMAGE = "save_event_image"

MAX_DURATION = 600
RECORDED_MARGIN = 5  # seconds the camera needs to have written the end of the clip
COPY_MARGIN = 90  # extra time allowed for the copy besides the clip itself

_TARGET = {
    vol.Exclusive(ATTR_ENTRY_ID, "camera"): cv.string,
    vol.Exclusive(ATTR_CAMERA, "camera"): cv.string,
}

SAVE_CLIP_SCHEMA = vol.Schema(
    {
        **_TARGET,
        vol.Required(ATTR_START): cv.string,
        vol.Optional(ATTR_DURATION, default=40): vol.All(vol.Coerce(int), vol.Range(min=1, max=MAX_DURATION)),
        vol.Required(ATTR_FILENAME): cv.string,
    }
)

SAVE_EVENT_IMAGE_SCHEMA = vol.Schema(
    {
        **_TARGET,
        vol.Required(ATTR_EVENT_ID): cv.string,
        vol.Required(ATTR_FILENAME): cv.string,
    }
)


def _camera(hass: HomeAssistant, call: ServiceCall) -> RecordingCamera:
    """The camera named in the call, by config entry id or by name."""
    entries = [
        e for e in hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED
    ]
    if entry_id := call.data.get(ATTR_ENTRY_ID):
        found = [e for e in entries if e.entry_id == entry_id]
    elif name := call.data.get(ATTR_CAMERA):
        found = [e for e in entries if e.runtime_data.name.casefold() == name.casefold()]
    else:
        raise ServiceValidationError("Give either entry_id or camera")
    if not found:
        raise ServiceValidationError("Camera not found or not loaded")
    return found[0].runtime_data


def _filename(hass: HomeAssistant, call: ServiceCall) -> Path:
    path = Path(call.data[ATTR_FILENAME])
    if not path.is_absolute() or not hass.config.is_allowed_path(str(path)):
        raise ServiceValidationError(f"Cannot write to {path}: add it to allowlist_external_dirs")
    return path


def _camera_local(value: str) -> datetime:
    """Parse a time; times with a time zone are converted to local time (the camera clock)."""
    parsed = dt_util.parse_datetime(value)
    if parsed is None:
        raise ServiceValidationError(f"Invalid start time: {value}")
    if parsed.tzinfo is not None:
        parsed = dt_util.as_local(parsed).replace(tzinfo=None)
    return parsed.replace(microsecond=0)


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


async def _async_save_event_image(hass: HomeAssistant, call: ServiceCall) -> ServiceResponse:
    camera = _camera(hass, call)
    path = _filename(hass, call)
    if camera.events is None:
        raise ServiceValidationError(f"{camera.name}: detection events are not configured")
    image = await camera.events.async_image(call.data[ATTR_EVENT_ID])
    if image is None:
        raise HomeAssistantError(f"{camera.name}: no image for this event")
    await hass.async_add_executor_job(_write, path, image)
    return {"filename": str(path), "size": len(image)}


async def _async_save_clip(hass: HomeAssistant, call: ServiceCall) -> ServiceResponse:
    camera = _camera(hass, call)
    path = _filename(hass, call)
    start = _camera_local(call.data[ATTR_START])
    duration = call.data[ATTR_DURATION]
    end = start + timedelta(seconds=duration)

    # The SD card can only give what it has already recorded.
    wait = (end - dt_util.now().replace(tzinfo=None)).total_seconds() + RECORDED_MARGIN
    if wait > MAX_DURATION:
        raise ServiceValidationError("The clip ends too far in the future")
    if wait > 0:
        await asyncio.sleep(wait)

    await hass.async_add_executor_job(lambda: path.parent.mkdir(parents=True, exist_ok=True))
    tmp = path.with_name(f".{path.name}.part")
    # Saving evidence wins over somebody watching: stop the panel playback, then keep the
    # camera's single SD session for ourselves.
    await camera.async_stop()
    async with camera._thumb_lock:  # noqa: SLF001
        process = await asyncio.create_subprocess_exec(
            get_ffmpeg_manager(hass).binary, "-hide_banner", "-loglevel", "error", "-y",
            "-rtsp_transport", "tcp", "-timeout", "8000000",
            "-fflags", "+genpts",
            "-i", camera.playback_url(start, end + timedelta(seconds=2)),
            "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-t", str(duration),
            "-movflags", "+faststart", "-f", "mp4", str(tmp),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(process.communicate(), duration + COPY_MARGIN)
        except TimeoutError as err:
            process.kill()
            await process.wait()
            await hass.async_add_executor_job(lambda: tmp.unlink(missing_ok=True))
            raise HomeAssistantError(f"{camera.name}: the SD card copy did not finish in time") from err

    size = await hass.async_add_executor_job(lambda: tmp.stat().st_size if tmp.exists() else 0)
    if process.returncode != 0 or size == 0:
        await hass.async_add_executor_job(lambda: tmp.unlink(missing_ok=True))
        detail = camera.redact(stderr.decode(errors="replace").strip())[:200]
        raise HomeAssistantError(f"{camera.name}: no recording from {camera_time(start)}: {detail}")
    await hass.async_add_executor_job(os.replace, tmp, path)
    _LOGGER.debug("%s: saved %s s from %s to %s", camera.name, duration, camera_time(start), path)
    return {"filename": str(path), "size": size, "start": start.isoformat(), "duration": duration}


def async_register_services(hass: HomeAssistant) -> None:
    """Register the services once for all cameras."""

    async def save_clip(call: ServiceCall) -> ServiceResponse:
        return await _async_save_clip(hass, call)

    async def save_event_image(call: ServiceCall) -> ServiceResponse:
        return await _async_save_event_image(hass, call)

    hass.services.async_register(
        DOMAIN, SERVICE_SAVE_CLIP, save_clip, schema=SAVE_CLIP_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SAVE_EVENT_IMAGE, save_event_image, schema=SAVE_EVENT_IMAGE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
