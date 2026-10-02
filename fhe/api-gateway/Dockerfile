FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/tmp

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini .
COPY gunicorn.conf.py .
COPY reconcile_main.py .
COPY worker_main.py .
COPY docker-entrypoint.sh .
COPY migrations/ migrations/
COPY app/ app/

# Create non-root user
RUN groupadd -g 10001 siphon && \
    useradd -u 10001 -g siphon -s /bin/bash siphon && \
    chmod +x /app/docker-entrypoint.sh && \
    chown -R siphon:siphon /app

USER siphon

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8000/v1/liveness || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["gunicorn", "-c", "gunicorn.conf.py", "app.main:app"]
