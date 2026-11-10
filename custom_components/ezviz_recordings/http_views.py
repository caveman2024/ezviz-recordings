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
        start = camera.start_for_token(token)
        if start is None:
            return web.Response(status=404)
        process = await camera.async_open_mp4(start)
        response = web.StreamResponse(headers={"Content-Type": "video/mp4", "Cache-Control": "no-store"})
        try:
            await response.prepare(request)
            assert process.stdout is not None
            while chunk := await process.stdout.read(CHUNK):
                await response.write(chunk)
        except ConnectionError:
            pass
        finally:
            await camera.async_close_mp4(process)
        return response
