#!/bin/sh
set -e
sed -e "s|PUBLISH_PASS|${MTX_PUBLISH_PASS}|g" -e "s|API_PASS|${MTX_API_PASS}|g" /mediamtx.yml.template > /tmp/mediamtx.yml
exec /usr/local/bin/mediamtx /tmp/mediamtx.yml
