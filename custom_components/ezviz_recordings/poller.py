"""Background collection of detection events.

The EZVIZ cloud keeps its message list only for a while, so events are fetched
continuously (every 30 s while the alarm entity is armed, every 5 min otherwise) and kept
in the local store. Each new detection fires the Home Assistant event
``ezviz_recordings_detection`` and the camera's event entity, so automations can notify.
"""

from __future__ import annotations

from datetime import datetime, timedelta
import logging
import time
from typing import Any
from urllib.parse import quote

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from .const import DOMAIN, EVENT_DETECTION, PANEL_URL_PATH, SIGNAL_DETECTION

_LOGGER = logging.getLogger(__name__)

TICK = timedelta(seconds=30)
IDLE_INTERVAL = 300


class DetectionPoller:
    """Polls the event sources of all cameras."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._last: dict[str, float] = {}
        self._busy = False
        self._unsub = async_track_time_interval(hass, self._async_tick, TICK)

    @callback
    def async_stop(self) -> None:
        self._unsub()

    def _armed(self, entity_id: str | None) -> bool:
        state = self.hass.states.get(entity_id) if entity_id else None
        return bool(state and (state.state.startswith("armed") or state.state in ("triggered", "pending", "arming")))

    async def _async_tick(self, _now: Any = None) -> None:
        if self._busy:
            return
        self._busy = True
        try:
            for entry in self.hass.config_entries.async_loaded_entries(DOMAIN):
                camera = entry.runtime_data
                if camera.events is None:
                    continue
                armed = self._armed(camera.alarm_entity)
                last = self._last.get(entry.entry_id, 0)
                if not armed and time.monotonic() - last < IDLE_INTERVAL:
                    continue
                self._last[entry.entry_id] = time.monotonic()
                await self._async_poll(entry, armed)
        finally:
            self._busy = False

    async def _async_poll(self, entry, armed: bool) -> None:
        camera = entry.runtime_data
        now = dt_util.now()
        days = [now.date()]
        if now.hour == 0 and now.minute < 15:
            days.insert(0, now.date() - timedelta(days=1))
        for day in days:
            for event in await camera.events.async_new_events(day):
                if event["kind"] == "offline":
                    continue
                start = event["time"]
                replay_from = (datetime.fromisoformat(start) - timedelta(seconds=10)).isoformat()
                detection = {
                    "kind": event["kind"],
                    "camera": camera.name,
                    "entry_id": entry.entry_id,
                    "event_id": event["id"],
                    "time": start,
                    "title": event["title"],
                    "armed": armed,
                    "image": f"/api/{DOMAIN}/event_image/{entry.entry_id}/{quote(event['id'], safe='')}",
                    "link": f"/{PANEL_URL_PATH}?camera={quote(camera.name)}&t={replay_from}",
                }
                _LOGGER.debug("%s: new %s at %s", camera.name, event["kind"], start)
                self.hass.bus.async_fire(EVENT_DETECTION, detection)
                async_dispatcher_send(self.hass, f"{SIGNAL_DETECTION}_{entry.entry_id}", detection)
