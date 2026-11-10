"""Constants for EZVIZ Recordings."""

from __future__ import annotations

DOMAIN = "ezviz_recordings"
VERSION = "0.4.0"  # keep in sync with manifest.json

CONF_SERIAL = "serial"
EVENT_DETECTION = f"{DOMAIN}_detection"
SIGNAL_DETECTION = f"{DOMAIN}_detection_signal"
PERSON_HOLD = 60  # seconds the person sensor stays on
CONF_ALARM_ENTITY = "alarm_entity"

DEFAULT_USERNAME = "admin"
DEFAULT_RTSP_PORT = 554

PANEL_URL_PATH = "ezviz-recordings"
PANEL_COMPONENT = "ezviz-recordings-panel"
PANEL_ICON = "mdi:cctv"
STATIC_URL = "/ezviz_recordings_static"

# How much footage a single playback session requests. The stream stops by
# itself when nobody watches it (Home Assistant HLS idle timeout).
PLAYBACK_WINDOW_HOURS = 2

MP4_TOKEN_TTL = 120  # seconds a playback URL stays valid

THUMBNAIL_CACHE_SIZE = 120
THUMBNAIL_TIMEOUT = 25
THUMBNAIL_WIDTH = 640
