# SSE relay server — bridges Redis Streams to per-session SSE endpoints for the in-browser client.
# Build: docker build -t sse-relay-relay:v1 .
FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
EXPOSE 8001
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
