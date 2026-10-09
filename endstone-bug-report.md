Post at: https://github.com/EndstoneMC/endstone/issues/new

**Title:** Segfault (-11) in libendstone_runtime.so on startup, Docker, kernel 6.18

**Body:**

Endstone crashes immediately on startup, before plugins load. Vanilla BDS 1.26.52.3 (itzg/minecraft-bedrock-server) runs fine on the same host.

- Image: `endstone/endstone:latest` (0.11.13, BDS 1.26.52.3) and `endstone/endstone:0.11.12` (BDS 1.26.51.1). Both crash.
- Host: Unraid 7.x, kernel `6.18.38-Unraid`, Intel Core i7-8700
- Fresh empty `/data`, no plugins, default server.properties

Log:
```
[INFO]: Integrity check passed. Extracting to /data...
[INFO]: Added a rate limit for packet 115 to packetlimitconfig.json.
[ERROR]: Server exited with non-zero code -11.
```

dmesg (0.11.13), same offset every run:
```
Main[2154652]: segfault at 14b910557440 ip 000014b905c4a111 sp 00007ffc494354f0 error 4 in libendstone_runtime.so[84a111,14b9054eb000+76c000]
```

Also tried, all with the same crash:
- `--network host` and bridge mode with `-p 19132:19132/udp`
- `--security-opt seccomp=unconfined`
- `--privileged`
- `--ulimit nofile=1048576:1048576`
- data on an XFS/btrfs pool path instead of the FUSE share

Command:
```
docker run --rm -it --network host -v /mnt/cache/es-test:/data endstone/endstone:latest
```
