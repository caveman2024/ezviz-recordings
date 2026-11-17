"""Constants for EZVIZ Recordings."""

from __future__ import annotations

from datetime import timedelta

DOMAIN = "ezviz_recordings"
VERSION = "0.5.0"  # keep in sync with manifest.json

CONF_SERIAL = "serial"
EVENT_DETECTION = f"{DOMAIN}_detection"
SIGNAL_DETECTION = f"{DOMAIN}_detection_signal"
PERSON_HOLD = 60  # seconds the person sensor stays on
CONF_ALARM_ENTITY = "alarm_entity"
CONF_PEOPLE_ONLY = "people_only"
CONF_CLOUD_USERNAME = "cloud_username"
CONF_CLOUD_PASSWORD = "cloud_password"
CONF_CLOUD_URL = "cloud_url"
CONF_SMS_CODE = "sms_code"

# EZVIZ cloud regions (API hosts), as in the official EZVIZ integration
EU_URL = "apiieu.ezvizlife.com"
RUSSIA_URL = "apirus.ezvizru.com"
CLOUD_TIMEOUT = 25

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

# Reachability check (TCP connect to the RTSP port).
REACHABLE_INTERVAL = timedelta(seconds=60)
REACHABLE_TIMEOUT = 5
REACHABLE_FAILURES = 2
