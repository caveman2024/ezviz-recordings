# EZVIZ Recordings for Home Assistant

> Work in progress — not usable yet.

A Home Assistant custom integration with a sidebar panel to browse the recordings stored on the
SD card of EZVIZ cameras, locally over RTSP:

- mobile-first timeline with motion/person detections and alarm-armed periods;
- tap a point on the timeline to play the SD-card footage from that moment;
- jump to the previous/next person detection;
- nothing is recorded on the Home Assistant host: video is streamed from the camera only while you watch.

Tested so far only on EZVIZ C3TN (firmware V5.3.8). SD-card playback relies on an undocumented RTSP
endpoint that a firmware update could remove.
