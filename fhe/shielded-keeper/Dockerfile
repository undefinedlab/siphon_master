FROM python:3.12-slim
# node is required: circomlibjs is the ONLY accepted Poseidon backend (a mismatched hash mints
# unspendable notes), and the keeper refuses to start without it.
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN npm install circomlibjs@0.1.7
ENV KEEPER_CIRCOMLIBJS=/app/node_modules/circomlibjs
COPY . .
EXPOSE 5020
CMD ["python", "app.py"]
