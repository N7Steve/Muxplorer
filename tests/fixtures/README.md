# Synthetic disc fixture

`disc.zip` contains a generated `BDMV/` tree and the corresponding `bluray.iso`. It contains 125 seconds of black AVC video and silent stereo AC3 audio, with chapter marks. There is no third-party movie content, encryption, activation key, or executable in this fixture.

Generated on Linux with FFmpeg 5.1.9, tsMuxer 2.7.0 from its official `justdan96/tsMuxer` GitHub release, genisoimage, and 7-Zip 26.05:

```sh
ffmpeg -f lavfi -i color=black:size=1280x720:rate=24 -t 125 -pix_fmt yuv420p -c:v libx264 -preset ultrafast -f h264 long.264
ffmpeg -f lavfi -i anullsrc=r=48000:cl=stereo -t 125 -c:a ac3 long.ac3
```

The tsMuxer metadata file:

```text
MUXOPT --blu-ray --vbr --vbv-len=500 --auto-chapters=1
V_MPEG4/ISO/AVC, long.264, fps=24
A_AC3, long.ac3, lang=eng
```

```sh
tsMuxeR long.meta bluray
genisoimage -quiet -udf -o bluray.iso bluray
# Copy BDMV and bluray.iso into a fixture directory, then:
7zz a -tzip disc.zip BDMV bluray.iso
```

The Docker smoke test uses both engines from both sources and checks the mandatory review checkpoint and resulting MKV tracks. Each engine can identify a different set of streams; publication is checked against its actual reviewed tracks.
