FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

RUN groupadd -r signer && useradd -r -g signer signer
USER signer

EXPOSE 5003
CMD ["gunicorn", "--bind", "0.0.0.0:5003", "--workers", "1", "--timeout", "120", "app:app"]
