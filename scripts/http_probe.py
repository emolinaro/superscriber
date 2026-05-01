#!/usr/bin/env python3
import sys
from urllib import error, request


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: http_probe.py <url>", file=sys.stderr)
        return 2

    try:
        with request.urlopen(sys.argv[1], timeout=5) as response:
            return 0 if 200 <= response.status < 300 else 1
    except (error.URLError, TimeoutError, ConnectionResetError):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
