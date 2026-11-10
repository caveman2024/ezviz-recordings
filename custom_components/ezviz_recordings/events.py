"""Detection events (EZVIZ cloud message list) and alarm-armed periods (Home Assistant history).

Events come from the same list the EZVIZ app shows. We reuse the cloud session of the
official EZVIZ integration (no second login) and keep a small local copy -- time, type and
title only -- so the timeline still shows events after the cloud forgets them.
"""

from __future__ import annotations

from collections import OrderedDict
from datetime import date, datetime, timedelta
import logging
import time
from typing import Any

from homeassistant.components.recorder import get_instance, history
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

EZVIZ_DOMAIN = "ezviz"
STORE_VERSION = 1
KEEP_DAYS = 60
TODAY_REFRESH = 60  # seconds between cloud refreshes of today's list
MAX_PAGES = 20
IMAGE_CACHE = 60

PERSON_WORDS = ("human", "person", "people", "body", "persona", "umana", "uman")
MOTION_WORDS = ("motion", "movimento", "pir", "intrusion", "line crossing", "region", "detection")
OFFLINE_SUBTYPES = {"2401"}


def classify(message: dict[str, Any]) -> str:
    """Map an EZVIZ message to person / motion / offline / other."""
    title = str(message.get("title") or "").lower()
    if str(message.get("subType")) in OFFLINE_SUBTYPES or "offline" in title:
        return "offline"
    if any(word in title for word in PERSON_WORDS):
        return "person"
    if any(word in title for word in MOTION_WORDS):
        return "motion"
    return "other"


def _ezviz_client(hass: HomeAssistant) -> Any | None:
    """The cloud client of the official EZVIZ integration, if loaded."""
    for entry in hass.config_entries.async_loaded_entries(EZVIZ_DOMAIN):
        client = getattr(getattr(entry, "runtime_data", None), "ezviz_client", None)
        if client is not None:
            return client
    return None


