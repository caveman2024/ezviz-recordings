"""SD-card playback and thumbnails for EZVIZ cameras over RTSP.

EZVIZ cameras built on Hikvision firmware expose the SD-card archive through the
undocumented endpoint ``/Streaming/tracks/101/?starttime=...&endtime=...``.
Notes from testing (C3TN, firmware V5.3.8):

* both ``starttime`` and ``endtime`` are required, and the slash before ``?`` matters;
* the timestamps carry a ``Z`` suffix but the camera reads them as its local time;
* footage is delivered in real time (no fast forward, ``Scale`` is ignored);
* the camera handles few RTSP sessions, so we keep one playback per camera.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import logging
from urllib.parse import quote

from homeassistant.components.camera import DynamicStreamSettings
from homeassistant.components.ffmpeg import get_ffmpeg_manager
from homeassistant.components.stream import Stream, create_stream
from homeassistant.components.stream.const import CONF_RTSP_TRANSPORT, HLS_PROVIDER
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from .const import (
    DEFAULT_RTSP_PORT,
    PLAYBACK_WINDOW_HOURS,
    THUMBNAIL_CACHE_SIZE,
    THUMBNAIL_TIMEOUT,
    THUMBNAIL_WIDTH,
)

_LOGGER = logging.getLogger(__name__)

_TIME_FORMAT = "%Y%m%dT%H%M%SZ"


def camera_time(value: datetime) -> str:
    """Format a camera-local wall-clock time the way the camera expects it."""
    return value.replace(tzinfo=None, microsecond=0).strftime(_TIME_FORMAT)


@dataclass
class RecordingCamera:
    """One camera configured for SD-card playback."""

    hass: HomeAssistant
    name: str
    host: str
    username: str
    password: str
    port: int = DEFAULT_RTSP_PORT
    _stream: Stream | None = field(default=None, init=False, repr=False)
    _thumb_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _thumbs: OrderedDict[str, bytes] = field(default_factory=OrderedDict, init=False, repr=False)

    def _base_url(self) -> str:
        user = quote(self.username, safe="")
        password = quote(self.password, safe="")
        return f"rtsp://{user}:{password}@{self.host}:{self.port}"

    def playback_url(self, start: datetime, end: datetime) -> str:
        """Return the RTSP URL that replays the SD card from start to end."""
        return (
            f"{self._base_url()}/Streaming/tracks/101/"
            f"?starttime={camera_time(start)}&endtime={camera_time(end)}"
        )

    def redact(self, text: str) -> str:
        """Remove the camera password from a message."""
        for secret in {self.password, quote(self.password, safe="")}:
            if secret:
                text = text.replace(secret, "***")
        return text

    async def async_play(self, start: datetime) -> str:
        """Start replaying from start and return the HLS playlist URL."""
        await self.async_stop()
        url = self.playback_url(start, start + timedelta(hours=PLAYBACK_WINDOW_HOURS))
        stream = create_stream(
            self.hass,
            url,
            {CONF_RTSP_TRANSPORT: "tcp"},
            DynamicStreamSettings(),
            stream_label=f"{self.name} SD",
        )
        stream.add_provider(HLS_PROVIDER)
        await stream.start()
        self._stream = stream
        _LOGGER.debug("%s: playback from %s", self.name, camera_time(start))
        return stream.endpoint_url(HLS_PROVIDER)

    async def async_stop(self) -> None:
        """Stop the current playback, if any."""
        if self._stream is not None:
            stream, self._stream = self._stream, None
            await stream.stop()

    async def async_thumbnail(self, at: datetime) -> bytes:
        """Return one JPEG frame of the recording at the given time."""
        key = camera_time(at)
        if (cached := self._thumbs.get(key)) is not None:
            self._thumbs.move_to_end(key)
            return cached
        async with self._thumb_lock:
            if (cached := self._thumbs.get(key)) is not None:
                return cached
            image = await self._grab_frame(at)
            self._thumbs[key] = image
            while len(self._thumbs) > THUMBNAIL_CACHE_SIZE:
                self._thumbs.popitem(last=False)
            return image

    async def _grab_frame(self, at: datetime) -> bytes:
        binary = get_ffmpeg_manager(self.hass).binary
        url = self.playback_url(at, at + timedelta(minutes=2))
        process = await asyncio.create_subprocess_exec(
            binary, "-v", "error", "-rtsp_transport", "tcp", "-timeout", "8000000",
            "-i", url, "-frames:v", "1", "-vf", f"scale={THUMBNAIL_WIDTH}:-2",
            "-f", "image2", "-c:v", "mjpeg", "pipe:1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), THUMBNAIL_TIMEOUT)
        except TimeoutError as err:
            process.kill()
            await process.wait()
            raise HomeAssistantError("timeout") from err
        if process.returncode != 0 or not stdout:
            _LOGGER.debug("%s: no frame at %s: %s", self.name, camera_time(at),
                          self.redact(stderr.decode(errors="replace").strip())[:200])
            raise HomeAssistantError("no_recording")
        return stdout
