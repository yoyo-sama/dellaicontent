FROM python:3.14-alpine
RUN apk add --no-cache ffmpeg && pip install --no-cache-dir pillow==12.3.0
# A fresh named volume inherits the owner of its mount point: /data must belong to the user the service runs as.
ARG APP_UID=1000
ARG APP_GID=1000
RUN mkdir -p /data && chown "$APP_UID:$APP_GID" /data
COPY server.py /server.py
CMD ["python3", "/server.py"]
