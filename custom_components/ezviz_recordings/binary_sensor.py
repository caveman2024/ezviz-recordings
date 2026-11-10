"""Binary sensors per camera.

* Person detected: on for a while after a person is detected. Detections reach Home Assistant
  through the cloud message list, so a short pulse would be easy to miss; the sensor stays on
  for PERSON_HOLD seconds, long enough for alarm panels (e.g. Alarmo) to react.
* Reachable: the camera accepts connections on its RTSP port on the local network. It works
  without internet, unlike the offline notice of the EZVIZ cloud.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.event import async_call_later, async_track_time_interval

from .const import DOMAIN, PERSON_HOLD, REACHABLE_FAILURES, REACHABLE_INTERVAL, REACHABLE_TIMEOUT, SIGNAL_DETECTION


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    """Add the reachability sensor, and the person sensor if this camera has an event source."""
    entities: list[BinarySensorEntity] = [Reachable(entry)]
    if entry.runtime_data.events is not None:
        entities.append(PersonDetected(entry))
    async_add_entities(entities)


async def _port_open(host: str, port: int) -> bool:
    try:
        _reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), REACHABLE_TIMEOUT)
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass
    return True


class Reachable(BinarySensorEntity):
    """The camera answers on the local network (TCP connect to the RTSP port, nothing else)."""

    _attr_has_entity_name = True
    _attr_translation_key = "reachable"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_should_poll = False

    def __init__(self, entry) -> None:
        self._camera = entry.runtime_data
        self._failures = 0
        self._attr_unique_id = f"{entry.entry_id}_reachable"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, entry.entry_id)}, name=self._camera.name)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_track_time_interval(self.hass, self._async_check, REACHABLE_INTERVAL))
        await self._async_check()

    async def _async_check(self, _now: datetime | None = None) -> None:
        if await _port_open(self._camera.host, self._camera.port):
            self._failures = 0
            is_on = True
        else:
            # A single lost connection attempt is not an outage.
            self._failures += 1
            is_on = False if self._failures >= REACHABLE_FAILURES else self._attr_is_on
        if is_on != self._attr_is_on or self._attr_is_on is None:
            self._attr_is_on = is_on
            self.async_write_ha_state()


class PersonDetected(BinarySensorEntity):
    """A person was detected in the last PERSON_HOLD seconds."""

    _attr_has_entity_name = True
    _attr_translation_key = "person"
    _attr_device_class = BinarySensorDeviceClass.MOTION
    _attr_should_poll = False
    _attr_is_on = False

    def __init__(self, entry) -> None:
        self._entry = entry
        self._cancel = None
        self._attr_unique_id = f"{entry.entry_id}_person"
        self._attr_extra_state_attributes: dict[str, Any] = {}
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, entry.entry_id)}, name=entry.runtime_data.name)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, f"{SIGNAL_DETECTION}_{self._entry.entry_id}", self._handle)
        )
        self.async_on_remove(self._cancel_timer)

    @callback
    def _cancel_timer(self) -> None:
        if self._cancel:
            self._cancel()
            self._cancel = None

    @callback
    def _handle(self, detection: dict[str, Any]) -> None:
        if detection["kind"] != "person":
            return
        self._cancel_timer()
        self._attr_is_on = True
        self._attr_extra_state_attributes = {
            "detected_at": detection["time"],
            "image": detection["image"],
            "link": detection["link"],
        }
        self.async_write_ha_state()
        self._cancel = async_call_later(self.hass, PERSON_HOLD, self._turn_off)

    @callback
    def _turn_off(self, _now: datetime) -> None:
        self._cancel = None
        self._attr_is_on = False
        self.async_write_ha_state()
