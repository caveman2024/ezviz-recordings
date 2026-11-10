"""Event entity: one per camera, fired for every new detection."""

from __future__ import annotations

from typing import Any

from homeassistant.components.event import EventEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import DOMAIN, SIGNAL_DETECTION


async def async_setup_entry(hass: HomeAssistant, entry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    """Add the detection entity if this camera has an event source."""
    if entry.runtime_data.events is not None:
        async_add_entities([DetectionEvent(entry)])


class DetectionEvent(EventEntity):
    """Last detection of a camera (person / motion / other)."""

    _attr_has_entity_name = True
    _attr_translation_key = "detection"
    _attr_event_types = ["person", "motion", "other"]
    _attr_should_poll = False

    def __init__(self, entry) -> None:
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_detection"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.runtime_data.name,
            manufacturer="EZVIZ",
            model="SD-card recordings",
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, f"{SIGNAL_DETECTION}_{self._entry.entry_id}", self._handle)
        )

    @callback
    def _handle(self, detection: dict[str, Any]) -> None:
        self._trigger_event(detection["kind"], {k: v for k, v in detection.items() if k != "kind"})
        self.async_write_ha_state()
