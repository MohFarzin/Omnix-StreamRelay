FROM bluenviron/mediamtx:1.11.3 AS mtx
FROM alpine:3.20
RUN apk add --no-cache wget ca-certificates
COPY --from=mtx /mediamtx /usr/local/bin/mediamtx
COPY mediamtx.yml /mediamtx.yml.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 1935 8554 8890/udp 9997
ENTRYPOINT ["/entrypoint.sh"]
