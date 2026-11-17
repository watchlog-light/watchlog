# SPDX-License-Identifier: AGPL-3.0-only
# A Python worker run under supervisord in the Servers tests: wakes every second.
import time

while True:
    time.sleep(1)
