# EZVIZ Recordings for Home Assistant

A Home Assistant custom integration that adds an **EZVIZ** panel to the sidebar to browse the recordings
stored on the **SD card** of EZVIZ cameras, locally over RTSP, plus detection events, notifications and
a local reachability check.

- **Mobile-first timeline**: drag, pinch or tap to pick a moment; person and motion detections and the
  periods your alarm was armed are drawn on it.
- **Plays the SD card from the chosen moment** in a few seconds (fragmented MP4 into Media Source,
  with HLS as a fallback), with sound on demand.
- Jump to the **previous/next person**, ±1 minute, a 14-day strip with detection counts, event cards with
  snapshots, and a button to go **live** (instant through the WebRTC card, when installed).
- **Detections as Home Assistant entities and events**, for notifications or an alarm panel such as Alarmo.
- **Nothing is recorded on the Home Assistant host**: video is streamed from the camera only while you
  watch.

> Tested on the EZVIZ **C3TN** (CS-C3TN-R100-1K3WKFL, firmware V5.3.8). SD-card playback relies on an
> RTSP endpoint that EZVIZ does not document: a firmware update could change it. Reports for other
> models are welcome in the issues.

## Requirements

- Home Assistant 2025.11 or newer.
- An EZVIZ camera with an SD card, reachable on the local network, with its **verification code**
  (the six-letter code on the label, or the one set in the EZVIZ app).
- Optional, recommended: the official **EZVIZ** integration (EZVIZ cloud account). Detection events and
  their snapshots come from the cloud message list it already reads; without it the panel still plays
  the SD card, but the timeline has no events.
- Optional: the [WebRTC Camera](https://github.com/AlexxIT/WebRTC) integration and card, for an instant
  live view. Without it the panel uses its own live view, a few seconds behind and without sound.

## Installation

**HACS**: *HACS → three dots → Custom repositories*, add `https://github.com/caveman2024/ezviz-recordings`
as an **Integration**, install **EZVIZ Recordings** and restart Home Assistant.

**Manual**: copy `custom_components/ezviz_recordings` into `config/custom_components/` and restart.

## Setup

*Settings → Devices & services → Add integration → EZVIZ Recordings*, once per camera:

- **Use a camera of the EZVIZ integration**: username, verification code and serial number are taken
  from the official integration; check the local IP address.
- **Enter address and verification code**: for cameras that are not in the EZVIZ integration.

The connection is tested before the camera is added. Address and code can be changed later with
*Reconfigure*.

**Options** (the gear of each camera):

| Option | What it does |
|---|---|
| Alarm | An `alarm_control_panel` entity: its armed periods are drawn on the timeline, and detections carry `armed: true` while it is armed. |
| Serial number | Needed to read the detection events through the EZVIZ integration. |
| The camera detects people only | Turn it on if the camera is set to human detection only: every detection then counts as a person. |

## What you get

**The EZVIZ panel** in the sidebar (`/ezviz-recordings`). It accepts `?camera=<name>&t=<YYYY-MM-DDTHH:MM:SS>`
to open a camera at a given moment, which is what the notification links use. Add `?debug` for on-screen
diagnostics.

**Entities per camera**

| Entity | |
|---|---|
| `event.<camera>_detection` | Event entity with types `person`, `motion`, `other`. |
| `binary_sensor.<camera>_person_detected` | On for 60 seconds after a person detection: long enough for an alarm panel to react. |
| `binary_sensor.<camera>_reachable` | Connectivity: the camera answers on its RTSP port on the local network (checked every minute, off after two failures). Works without internet. |

**Event `ezviz_recordings_detection`**, fired for every new detection:

```yaml
kind: person            # person, motion or other
camera: Garden          # camera name
entry_id: ...
event_id: ...
time: "2026-11-10T22:00:13"   # camera local time
title: Smart Detection Alarm  # title from the EZVIZ cloud
armed: true             # the alarm entity of the options was armed
image: /api/ezviz_recordings/event_image/<entry_id>/<event_id>   # snapshot, needs Home Assistant login
link: /ezviz-recordings?camera=Garden&t=2026-11-10T22:00:03       # panel, ten seconds earlier
```

Events are read every 10 seconds while the alarm entity is armed and every 5 minutes otherwise. They
reach Home Assistant through the EZVIZ cloud, so expect a delay of a few seconds to a minute.

## Blueprints

[![Import person blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fcaveman2024%2Fezviz-recordings%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fezviz_recordings%2Fperson_detected_notification.yaml)
**Notify on person detection**: a phone notification with the snapshot and a *Replay* button that opens
the panel on that moment; optionally only while armed, only for some cameras, or also for motion.

[![Import reachability blueprint](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2Fcaveman2024%2Fezviz-recordings%2Fblob%2Fmain%2Fblueprints%2Fautomation%2Fezviz_recordings%2Fcamera_unreachable_notification.yaml)
**Camera unreachable**: a notification when a camera has not answered on the local network for some
minutes, and again when it is back.

## Cameras on a dashboard

The panel needs no dashboard. To show a camera elsewhere, the official EZVIZ camera entity works in a
picture-entity card; with the WebRTC card:

```yaml
type: custom:webrtc-camera
entity: camera.garden   # the camera entity of the EZVIZ integration
```

Avoid putting `rtsp://admin:<code>@...` URLs in dashboards: the verification code would be stored in
clear text in the dashboard configuration.

## Limits

- **One SD-card playback per camera at a time**: the camera refuses a second session. Opening the same
  camera on two devices stops the first one.
- **Playback runs at normal speed**: the C3TN ignores fast-forward (`Scale`, `Speed`, `Rate-Control`),
  both on its RTSP playback and on ONVIF Replay, so there is no 2x/4x.
- Starting playback takes about 3 to 6 seconds: the camera has to find the moment on the card and send
  the next key frame.
- Event snapshots are kept by the EZVIZ cloud for a limited time; the event list itself is stored locally
  for 60 days.

## Privacy

Recordings travel only between the camera and Home Assistant on your network, and are never stored. The
cloud is used only for what the official EZVIZ integration already does (event list and snapshots). If
video encryption is on in the EZVIZ app, snapshots are decrypted locally with the verification code.

## License

MIT
