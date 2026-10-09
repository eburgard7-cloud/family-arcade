FROM python:3.13-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PUBLIC_DIR=/app/public \
    CONFIG_FILE=/config/config.json \
    STATE_FILE=/state/arcade.json \
    PORT=8080

WORKDIR /app
COPY server.py /app/server.py
COPY public /app/public

# Unprivileged user; the container only needs to read files and open a socket.
USER 65534:65534
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).status == 200 else 1)"

CMD ["python3", "/app/server.py"]
