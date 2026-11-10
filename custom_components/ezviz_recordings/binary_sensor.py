"""Binary sensor per camera: on for a while after a person is detected.

Detections reach Home Assistant through the cloud message list, so a short pulse would be
easy to miss; the sensor stays on for PERSON_HOLD seconds, long enough for alarm panels
(e.g. Alarmo) to react.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.event import async_call_later

from .const import DOMAIN, PERSON_HOLD, SIGNAL_DETECTION


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    """Add the person sensor if this camera has an event source."""
    if entry.runtime_data.events is not None:
        async_add_entities([PersonDetected(entry)])


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
