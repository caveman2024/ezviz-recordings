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
import secrets
import time
from urllib.parse import quote

from homeassistant.components.camera import DynamicStreamSettings
from homeassistant.components.ffmpeg import get_ffmpeg_manager
from homeassistant.components.stream import Stream, create_stream
from homeassistant.components.stream.const import CONF_RTSP_TRANSPORT, HLS_PROVIDER
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from .events import EventSource
from .const import (
    DEFAULT_RTSP_PORT,
    MP4_TOKEN_TTL,
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
    events: EventSource | None = None
    alarm_entity: str | None = None
    _stream: Stream | None = field(default=None, init=False, repr=False)
    _thumb_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _thumbs: OrderedDict[str, bytes] = field(default_factory=OrderedDict, init=False, repr=False)
    _mp4_tokens: dict[str, tuple[datetime | None, float]] = field(default_factory=dict, init=False, repr=False)
    _mp4_process: asyncio.subprocess.Process | None = field(default=None, init=False, repr=False)

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
        # the camera rejects a second RTSP session while a thumbnail is being grabbed
        async with self._thumb_lock:
            return await self._async_start_stream(start)

    async def _async_start_stream(self, start: datetime) -> str:
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
        await self._async_kill_mp4()

    # --- low-latency path: fragmented MP4 over HTTP --------------------------------------
    # Home Assistant's HLS waits for a full (~8 s) segment before the first byte reaches the
    # browser. Here ffmpeg only remuxes and flushes 0.5 s fragments, so the picture shows up
    # as soon as the camera sends its first key frame. The session ends when the client
    # disconnects.

    def live_url(self) -> str:
        """Return the RTSP URL of the live main stream."""
        return f"{self._base_url()}/Streaming/Channels/101"

    def new_mp4_token(self, start: datetime | None) -> str:
        """Authorize one MP4 playback from start, or live when start is None.

        The URL is the credential, like Home Assistant's HLS URLs."""
        now = time.monotonic()
        self._mp4_tokens = {k: v for k, v in self._mp4_tokens.items() if v[1] > now}
        token = secrets.token_urlsafe(24)
        self._mp4_tokens[token] = (start, now + MP4_TOKEN_TTL)
        return token

    def check_token(self, token: str) -> tuple[bool, datetime | None]:
        """Return (valid, start) for a token; start is None for live."""
        item = self._mp4_tokens.get(token)
        if item is None or item[1] < time.monotonic():
            return False, None
        return True, item[0]

    async def async_open_mp4(self, start: datetime | None) -> asyncio.subprocess.Process:
        """Start ffmpeg remuxing the SD recording (or the live stream) to fragmented MP4."""
        if self._stream is not None:
            stream, self._stream = self._stream, None
            await stream.stop()
        await self._async_kill_mp4()
        async with self._thumb_lock:
            if start is None:
                # live: video only. The live audio track carries timestamps that make ffmpeg drop
                # the video; the picture starts at the next key frame (GOP ~4 s).
                source = ["-i", self.live_url(), "-map", "0:v:0"]
            else:
                url = self.playback_url(start, start + timedelta(hours=PLAYBACK_WINDOW_HOURS))
                # no "-fflags nobuffer": it drops the packets read while probing, and the first
                # key frame of the playback is among them (the next one is a GOP, ~4 s, later)
                source = ["-fflags", "+genpts", "-i", url, "-map", "0:v:0", "-map", "0:a:0?"]
            process = await asyncio.create_subprocess_exec(
                get_ffmpeg_manager(self.hass).binary, "-hide_banner", "-loglevel", "error",
                "-rtsp_transport", "tcp", "-timeout", "8000000",
                "-probesize", "32768", "-analyzeduration", "200000",
                *source, "-c", "copy", "-max_interleave_delta", "0",
                "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "-frag_duration", "500000", "-flush_packets", "1", "pipe:1",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        self._mp4_process = process
        _LOGGER.debug("%s: mp4 %s", self.name, "live" if start is None else camera_time(start))
        return process

    async def async_close_mp4(self, process: asyncio.subprocess.Process) -> None:
        """Stop one ffmpeg process (if it is still the current one, forget it)."""
        if process.returncode is None:
            process.kill()
            await process.wait()
        if self._mp4_process is process:
            self._mp4_process = None

    async def _async_kill_mp4(self) -> None:
        if self._mp4_process is not None:
            await self.async_close_mp4(self._mp4_process)

    async def async_thumbnail(self, at: datetime) -> bytes:
        """Return one JPEG frame of the recording at the given time."""
        key = camera_time(at)
        if (cached := self._thumbs.get(key)) is not None:
            self._thumbs.move_to_end(key)
            return cached
        if self._stream is not None or self._mp4_process is not None:
            raise HomeAssistantError("busy")  # one RTSP session per camera
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
