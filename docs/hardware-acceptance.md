# USB MIDI hardware acceptance

Run this checklist in a current desktop Chromium browser with the intended USB instrument.

1. Import one MusicXML/MXL, one clean MIDI, and one expressive MIDI. Confirm exact vs simplified labels and review warnings.
2. Grant MIDI permission, select the instrument, play central C, then four even taps. Confirm notes, velocity, jitter indicator, and duplicate count. Treat this only as input health—not latency calibration.
3. Complete import → recording → diagnosis → exercise → retry → comparison.
4. During recording, unplug the USB cable. Confirm the cursor freezes, recorded events remain, and reconnect / submit-current / discard are all usable.
5. Refresh during a second capture. Confirm IndexedDB recovery offers the preserved notes.
6. Disable the network during capture and restore it. Confirm the same event-batch IDs retry without duplicate analysis events.
7. Deny audio playback. Confirm recording and final diagnosis still work without a dead end.
8. In flexible accompaniment, deliberately lose the score position. Confirm tempo freezes below confidence 0.60 and changes only at measure boundaries after re-lock.

Record the browser version, instrument model, connection adapter, piece/range, and any cursor jump over two beats. The controlled script passes when such jumps occur no more than once per minute.