class EventSource:
    """Detection events of one camera, per (camera-local) day."""

    def __init__(self, hass: HomeAssistant, serial: str, encryption_key: str) -> None:
        self.hass = hass
        self.serial = serial
        self._key = encryption_key
        self._store: Store[dict[str, list[dict[str, Any]]]] = Store(
            hass, STORE_VERSION, f"{DOMAIN}.events.{serial}"
        )
        self._days: dict[str, list[dict[str, Any]]] | None = None
        self._fetched: dict[str, float] = {}
        self._pics: dict[str, str] = {}
        self._images: OrderedDict[str, bytes] = OrderedDict()

    async def _async_load(self) -> dict[str, list[dict[str, Any]]]:
        if self._days is None:
            self._days = await self._store.async_load() or {}
        return self._days

    async def async_day(self, day: date) -> list[dict[str, Any]]:
        """Events of one day, oldest first."""
        days = await self._async_load()
        key = day.isoformat()
        today = dt_util.now().date()
        fresh = self._fetched.get(key)
        need = fresh is None if day < today else fresh is None or time.monotonic() - fresh > TODAY_REFRESH
        if need and day <= today and (client := _ezviz_client(self.hass)) is not None:
            try:
                messages = await self.hass.async_add_executor_job(self._fetch_day, client, day)
            except Exception as err:  # noqa: BLE001 - cloud errors must not break the panel
                _LOGGER.debug("%s: cannot read events of %s: %s", self.serial, key, err)
            else:
                self._fetched[key] = time.monotonic()
                self._merge(key, messages)
        return days.get(key, [])

    async def async_new_events(self, day: date) -> list[dict[str, Any]]:
        """Fetch the day from the cloud now and return the events not seen before.

        The first fetch of a day only records what is there (no flood of old events after
        a restart), except events of the last couple of minutes.
        """
        days = await self._async_load()
        key = day.isoformat()
        client = _ezviz_client(self.hass)
        if client is None:
            return []
        had = key in days
        known = {event["id"] for event in days.get(key, [])}
        try:
            messages = await self.hass.async_add_executor_job(self._fetch_day, client, day)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("%s: cannot read events of %s: %s", self.serial, key, err)
            return []
        self._fetched[key] = time.monotonic()
        self._merge(key, messages)
        new = [event for event in self._days.get(key, []) if event["id"] not in known]
        recent = (dt_util.now().replace(tzinfo=None) - timedelta(minutes=10)).isoformat(timespec="seconds")
        if not had:
            recent = (dt_util.now().replace(tzinfo=None) - timedelta(minutes=2)).isoformat(timespec="seconds")
        # never announce old events as new
        return [event for event in new if event["time"] >= recent]

    def _fetch_day(self, client: Any, day: date) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        end_time = ""
        for _ in range(MAX_PAGES):
            page = client.get_device_messages_list(self.serial, limit=50, date=day, end_time=end_time)
            batch = page.get("message") or []
            messages.extend(batch)
            if not page.get("hasNext") or not batch:
                break
            end_time = str(batch[-1].get("msgId", ""))
        return messages

    def _merge(self, key: str, messages: list[dict[str, Any]]) -> None:
        assert self._days is not None
        known = {event["id"]: event for event in self._days.get(key, [])}
        for msg in messages:
            if str(msg.get("deviceSerial", self.serial)) != self.serial or not msg.get("timeStr"):
                continue
            event_id = str(msg.get("msgId") or msg["timeStr"])
            known[event_id] = {
                "id": event_id,
                "time": str(msg["timeStr"]).replace(" ", "T"),
                "kind": classify(msg),
                "title": msg.get("title") or "",
                "sub_type": str(msg.get("subType") or ""),
            }
            if pic := msg.get("defaultPic"):
                self._pics[event_id] = pic
        self._days[key] = sorted(known.values(), key=lambda event: event["time"])
        cutoff = (dt_util.now().date() - timedelta(days=KEEP_DAYS)).isoformat()
        for old in [day for day in self._days if day < cutoff]:
            del self._days[old]
        self._store.async_delay_save(lambda: self._days or {}, 10)

    async def async_image(self, event_id: str) -> bytes | None:
        """Decrypted snapshot of an event (only while the cloud still has it)."""
        if (cached := self._images.get(event_id)) is not None:
            return cached
        url = self._pics.get(event_id)
        client = _ezviz_client(self.hass)
        if not url or client is None:
            return None
        try:
            image = await self.hass.async_add_executor_job(
                lambda: client.download_alarm_image(url, self.serial, encryption_key=self._key)
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("%s: cannot download image %s: %s", self.serial, event_id, err)
            return None
        self._images[event_id] = image
        while len(self._images) > IMAGE_CACHE:
            self._images.popitem(last=False)
        return image


def _naive_local(value: datetime) -> str:
    return dt_util.as_local(value).replace(tzinfo=None, microsecond=0).isoformat()


async def async_armed_periods(hass: HomeAssistant, entity_id: str | None, day: date) -> list[list[str]]:
    """Periods of the given day in which the alarm entity was armed, as local times."""
    if not entity_id:
        return []
    start = dt_util.start_of_local_day(day)
    end = min(start + timedelta(days=1), dt_util.utcnow())
    if end <= start:
        return []
    changes = await get_instance(hass).async_add_executor_job(
        history.state_changes_during_period, hass, start, end, entity_id, True, False, None, True
    )
    periods: list[list[str]] = []
    opened: datetime | None = None
    for state in changes.get(entity_id, []):
        when = max(state.last_changed, start)
        armed = state.state.startswith("armed") or state.state == "triggered"
        if armed and opened is None:
            opened = when
        elif not armed and opened is not None:
            periods.append([_naive_local(opened), _naive_local(when)])
            opened = None
    if opened is not None:
        periods.append([_naive_local(opened), _naive_local(end)])
    return periods
