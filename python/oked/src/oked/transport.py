"""Small HTTP helper. One total deadline, not an idle timeout.

Heartbeats of whitespace while a person decides must not reset the wait.
A deadline that fires after the request started is a held timeout: the
caller turns that into decision "timeout", not an outage.
"""

from __future__ import annotations

import errno
import http.client
import socket
import time
from urllib.parse import urlsplit

# Connect failures the TypeScript client retries once (ECONNREFUSED, DNS, ETIMEDOUT).
_RETRIABLE_ERRNO = {
    errno.ECONNREFUSED,
    errno.ETIMEDOUT,
    errno.EHOSTUNREACH,
    errno.ENETUNREACH,
    getattr(errno, "EAI_AGAIN", -1),
    getattr(errno, "EAI_NONAME", -1),
}


class HeldTimeout(Exception):
    """The approval wait ended before a full reply arrived."""


class ConnectFailed(OSError):
    """A connect-time failure that may be retried once."""


def _remaining(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise HeldTimeout()
    return left


def request_bytes(
    method: str,
    url: str,
    body: bytes | None,
    headers: dict[str, str],
    timeout_s: float,
    *,
    deadline: float | None = None,
) -> tuple[int, dict[str, str], bytes]:
    """Perform one HTTP request. Raises HeldTimeout or ConnectFailed or OSError."""
    if deadline is None:
        deadline = time.monotonic() + timeout_s
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise OSError(f"unsupported URL {url}")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = path + "?" + parsed.query
    connection_cls = (
        http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    )
    try:
        connection = connection_cls(parsed.hostname, port, timeout=_remaining(deadline))
    except (socket.timeout, TimeoutError) as exc:
        raise HeldTimeout() from exc
    try:
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
        except (ConnectionRefusedError, socket.gaierror) as exc:
            raise ConnectFailed(str(exc)) from exc
        except (socket.timeout, TimeoutError) as exc:
            raise HeldTimeout() from exc
        except OSError as exc:
            if exc.errno in _RETRIABLE_ERRNO or isinstance(exc, ConnectionRefusedError):
                raise ConnectFailed(str(exc)) from exc
            raise
        chunks: list[bytes] = []
        while True:
            sock = connection.sock
            if sock is not None:
                try:
                    sock.settimeout(_remaining(deadline))
                except OSError as exc:
                    raise HeldTimeout() from exc
            try:
                data = response.read(65536)
            except (socket.timeout, TimeoutError) as exc:
                raise HeldTimeout() from exc
            if not data:
                break
            chunks.append(data)
        header_map = {key.lower(): value for key, value in response.getheaders()}
        return response.status, header_map, b"".join(chunks)
    finally:
        connection.close()


def request_with_retry(
    method: str,
    url: str,
    body: bytes | None,
    headers: dict[str, str],
    timeout_s: float,
) -> tuple[int, dict[str, str], bytes]:
    """Retry a connect failure once, after 200ms. A held timeout is not retried.

    Both attempts share one deadline, matching one AbortSignal on the fetch.
    """
    deadline = time.monotonic() + timeout_s
    try:
        return request_bytes(method, url, body, headers, timeout_s, deadline=deadline)
    except ConnectFailed:
        time.sleep(0.2)
        return request_bytes(method, url, body, headers, timeout_s, deadline=deadline)
