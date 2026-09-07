# Pi Hypr Agent Monitor

⚠️ **Important**: `PI_HYPR_MONITOR=1` is automatically set by the Noctalia plugin’s spawn command; it **must not be exported** from shell profiles or other processes, otherwise concurrent writers can overwrite each other. The extension enforces singleton ownership via process PID checks.