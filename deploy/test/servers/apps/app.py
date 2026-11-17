# SPDX-License-Identifier: AGPL-3.0-only
# A WSGI app served by gunicorn in the Servers tests (:8094).
def app(environ, start_response):
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [b"gunicorn ok\n"]
