#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Traffic from outside the cluster, for isolation-test.sh and the pod filter's cost (ADR-121).

  outsider.py serve PORT                  accept TCP connections and close them
  outsider.py load --tcp HOST:PORT --dns SERVER [--rate N] [--dns-rate N] [--duration S]
                                          connect and close N times a second, and send
                                          DNS queries (NXDOMAIN names) to SERVER:53;
                                          prints the connections made per second
"""
import argparse
import os
import socket
import struct
import sys
import threading
import time


def serve(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port))
    s.listen(4096)
    while True:
        c, _ = s.accept()
        c.close()


def dns_query(name):
    header = struct.pack(">HHHHHH", os.getpid() & 0xFFFF, 0x0100, 1, 0, 0, 0)
    q = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\0"
    return header + q + struct.pack(">HH", 1, 1)


def dns_loop(server, rate, until):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setblocking(False)
    i = 0
    while time.time() < until:
        try:
            s.sendto(dns_query(f"outsider-{i}.isolation.invalid"), (server, 53))
            while True:
                s.recv(512)
        except (BlockingIOError, OSError):
            pass
        i += 1
        time.sleep(1 / rate)


def load(tcp, dns, rate, dns_rate, duration):
    host, port = tcp.rsplit(":", 1)
    until = time.time() + duration
    if dns and dns_rate > 0:
        threading.Thread(target=dns_loop, args=(dns, dns_rate, until), daemon=True).start()
    made = 0
    start = time.time()
    while time.time() < until:
        t = time.time()
        try:
            c = socket.create_connection((host, int(port)), timeout=2)
            c.close()
            made += 1
        except OSError:
            pass
        # Paced to the rate; rate 0 is as fast as possible.
        if rate > 0:
            wait = 1 / rate - (time.time() - t)
            if wait > 0:
                time.sleep(wait)
    print(f"{made / (time.time() - start):.0f} connections/s", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("serve")
    sp.add_argument("port", type=int)
    lp = sub.add_parser("load")
    lp.add_argument("--tcp", required=True)
    lp.add_argument("--dns", default="")
    lp.add_argument("--rate", type=float, default=50)
    lp.add_argument("--dns-rate", type=float, default=10)
    lp.add_argument("--duration", type=float, default=600)
    args = ap.parse_args()
    if args.cmd == "serve":
        serve(args.port)
    else:
        load(args.tcp, args.dns, args.rate, args.dns_rate, args.duration)
    return 0


if __name__ == "__main__":
    sys.exit(main())
