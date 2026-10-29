# Kodi media flags

Bundled locally; no remote requests at runtime. Original artwork is unchanged.

- All audio codec icons: https://github.com/MikeSiLVO/skin.aeon.nox.silvo/tree/a612a2f42b4180026e47cd303406c80c4b89a333/media/flags/default/audiocodec
  License: CC BY-NC-SA 4.0, with exceptions recorded by the author (see LICENSE-Aeon-Nox-SiLVO.txt).
- All video codec icons: https://github.com/MikeSiLVO/skin.aeon.nox.silvo/tree/a612a2f42b4180026e47cd303406c80c4b89a333/media/flags/default/videocodec
  License: CC BY-NC-SA 4.0, with exceptions recorded by the author (see LICENSE-Aeon-Nox-SiLVO.txt).
- Country/language flags are provided by flag-icons (MIT), copied from the installed package at build time.

Codec badges use the per-track codec metadata, never the source filename or edited track name. Atmos/DTS:X require that profile to be reported by the inspection engine; a base TrueHD/DTS-HD report keeps its base badge.

Local filenames `mp2.png`, `mpeg2.png` and `vc1.png` correspond to upstream `MP2.png`, `mpeg2video.png` and `vc-1.png`. Codecs without artwork in this set use the generic track icon and retain their full codec name.
