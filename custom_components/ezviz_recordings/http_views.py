"""HTTP view streaming SD-card recordings as fragmented MP4."""

from __future__ import annotations

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DOMAIN

CHUNK = 64 * 1024


class RecordingMp4View(HomeAssistantView):
    """Serve one playback as an endless fragmented MP4.

    Like Home Assistant's HLS URLs, the random token in the path is the credential: it is
    handed out over the authenticated websocket API and expires quickly.
    """

    url = "/api/ezviz_recordings/mp4/{entry_id}/{token}"
    name = "api:ezviz_recordings:mp4"
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request, entry_id: str, token: str) -> web.StreamResponse:
        entry = self.hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != DOMAIN or not hasattr(entry, "runtime_data"):
            return web.Response(status=404)
        camera = entry.runtime_data
        valid, start = camera.check_token(token)
        if not valid:
            return web.Response(status=404)
        process = await camera.async_open_mp4(start)
        response = web.StreamResponse(headers={"Content-Type": "video/mp4", "Cache-Control": "no-store"})
        try:
            await response.prepare(request)
            assert process.stdout is not None
            while chunk := await process.stdout.read(CHUNK):
                if request.transport is None or request.transport.is_closing():
                    break  # the viewer went away: free the camera at once
                await response.write(chunk)
        except ConnectionError:
            pass
        finally:
            await camera.async_close_mp4(process)
        return response


class EventImageView(HomeAssistantView):
    """Decrypted snapshot of a detection (for notifications and the panel). Requires login."""

    url = "/api/ezviz_recordings/event_image/{entry_id}/{event_id}"
    name = "api:ezviz_recordings:event_image"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request, entry_id: str, event_id: str) -> web.Response:
        entry = self.hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != DOMAIN or not hasattr(entry, "runtime_data"):
            return web.Response(status=404)
        events = entry.runtime_data.events
        image = await events.async_image(event_id) if events else None
        if image is None:
            return web.Response(status=404)
        return web.Response(body=image, content_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})
